import type { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureDirectory, getOpenMetaStateDir, parseGitHubRepoFullName } from '../infra/index.js';
import { logger } from '../infra/logger.js';
import type { GitHubIssue, GitHubIssueComment, IssueClaimAssessment, IssueClaimStatus } from '../types/index.js';

const FILTER_LABEL_GROUPS = [
  ['good first issue', 'good-first-issue'],
  ['help wanted', 'help-wanted'],
] as const;
const ACTION_BLOCKING_LABELS = [
  'blocked',
  'duplicate',
  'invalid',
  'needs info',
  'needs information',
  'question',
  'discussion',
  'wontfix',
  'claimed',
  'assigned',
  'in progress',
  'work in progress',
] as const;
const SEARCH_RESULTS_PER_PAGE = 30;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PAGINATION_RETRIES = 3;
const MAX_SEARCH_PAGES = 4;
const SEARCH_PAGE_PACING_DELAY_MS = 3_000;
const RATE_LIMIT_RETRY_FALLBACK_DELAY_MS = 10_000;
const MAX_ISSUES_PER_REPO = 3;
export const DEFAULT_MIN_REPO_STARS = 50;
const MAX_RECENT_ISSUE_COMMENTS = 5;
const CLAIM_LOOKBACK_DAYS = 180;

const SELF_CLAIM_PATTERNS = [
  /\bi(?:'d| would) like to (?:work on|take|handle|pick up) this\b/i,
  /\bcan i (?:work on|take|handle|pick up) this\b/i,
  /\bplease assign (?:this |the )?(?:issue )?to me\b/i,
  /\bi(?:'ll| will) (?:work on|take|handle|pick up) this\b/i,
  /\bi(?:'m| am) (?:currently )?working on this\b/i,
];
const MAINTAINER_CLAIM_PATTERNS = [
  /\bassign(?:ed|ing)? (?:this |the )?(?:issue )?to @?[a-z0-9-]+\b/i,
  /@[a-z0-9-]+[^\n]{0,80}\b(?:go ahead|you can (?:work on|take|handle) this)\b/i,
];
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

type SearchIssueItem = RestEndpointMethodTypes['search']['issuesAndPullRequests']['response']['data']['items'][number];

interface RepoIdentifier {
  owner: string;
  repo: string;
  fullName: string;
}

interface RepoMetadata {
  description: string;
  stars: number;
}

interface SearchFailure {
  labelGroup: readonly string[];
  reason: string;
  rateLimited: boolean;
}

interface IssueCachePayload {
  fetchedAt: string;
  issues: GitHubIssue[];
}

interface IssueDiscoveryOptions {
  refresh?: boolean;
  repoFullName?: string;
  onStatus?: (message: string) => void;
  techStack?: string[];
  minStars?: number;
  maxStars?: number;
}

export interface RepositoryStarRange {
  minStars: number;
  maxStars?: number;
}

export interface IssueClaimContext {
  recentComments: GitHubIssueComment[];
  claimAssessment: IssueClaimAssessment;
}

export interface RepositoryProbe {
  repoFullName: string;
  files: {
    packageJson?: string;
    pyprojectToml?: string;
    requirementsTxt?: string;
    cargoToml?: string;
    goMod?: string;
    dockerCompose?: string;
    dockerfile?: string;
    readme?: string;
    workflows: Array<{ path: string; content: string }>;
  };
  missingPaths: string[];
}

export class GitHubService {
  private octokit: Octokit | null = null;
  private username: string = '';

  initialize(pat: string, username: string): void {
    this.octokit = new Octokit({
      auth: pat,
      log: {
        debug: () => {},
        info: () => {},
        warn: (message, ...args) => logger.debug(`GitHub client: ${String(message)}`, ...args),
        error: (message, ...args) => logger.debug(`GitHub client: ${String(message)}`, ...args),
      },
    });
    this.username = username;
  }

  async validateCredentials(): Promise<boolean> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    try {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      logger.success(`GitHub authenticated as: ${data.login}`);
      return true;
    } catch (error) {
      logger.warn('GitHub token validation failed.');
      logger.debug('GitHub token validation failed', error);
      return false;
    }
  }

  async fetchTrendingIssues(options: IssueDiscoveryOptions = {}): Promise<GitHubIssue[]> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const repoFullName = options.repoFullName ? parseGitHubRepoFullName(options.repoFullName) : undefined;
    const starRange = this.resolveRepositoryStarRange(options.minStars, options.maxStars);

    if (!options.refresh) {
      const cachedIssues = this.loadCachedIssues(repoFullName);
      if (cachedIssues) {
        const filteredIssues = this.filterIssuesByStarRange(cachedIssues, starRange);
        logger.info(
          `Using cached GitHub issues (${filteredIssues.length}/${cachedIssues.length} in the requested star range) to avoid unnecessary Search API calls.`,
        );
        return filteredIssues;
      }
    } else {
      logger.info('Refreshing GitHub issue discovery and ignoring the local search cache.');
    }

    const issues: GitHubIssue[] = [];
    const seenIssueKeys = new Set<string>();
    const candidateItems: SearchIssueItem[] = [];
    const repoCache = new Map<string, RepoMetadata>();
    const repoIssueCounts = new Map<string, number>();
    const failures: SearchFailure[] = [];

    const collectCandidate = (item: SearchIssueItem): boolean => {
      if (!this.shouldIncludeIssue(item)) {
        return false;
      }

      const repoId = this.parseRepositoryUrl(item.repository_url);
      const issueKey = `${repoId.fullName}#${item.number}`;

      if (seenIssueKeys.has(issueKey)) {
        return false;
      }

      const repoCount = repoIssueCounts.get(repoId.fullName) ?? 0;
      if (repoCount >= MAX_ISSUES_PER_REPO) {
        return false;
      }

      seenIssueKeys.add(issueKey);
      repoIssueCounts.set(repoId.fullName, repoCount + 1);
      candidateItems.push(item);
      return true;
    };

    try {
      if (repoFullName) {
        try {
          const searchQuery = this.buildRepositorySearchQuery(repoFullName);
          options.onStatus?.(`Pulling open issue candidates for ${repoFullName}...`);
          const items = await this.paginateSearchWithRetry(searchQuery, [repoFullName], options.onStatus);

          logger.debug(`Search query: ${searchQuery}`);
          logger.debug(`Fetched ${items.length} total results for "${repoFullName}"`);

          for (const item of items) {
            collectCandidate(item);
          }
        } catch (error) {
          const failure = this.describeSearchFailure(error);
          failures.push({ labelGroup: [repoFullName], ...failure });
          logger.debug(`Issue search failed for repository "${repoFullName}". ${failure.reason}`);
          options.onStatus?.(
            'GitHub search is being stubborn, but OpenMeta is still pulling together the best issue set it can.',
          );
        }
      } else {
        const searchGroups: Array<{ query: string; label: string }> = [];

        for (const labelGroup of FILTER_LABEL_GROUPS) {
          searchGroups.push({
            query: this.buildSearchQuery(labelGroup),
            label: labelGroup.join(' / '),
          });
        }

        if (options.techStack && options.techStack.length > 0) {
          const techQuery = this.buildTechSearchQuery(options.techStack);
          if (techQuery) {
            searchGroups.push({
              query: techQuery,
              label: `${options.techStack.slice(0, 3).join(' / ')} (tech match)`,
            });
          }
        }

        for (const group of searchGroups) {
          try {
            options.onStatus?.(this.buildSearchStatusMessage([group.label]));
            const items = await this.paginateSearchWithRetry(group.query, [group.label], options.onStatus);

            logger.debug(`Search query: ${group.query}`);
            logger.debug(`Fetched ${items.length} total results for "${group.label}"`);

            for (const item of items) {
              collectCandidate(item);
            }
          } catch (error) {
            const failure = this.describeSearchFailure(error);
            failures.push({ labelGroup: [group.label], ...failure });
            logger.debug(`Issue search failed for "${group.label}". ${failure.reason}`);
            options.onStatus?.(
              'GitHub search is being stubborn, but OpenMeta is still pulling together the best issue set it can.',
            );
          }
        }
      }

      if (candidateItems.length === 0 && failures.length > 0) {
        throw new Error(this.buildDiscoveryFailureMessage(failures));
      }

      candidateItems.sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime());

      for (const item of candidateItems) {
        const repoId = this.parseRepositoryUrl(item.repository_url);
        const repoData = await this.fetchRepoMetadata(repoId, repoCache);

        issues.push({
          id: item.id,
          number: item.number,
          title: item.title,
          body: item.body || '',
          htmlUrl: item.html_url,
          repoName: repoId.repo,
          repoFullName: repoId.fullName,
          repoDescription: repoData.description,
          repoStars: repoData.stars,
          labels: this.extractLabelNames(item),
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GitHub issue discovery')) {
        throw error;
      }

      logger.debug('Failed to fetch trending issues', error);
      throw new Error('GitHub issue discovery failed. Please try again in a moment.');
    }

    this.saveCachedIssues(issues, repoFullName);
    const filteredIssues = this.filterIssuesByStarRange(issues, starRange);
    logger.success(
      repoFullName
        ? `Fetched ${filteredIssues.length} open issues from ${repoFullName} in the requested star range`
        : `Fetched ${filteredIssues.length} trending issues from ${FILTER_LABEL_GROUPS.length} label searches in the requested star range`,
    );
    return filteredIssues;
  }

  async fetchIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const normalizedRepo = parseGitHubRepoFullName(repoFullName);
    const [owner, repo] = normalizedRepo.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repository reference: ${repoFullName}`);
    }

    const response = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });
    const item = response.data as SearchIssueItem;

    if (!this.shouldIncludeIssue(item)) {
      throw new Error(
        `${normalizedRepo}#${issueNumber} cannot be handled automatically because it is a pull request, locked, assigned, or carries an action-blocking label.`,
      );
    }

    const repoId = this.parseRepositoryUrl(item.repository_url || `https://api.github.com/repos/${normalizedRepo}`);
    const repoData = await this.fetchRepoMetadata(repoId, new Map());

    return {
      id: item.id,
      number: item.number,
      title: item.title,
      body: item.body || '',
      htmlUrl: item.html_url,
      repoName: repoId.repo,
      repoFullName: repoId.fullName,
      repoDescription: repoData.description,
      repoStars: repoData.stars,
      labels: this.extractLabelNames(item),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    };
  }

  async fetchIssueClaimContext(repoFullName: string, issueNumber: number): Promise<IssueClaimContext> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const normalizedRepo = parseGitHubRepoFullName(repoFullName);
    const [owner, repo] = normalizedRepo.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repository reference: ${repoFullName}`);
    }

    const checkedAt = new Date().toISOString();
    try {
      const response = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 30,
        sort: 'created',
        direction: 'desc',
      });
      const comments = response.data.flatMap((comment): GitHubIssueComment[] => {
        const body = comment.body?.trim() ?? '';
        const author = comment.user?.login ?? '';
        if (!body || !author || comment.user?.type === 'Bot' || author.endsWith('[bot]')) {
          return [];
        }
        return [
          {
            author,
            authorAssociation: comment.author_association ?? 'NONE',
            body,
            createdAt: comment.created_at,
            htmlUrl: comment.html_url,
          },
        ];
      });
      const activeComments = comments.filter((comment) => this.isWithinClaimLookback(comment.createdAt, checkedAt));

      return {
        recentComments: activeComments.slice(0, MAX_RECENT_ISSUE_COMMENTS),
        claimAssessment: this.assessClaimSignals(activeComments, checkedAt),
      };
    } catch (error) {
      logger.debug(`Unable to load issue comments for ${normalizedRepo}#${issueNumber}`, error);
      return {
        recentComments: [],
        claimAssessment: { status: 'none', evidence: [], checkedAt },
      };
    }
  }

  async fetchRepositoryProbe(repoFullName: string): Promise<RepositoryProbe> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const normalizedRepo = parseGitHubRepoFullName(repoFullName);
    const [owner, repo] = normalizedRepo.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repository reference: ${repoFullName}`);
    }

    const missingPaths: string[] = [];
    const files: RepositoryProbe['files'] = {
      workflows: [],
    };
    const assignIfPresent = async (field: keyof Omit<RepositoryProbe['files'], 'workflows'>, paths: string[]) => {
      for (const path of paths) {
        const content = await this.fetchRepoTextFile(owner, repo, path);
        if (content !== null) {
          files[field] = content;
          return;
        }
      }
      missingPaths.push(...paths);
    };

    await Promise.all([
      assignIfPresent('packageJson', ['package.json']),
      assignIfPresent('pyprojectToml', ['pyproject.toml']),
      assignIfPresent('requirementsTxt', ['requirements.txt']),
      assignIfPresent('cargoToml', ['Cargo.toml']),
      assignIfPresent('goMod', ['go.mod']),
      assignIfPresent('dockerCompose', ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']),
      assignIfPresent('dockerfile', ['Dockerfile']),
      assignIfPresent('readme', ['README.md', 'readme.md', 'README.rst']),
    ]);

    files.workflows = await this.fetchWorkflowProbeFiles(owner, repo);

    return {
      repoFullName: normalizedRepo,
      files,
      missingPaths,
    };
  }

  async validateTargetRepo(path: string): Promise<boolean> {
    try {
      const { simpleGit } = await import('simple-git');
      const git = simpleGit(path);
      const remotes = await git.getRemotes();
      return remotes.length > 0;
    } catch {
      return false;
    }
  }

  getUsername(): string {
    return this.username;
  }

  resolveRepositoryStarRange(minStars?: number, maxStars?: number): RepositoryStarRange {
    const min = minStars ?? DEFAULT_MIN_REPO_STARS;
    if (!Number.isSafeInteger(min) || min < 0) {
      throw new Error('Minimum repository stars must be a non-negative integer.');
    }
    if (maxStars !== undefined && (!Number.isSafeInteger(maxStars) || maxStars < 0)) {
      throw new Error('Maximum repository stars must be a non-negative integer.');
    }
    if (maxStars !== undefined && maxStars < min) {
      throw new Error(`Maximum repository stars (${maxStars}) cannot be lower than minimum repository stars (${min}).`);
    }

    return maxStars === undefined ? { minStars: min } : { minStars: min, maxStars };
  }

  private filterIssuesByStarRange(issues: GitHubIssue[], range: RepositoryStarRange): GitHubIssue[] {
    return issues.filter(
      (issue) =>
        issue.repoStars >= range.minStars && (range.maxStars === undefined || issue.repoStars <= range.maxStars),
    );
  }

  private assessClaimSignals(comments: GitHubIssueComment[], checkedAt: string): IssueClaimAssessment {
    let status: IssueClaimStatus = 'none';
    const evidence: string[] = [];
    const checkedAtMs = new Date(checkedAt).getTime();

    for (const comment of comments) {
      const createdAtMs = new Date(comment.createdAt).getTime();
      const ageDays = Number.isFinite(createdAtMs) ? (checkedAtMs - createdAtMs) / (24 * 60 * 60 * 1000) : 0;

      const maintainerClaim =
        MAINTAINER_ASSOCIATIONS.has(comment.authorAssociation.toUpperCase()) &&
        MAINTAINER_CLAIM_PATTERNS.some((pattern) => pattern.test(comment.body));
      const selfClaim = SELF_CLAIM_PATTERNS.some((pattern) => pattern.test(comment.body));
      if (!maintainerClaim && !selfClaim) {
        continue;
      }

      const candidateStatus: IssueClaimStatus = maintainerClaim ? 'claimed' : ageDays <= 60 ? 'likely' : 'possible';
      if (this.claimStatusPriority(candidateStatus) > this.claimStatusPriority(status)) {
        status = candidateStatus;
      }
      evidence.push(`${comment.author}: ${comment.body.replace(/\s+/g, ' ').slice(0, 180)}`);
    }

    return { status, evidence: evidence.slice(0, 3), checkedAt };
  }

  private claimStatusPriority(status: IssueClaimStatus): number {
    return { none: 0, possible: 1, likely: 2, claimed: 3 }[status];
  }

  private isWithinClaimLookback(createdAt: string, checkedAt: string): boolean {
    const createdAtMs = new Date(createdAt).getTime();
    const checkedAtMs = new Date(checkedAt).getTime();
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(checkedAtMs)) {
      return true;
    }
    const ageDays = (checkedAtMs - createdAtMs) / (24 * 60 * 60 * 1000);
    return ageDays <= CLAIM_LOOKBACK_DAYS;
  }

  private async fetchRepoTextFile(owner: string, repo: string, path: string): Promise<string | null> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    try {
      const response = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
      });
      const data = response.data;
      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
        return null;
      }

      return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, 20_000);
    } catch (error) {
      const err = error as { status?: number };
      if (err.status !== 404) {
        logger.debug(`Unable to fetch ${owner}/${repo}/${path} for repository probe`, error);
      }
      return null;
    }
  }

  private async fetchWorkflowProbeFiles(
    owner: string,
    repo: string,
  ): Promise<Array<{ path: string; content: string }>> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    try {
      const response = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: '.github/workflows',
      });
      const data = response.data;
      if (!Array.isArray(data)) {
        return [];
      }

      const workflowFiles = data.filter((item) => item.type === 'file' && /\.(ya?ml)$/i.test(item.name)).slice(0, 5);
      const loaded = await Promise.all(
        workflowFiles.map(async (item) => ({
          path: item.path,
          content: (await this.fetchRepoTextFile(owner, repo, item.path)) ?? '',
        })),
      );

      return loaded.filter((item) => item.content.trim().length > 0);
    } catch (error) {
      const err = error as { status?: number };
      if (err.status !== 404) {
        logger.debug(`Unable to fetch ${owner}/${repo}/.github/workflows for repository probe`, error);
      }
      return [];
    }
  }

  private buildSearchQuery(labels: readonly string[], repoFullName?: string): string {
    const joinedLabels = labels.map((label) => `label:"${label}"`).join(' OR ');
    const repoScope = repoFullName ? `repo:${repoFullName} ` : '';
    return `${repoScope}(${joinedLabels}) archived:false is:issue is:open no:assignee`;
  }

  private buildRepositorySearchQuery(repoFullName: string): string {
    return `repo:${repoFullName} archived:false is:issue is:open no:assignee`;
  }

  private buildTechSearchQuery(techTerms: string[]): string {
    const joinedLabels = FILTER_LABEL_GROUPS.flat()
      .map((label) => `label:"${label}"`)
      .join(' OR ');
    const joinedTech = techTerms
      .slice(0, 3)
      .map((term) =>
        term
          .toLowerCase()
          .replace(/[^a-z0-9+#]/g, ' ')
          .trim(),
      )
      .filter(Boolean)
      .join(' OR ');
    if (!joinedTech) {
      return '';
    }
    return `(${joinedLabels}) (${joinedTech}) archived:false is:issue is:open no:assignee`;
  }

  private shouldIncludeIssue(item: SearchIssueItem): boolean {
    if (item.pull_request) {
      return false;
    }

    if (item.locked) {
      return false;
    }

    if (item.assignee) {
      return false;
    }

    if ('assignees' in item && Array.isArray(item.assignees) && item.assignees.length > 0) {
      return false;
    }

    const labels = Array.isArray(item.labels) ? this.extractLabelNames(item) : [];
    return !this.hasActionBlockingLabel(labels);
  }

  private hasActionBlockingLabel(labels: string[]): boolean {
    const normalizedLabels = labels.map((label) => this.normalizeLabel(label));

    return normalizedLabels.some((label) =>
      ACTION_BLOCKING_LABELS.some(
        (blockedLabel) =>
          label === blockedLabel || label.endsWith(` ${blockedLabel}`) || label.includes(`${blockedLabel}:`),
      ),
    );
  }

  private normalizeLabel(label: string): string {
    return label.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private parseRepositoryUrl(repositoryUrl: string): RepoIdentifier {
    let owner: string | undefined;
    let repo: string | undefined;

    try {
      const parsed = new URL(repositoryUrl);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const reposIndex = segments.indexOf('repos');

      if (reposIndex >= 0) {
        owner = segments[reposIndex + 1];
        repo = segments[reposIndex + 2];
      } else {
        owner = segments.at(-2);
        repo = segments.at(-1);
      }
    } catch {
      const parts = repositoryUrl.split('/').filter(Boolean);
      owner = parts.at(-2);
      repo = parts.at(-1);
    }

    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repository URL: ${repositoryUrl}`);
    }

    return {
      owner,
      repo,
      fullName: `${owner}/${repo}`,
    };
  }

  private async fetchRepoMetadata(repoId: RepoIdentifier, cache: Map<string, RepoMetadata>): Promise<RepoMetadata> {
    const cached = cache.get(repoId.fullName);
    if (cached) {
      return cached;
    }

    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    try {
      const repoResponse = await this.octokit.rest.repos.get({
        owner: repoId.owner,
        repo: repoId.repo,
      });

      const metadata = {
        description: repoResponse.data.description ?? '',
        stars: repoResponse.data.stargazers_count ?? 0,
      };

      cache.set(repoId.fullName, metadata);
      return metadata;
    } catch (error) {
      logger.debug(`Unable to fetch repository metadata for ${repoId.fullName}`, error);

      const fallback = {
        description: '',
        stars: 0,
      };
      cache.set(repoId.fullName, fallback);
      return fallback;
    }
  }

  private extractLabelNames(item: SearchIssueItem): string[] {
    return item.labels
      .map((label) => {
        if (typeof label === 'string') {
          return label;
        }

        return label.name ?? '';
      })
      .filter(Boolean);
  }

  private describeSearchFailure(error: unknown): { reason: string; rateLimited: boolean } {
    const err = error as { status?: number; message?: string };

    if (err.status === 403) {
      return {
        reason: 'GitHub Search API returned 403. This usually means rate limiting or secondary throttling.',
        rateLimited: true,
      };
    }

    if (err.status === 422) {
      return {
        reason: 'GitHub Search API rejected the query.',
        rateLimited: false,
      };
    }

    return {
      reason: err.message || 'Unknown GitHub API error.',
      rateLimited: false,
    };
  }

  private async paginateSearchWithRetry(
    searchQuery: string,
    labelGroup: readonly string[],
    onStatus?: (message: string) => void,
  ): Promise<SearchIssueItem[]> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const items: SearchIssueItem[] = [];
    let attempt = 0;
    let pagesFetched = 0;
    let currentPage = 1;

    while (attempt < MAX_PAGINATION_RETRIES) {
      try {
        while (pagesFetched < MAX_SEARCH_PAGES) {
          if (pagesFetched > 0) {
            onStatus?.('Still pulling issue candidates...');
            await this.delay(SEARCH_PAGE_PACING_DELAY_MS);
          }

          const response = await this.octokit.rest.search.issuesAndPullRequests({
            q: searchQuery,
            sort: 'updated',
            order: 'desc',
            per_page: SEARCH_RESULTS_PER_PAGE,
            page: currentPage,
          });
          const pageItems: SearchIssueItem[] = Array.isArray(response.data.items)
            ? (response.data.items as SearchIssueItem[])
            : [];
          const totalCount = typeof response.data.total_count === 'number' ? response.data.total_count : 0;

          items.push(...pageItems);
          pagesFetched++;
          const hasMorePages = pageItems.length > 0 && totalCount > pagesFetched * SEARCH_RESULTS_PER_PAGE;

          if (pagesFetched >= MAX_SEARCH_PAGES) {
            logger.debug(`Reached page limit (${MAX_SEARCH_PAGES}). Stopping pagination.`);
            onStatus?.(`Captured the strongest issue candidates for ${labelGroup.join(' / ')}.`);
            return items;
          }

          if (!hasMorePages) {
            onStatus?.(`Finished pulling issue candidates for ${labelGroup.join(' / ')}.`);
            return items;
          }

          currentPage++;
        }
        return items;
      } catch (error) {
        attempt++;
        const err = error as { status?: number; headers?: Record<string, string> };
        const isRateLimit = err.status === 403 || err.status === 429;

        if (isRateLimit) {
          if (attempt < MAX_PAGINATION_RETRIES) {
            const resetHeader = err.headers?.['x-ratelimit-reset'];
            const retryAfterHeader = err.headers?.['retry-after'];

            // Short fallback when GitHub omits retry headers; still grows per attempt.
            let delayMs = RATE_LIMIT_RETRY_FALLBACK_DELAY_MS + RATE_LIMIT_RETRY_FALLBACK_DELAY_MS * (attempt - 1);

            const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : Number.NaN;
            if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
              delayMs = retryAfterSeconds * 1000 + 500;
            } else if (resetHeader) {
              const resetSeconds = parseInt(resetHeader, 10);
              if (Number.isFinite(resetSeconds)) {
                const resetTime = resetSeconds * 1000;
                const waitMs = resetTime - Date.now();
                if (waitMs > 0) {
                  delayMs = waitMs + 500; // Trust GitHub's reset time without arbitrary 60s math.min cap
                }
              }
            }

            logger.debug(
              `Rate limited during pagination (attempt ${attempt}/${MAX_PAGINATION_RETRIES}). Retrying in ${Math.round(delayMs / 1000)}s...`,
            );
            onStatus?.('GitHub is throttling search requests. Holding briefly and trying again...');
            await this.delay(delayMs);
            continue;
          } else if (items.length > 0) {
            // MAX_PAGINATION_RETRIES exhausted, but we have some data. Graceful return.
            logger.debug(`Pagination retries exhausted. Yielding ${items.length} items collected so far.`);
            onStatus?.(
              'GitHub kept throttling search requests, so OpenMeta is continuing with the strongest issues already collected.',
            );
            return items;
          }
        }

        throw error;
      }
    }

    throw new Error(`Pagination exhausted after ${MAX_PAGINATION_RETRIES} attempts`);
  }

  private buildSearchStatusMessage(labelGroup: readonly string[]): string {
    return `Pulling issue candidates for ${labelGroup.join(' / ')}...`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildDiscoveryFailureMessage(failures: SearchFailure[]): string {
    const rateLimited = failures.some((failure) => failure.rateLimited);

    if (rateLimited) {
      return 'GitHub issue discovery failed because the Search API is currently rate-limited. Wait a few minutes and retry, or reduce request frequency.';
    }

    return `GitHub issue discovery failed for all label groups: ${failures.map((failure) => failure.labelGroup.join('/')).join(', ')}.`;
  }

  private getCachePath(repoFullName?: string): string {
    const cacheFile = repoFullName ? `github-issues-${repoFullName.replace(/\//g, '__')}.json` : 'github-issues.json';
    return join(ensureDirectory(join(getOpenMetaStateDir(), 'cache')), cacheFile);
  }

  private loadCachedIssues(repoFullName?: string): GitHubIssue[] | null {
    const cachePath = this.getCachePath(repoFullName);
    if (!existsSync(cachePath)) {
      return null;
    }

    try {
      const payload = JSON.parse(readFileSync(cachePath, 'utf-8')) as Partial<IssueCachePayload>;
      if (!payload.fetchedAt || !Array.isArray(payload.issues)) {
        return null;
      }

      const ageMs = Date.now() - new Date(payload.fetchedAt).getTime();
      if (ageMs > SEARCH_CACHE_TTL_MS) {
        return null;
      }

      return payload.issues as GitHubIssue[];
    } catch (error) {
      logger.debug('Unable to read GitHub issue cache', error);
      return null;
    }
  }

  private saveCachedIssues(issues: GitHubIssue[], repoFullName?: string): void {
    try {
      const payload: IssueCachePayload = {
        fetchedAt: new Date().toISOString(),
        issues,
      };

      writeFileSync(this.getCachePath(repoFullName), JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error) {
      logger.debug('Unable to save GitHub issue cache', error);
    }
  }
}

export const githubService = new GitHubService();

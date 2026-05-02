import { Octokit } from '@octokit/rest';
import type { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { GitHubIssue } from '../types/index.js';
import { ensureDirectory, getOpenMetaStateDir } from '../infra/index.js';
import { logger } from '../infra/logger.js';

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
] as const;
const SEARCH_RESULTS_PER_PAGE = 30;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PAGINATION_RETRIES = 3;
const RATE_LIMIT_RETRY_BASE_DELAY_MS = 1000;

type SearchIssueItem =
  RestEndpointMethodTypes['search']['issuesAndPullRequests']['response']['data']['items'][number];

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
}

export class GitHubService {
  private octokit: Octokit | null = null;
  private username: string = '';

  initialize(pat: string, username: string): void {
    this.octokit = new Octokit({ auth: pat });
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

    if (!options.refresh) {
      const cachedIssues = this.loadCachedIssues();
      if (cachedIssues) {
        logger.info(`Using cached GitHub issues (${cachedIssues.length}) to avoid unnecessary Search API calls.`);
        return cachedIssues;
      }
    } else {
      logger.info('Refreshing GitHub issue discovery and ignoring the local search cache.');
    }

    const issues: GitHubIssue[] = [];
    const seenIssueKeys = new Set<string>();
    const candidateItems: SearchIssueItem[] = [];
    const repoCache = new Map<string, RepoMetadata>();
    const failures: SearchFailure[] = [];

    try {
      for (const labelGroup of FILTER_LABEL_GROUPS) {
        try {
          const searchQuery = this.buildSearchQuery(labelGroup);
          const items = await this.paginateSearchWithRetry(searchQuery);

          logger.debug(`Search query: ${searchQuery}`);
          logger.debug(`Fetched ${items.length} total results for "${labelGroup.join(' / ')}"`);

          for (const item of items) {
            if (!this.shouldIncludeIssue(item)) {
              continue;
            }

            const repoId = this.parseRepositoryUrl(item.repository_url);
            const issueKey = `${repoId.fullName}#${item.number}`;

            if (seenIssueKeys.has(issueKey)) {
              continue;
            }

            seenIssueKeys.add(issueKey);
            candidateItems.push(item);
          }
        } catch (error) {
          const failure = this.describeSearchFailure(error);
          failures.push({ labelGroup, ...failure });
          logger.warn(`Issue search failed for labels "${labelGroup.join('" / "')}". ${failure.reason}`);
        }
      }

      if (candidateItems.length === 0 && failures.length > 0) {
        throw new Error(this.buildDiscoveryFailureMessage(failures));
      }

      candidateItems.sort((left, right) =>
        new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
      );

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

      logger.success(`Fetched ${issues.length} trending issues from ${FILTER_LABEL_GROUPS.length} label searches`);
      this.saveCachedIssues(issues);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GitHub issue discovery')) {
        throw error;
      }

      logger.debug('Failed to fetch trending issues', error);
      throw new Error('GitHub issue discovery failed. Please try again in a moment.');
    }

    return issues;
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

  private buildSearchQuery(labels: readonly string[]): string {
    const joinedLabels = labels.map((label) => `label:"${label}"`).join(' OR ');
    return `(${joinedLabels}) archived:false is:issue is:open no:assignee`;
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

    return normalizedLabels.some((label) => ACTION_BLOCKING_LABELS.some((blockedLabel) =>
      label === blockedLabel ||
      label.endsWith(` ${blockedLabel}`) ||
      label.includes(`${blockedLabel}:`)
    ));
  }

  private normalizeLabel(label: string): string {
    return label
      .toLowerCase()
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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

  private async fetchRepoMetadata(
    repoId: RepoIdentifier,
    cache: Map<string, RepoMetadata>,
  ): Promise<RepoMetadata> {
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

  private async paginateSearchWithRetry(searchQuery: string): Promise<SearchIssueItem[]> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    let attempt = 0;
    while (attempt < MAX_PAGINATION_RETRIES) {
      try {
        const items: SearchIssueItem[] = [];
        for await (const response of this.octokit.paginate.iterator(
          this.octokit.rest.search.issuesAndPullRequests,
          {
            q: searchQuery,
            sort: 'updated',
            order: 'desc',
            per_page: SEARCH_RESULTS_PER_PAGE,
          },
        )) {
          items.push(...(response.data.items as SearchIssueItem[]));
        }
        return items;
      } catch (error) {
        attempt++;
        const err = error as { status?: number; headers?: Record<string, string> };
        const isRateLimit = err.status === 403 || err.status === 429;

        if (isRateLimit && attempt < MAX_PAGINATION_RETRIES) {
          const resetHeader = err.headers?.['x-ratelimit-reset'];
          let delayMs = RATE_LIMIT_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);

          if (resetHeader) {
            const resetTime = parseInt(resetHeader, 10) * 1000;
            const waitMs = resetTime - Date.now();
            if (waitMs > 0 && waitMs < 60_000) {
              delayMs = Math.min(waitMs + 500, 60_000);
            }
          }

          logger.warn(`Rate limited during pagination (attempt ${attempt}/${MAX_PAGINATION_RETRIES}). Retrying in ${Math.round(delayMs / 1000)}s...`);
          await this.delay(delayMs);
          continue;
        }

        throw error;
      }
    }

    throw new Error(`Pagination exhausted after ${MAX_PAGINATION_RETRIES} attempts`);
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

  private getCachePath(): string {
    return join(ensureDirectory(join(getOpenMetaStateDir(), 'cache')), 'github-issues.json');
  }

  private loadCachedIssues(): GitHubIssue[] | null {
    const cachePath = this.getCachePath();
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

  private saveCachedIssues(issues: GitHubIssue[]): void {
    try {
      const payload: IssueCachePayload = {
        fetchedAt: new Date().toISOString(),
        issues,
      };

      writeFileSync(this.getCachePath(), JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error) {
      logger.debug('Unable to save GitHub issue cache', error);
    }
  }
}

export const githubService = new GitHubService();

import { Octokit } from '@octokit/rest';
import type { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import type { GitHubIssue } from '../types/index.js';
import { logger } from '../infra/logger.js';

const FILTER_LABELS = ['good first issue', 'good-first-issue', 'help wanted', 'help-wanted'];
const SEARCH_RESULTS_PER_LABEL = 50;

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
      const err = error as { status?: number; message?: string };
      logger.error(`GitHub credential validation failed: ${err.status} - ${err.message}`);
      return false;
    }
  }

  async fetchTrendingIssues(): Promise<GitHubIssue[]> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const issues: GitHubIssue[] = [];
    const seenIssueKeys = new Set<string>();
    const candidateItems: SearchIssueItem[] = [];
    const repoCache = new Map<string, RepoMetadata>();

    try {
      for (const label of FILTER_LABELS) {
        const searchQuery = this.buildSearchQuery(label);
        const response = await this.octokit.rest.search.issuesAndPullRequests({
          q: searchQuery,
          sort: 'updated',
          order: 'desc',
          per_page: SEARCH_RESULTS_PER_LABEL,
        });

        logger.debug(`Search query: ${searchQuery}`);
        logger.debug(`Total results for "${label}": ${response.data.total_count}`);

        for (const item of response.data.items) {
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

      logger.success(`Fetched ${issues.length} trending issues from ${FILTER_LABELS.length} label searches`);
    } catch (error) {
      logger.error('Failed to fetch trending issues:', error);
      throw error;
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

  private buildSearchQuery(label: string): string {
    return `label:"${label}" archived:false is:issue is:open no:assignee`;
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

    return true;
  }

  private parseRepositoryUrl(repositoryUrl: string): RepoIdentifier {
    const parts = repositoryUrl.split('/');
    const owner = parts.at(-2);
    const repo = parts.at(-1);

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
}

export const githubService = new GitHubService();

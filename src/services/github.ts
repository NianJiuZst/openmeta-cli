import { Octokit } from '@octokit/rest';
import type { GitHubIssue, MatchedIssue } from '../types/index.js';
import { logger } from '../infra/logger.js';

const FILTER_LABELS = ['good first issue', 'help wanted', 'good-first-issue', 'help-wanted'];

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

    try {
      // Simple search - just try "good first issue" label first
      const searchQuery = 'label:"good first issue" is:issue is:open';
      const response = await this.octokit.rest.search.issuesAndPullRequests({
        q: searchQuery,
        sort: 'updated',
        per_page: 100,
      });

      logger.debug(`Search query: ${searchQuery}`);
      logger.debug(`Total results: ${response.data.total_count}`);

      for (const item of response.data.items) {
        if (item.pull_request) continue;
        if (item.locked) continue;
        if (item.assignee) continue;

        const repoFullName = item.repository_url.split('/').slice(-2).join('/');

        let repoData: { description?: string; stargazers_count?: number } = {};
        try {
          const repoResponse = await this.octokit.rest.repos.get({
            owner: item.repository_url.split('/').slice(-2)[0] || '',
            repo: item.repository_url.split('/').slice(-2)[1] || '',
          });
          repoData = {
            description: repoResponse.data.description ?? undefined,
            stargazers_count: repoResponse.data.stargazers_count ?? undefined,
          };
        } catch {
          // Skip repo data if unavailable
        }

        const issue: GitHubIssue = {
          id: item.id,
          number: item.number,
          title: item.title,
          body: item.body || '',
          htmlUrl: item.html_url,
          repoName: item.repository_url.split('/').pop() || '',
          repoFullName,
          repoDescription: repoData.description || '',
          repoStars: repoData.stargazers_count || 0,
          labels: item.labels.map(l => l.name).filter((name): name is string => name !== undefined),
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        };

        issues.push(issue);
      }

      logger.success(`Fetched ${issues.length} trending issues`);
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
}

export const githubService = new GitHubService();

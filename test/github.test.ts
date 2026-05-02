import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GitHubService } from '../src/services/github.js';
import { createMatchedIssue } from './helpers/factories.js';
import type { GitHubIssue } from '../src/types/index.js';

interface GitHubServiceInternals {
  octokit: {
    rest: {
      search: {
        issuesAndPullRequests: () => Promise<{ data: { total_count: number; items: unknown[] } }>;
      };
    };
    paginate: {
      iterator: (fn: unknown, params: unknown) => AsyncIterable<unknown>;
    };
  } | null;
  buildSearchQuery(labels: readonly string[]): string;
  shouldIncludeIssue(item: Record<string, unknown>): boolean;
  parseRepositoryUrl(repositoryUrl: string): { owner: string; repo: string; fullName: string };
  extractLabelNames(item: { labels: Array<string | { name?: string | null }> }): string[];
  describeSearchFailure(error: unknown): { reason: string; rateLimited: boolean };
  buildDiscoveryFailureMessage(failures: Array<{
    labelGroup: readonly string[];
    reason: string;
    rateLimited: boolean;
  }>): string;
  loadCachedIssues(): GitHubIssue[] | null;
  saveCachedIssues(issues: GitHubIssue[]): void;
  getCachePath(): string;
}

let tempRoot = '';

function createIsolatedDir(): string {
  return mkdtempSync(join(tmpdir(), 'openmeta-github-test-'));
}

function createIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  const issue = createMatchedIssue(overrides);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    htmlUrl: issue.htmlUrl,
    repoName: issue.repoName,
    repoFullName: issue.repoFullName,
    repoDescription: issue.repoDescription,
    repoStars: issue.repoStars,
    labels: issue.labels,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

describe('GitHubService internals', () => {
  beforeEach(() => {
    tempRoot = createIsolatedDir();
    process.env['OPENMETA_CONFIG_DIR'] = join(tempRoot, '.config', 'openmeta');
    process.env['OPENMETA_HOME'] = join(tempRoot, '.openmeta');
  });

  afterEach(() => {
    delete process.env['OPENMETA_CONFIG_DIR'];
    delete process.env['OPENMETA_HOME'];

    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  test('builds GitHub search queries with label groups and common filters', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;
    const query = service.buildSearchQuery(['good first issue', 'good-first-issue']);

    expect(query).toContain('label:"good first issue" OR label:"good-first-issue"');
    expect(query).toContain('archived:false');
    expect(query).toContain('is:issue');
    expect(query).toContain('no:assignee');
  });

  test('filters out pull requests, locked issues, and assigned issues', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;

    expect(service.shouldIncludeIssue({ pull_request: { url: 'https://example.com/pr' } })).toBe(false);
    expect(service.shouldIncludeIssue({ locked: true })).toBe(false);
    expect(service.shouldIncludeIssue({ assignee: { login: 'owner' } })).toBe(false);
    expect(service.shouldIncludeIssue({ assignees: [{ login: 'owner' }] })).toBe(false);
    expect(service.shouldIncludeIssue({ locked: false, assignees: [] })).toBe(true);
  });

  test('filters action-blocking issue labels before scoring', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;

    expect(service.shouldIncludeIssue({
      locked: false,
      assignees: [],
      labels: [{ name: 'needs info' }],
    })).toBe(false);

    expect(service.shouldIncludeIssue({
      locked: false,
      assignees: [],
      labels: [{ name: 'type: question' }],
    })).toBe(false);
  });

  test('parses repository URLs and rejects malformed URLs', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;

    expect(service.parseRepositoryUrl('https://api.github.com/repos/acme/demo')).toEqual({
      owner: 'acme',
      repo: 'demo',
      fullName: 'acme/demo',
    });
    expect(() => service.parseRepositoryUrl('https://api.github.com/repos/acme')).toThrow(
      'Invalid GitHub repository URL',
    );
  });

  test('extracts label names from both strings and GitHub label objects', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;
    const labels = service.extractLabelNames({
      labels: [
        'good first issue',
        { name: 'help wanted' },
        { name: null },
      ],
    });

    expect(labels).toEqual(['good first issue', 'help wanted']);
  });

  test('classifies search failures by rate limit and validation errors', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;

    expect(service.describeSearchFailure({ status: 403 })).toEqual({
      reason: 'GitHub Search API returned 403. This usually means rate limiting or secondary throttling.',
      rateLimited: true,
    });
    expect(service.describeSearchFailure({ status: 422 })).toEqual({
      reason: 'GitHub Search API rejected the query.',
      rateLimited: false,
    });
    expect(service.describeSearchFailure({ message: 'boom' })).toEqual({
      reason: 'boom',
      rateLimited: false,
    });
  });

  test('builds discovery failure messages for rate limiting and generic failures', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;

    expect(service.buildDiscoveryFailureMessage([
      {
        labelGroup: ['good first issue'],
        reason: 'rate limited',
        rateLimited: true,
      },
    ])).toContain('Search API is currently rate-limited');

    expect(service.buildDiscoveryFailureMessage([
      {
        labelGroup: ['good first issue', 'good-first-issue'],
        reason: 'query rejected',
        rateLimited: false,
      },
      {
        labelGroup: ['help wanted'],
        reason: 'query rejected',
        rateLimited: false,
      },
    ])).toContain('good first issue/good-first-issue, help wanted');
  });

  test('persists and reloads fresh issue cache entries', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;
    const issues = [createIssue()];

    service.saveCachedIssues(issues);
    const cachePath = service.getCachePath();
    const loaded = service.loadCachedIssues();

    expect(readFileSync(cachePath, 'utf-8')).toContain('"repoFullName": "acme/demo"');
    expect(loaded).toEqual(issues);
  });

  test('ignores stale or malformed cached issue payloads', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;
    const cachePath = service.getCachePath();

    writeFileSync(cachePath, JSON.stringify({
      fetchedAt: '2000-01-01T00:00:00.000Z',
      issues: [createIssue()],
    }), 'utf-8');
    expect(service.loadCachedIssues()).toBeNull();

    writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), issues: 'invalid' }), 'utf-8');
    expect(service.loadCachedIssues()).toBeNull();
  });

  test('can bypass the issue discovery cache when refresh is requested', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;
    let searchCalls = 0;

    internals.saveCachedIssues([createIssue()]);
    internals.octokit = {
      rest: {
        search: {
          issuesAndPullRequests: async () => {
            searchCalls += 1;
            return {
              data: {
                total_count: 0,
                items: [],
              },
            };
          },
        },
      },
      paginate: {
        iterator: async function* () {
          searchCalls += 1;
          yield {
            data: {
              total_count: 0,
              items: [],
            },
          };
        },
      },
    } as unknown as GitHubServiceInternals['octokit'];

    const cached = await service.fetchTrendingIssues();
    const refreshed = await service.fetchTrendingIssues({ refresh: true });

    expect(cached).toHaveLength(1);
    expect(refreshed).toEqual([]);
    expect(searchCalls).toBe(2);
  });
});

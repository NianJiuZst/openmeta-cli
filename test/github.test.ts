import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitHubService } from '../src/services/github.js';
import type { GitHubIssue } from '../src/types/index.js';
import { createMatchedIssue } from './helpers/factories.js';

interface GitHubServiceInternals {
  octokit: {
    rest: {
      issues: {
        get: (params: { owner: string; repo: string; issue_number: number }) => Promise<{ data: unknown }>;
        listComments: (params: {
          owner: string;
          repo: string;
          issue_number: number;
          per_page: number;
          sort: 'created';
          direction: 'desc';
        }) => Promise<{ data: unknown[] }>;
      };
      repos: {
        get: (params: {
          owner: string;
          repo: string;
        }) => Promise<{ data: { description?: string | null; stargazers_count?: number | null } }>;
      };
      search: {
        issuesAndPullRequests: (params?: {
          q?: string;
          page?: number;
        }) => Promise<{ data: { total_count: number; items: unknown[] } }>;
      };
    };
  } | null;
  buildSearchQuery(labels: readonly string[], repoFullName?: string): string;
  buildRepositorySearchQuery(repoFullName: string): string;
  shouldIncludeIssue(item: Record<string, unknown>): boolean;
  parseRepositoryUrl(repositoryUrl: string): { owner: string; repo: string; fullName: string };
  extractLabelNames(item: { labels: Array<string | { name?: string | null }> }): string[];
  describeSearchFailure(error: unknown): { reason: string; rateLimited: boolean };
  buildDiscoveryFailureMessage(
    failures: Array<{
      labelGroup: readonly string[];
      reason: string;
      rateLimited: boolean;
    }>,
  ): string;
  paginateSearchWithRetry(searchQuery: string): Promise<Array<{ id: number; number: number }>>;
  delay(ms: number): Promise<void>;
  loadCachedIssues(repoFullName?: string): GitHubIssue[] | null;
  saveCachedIssues(issues: GitHubIssue[], repoFullName?: string): void;
  getCachePath(repoFullName?: string): string;
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

function createSearchItem(id: number): { id: number; number: number } {
  return {
    id,
    number: id,
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

  test('builds repository-scoped GitHub search queries', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;
    const query = service.buildRepositorySearchQuery('vercel/next.js');

    expect(query).toContain('repo:vercel/next.js');
    expect(query).not.toContain('label:');
    expect(query).toContain('archived:false');
    expect(query).toContain('is:issue');
    expect(query).toContain('is:open');
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

    expect(
      service.shouldIncludeIssue({
        locked: false,
        assignees: [],
        labels: [{ name: 'needs info' }],
      }),
    ).toBe(false);

    expect(
      service.shouldIncludeIssue({
        locked: false,
        assignees: [],
        labels: [{ name: 'type: question' }],
      }),
    ).toBe(false);
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
      labels: ['good first issue', { name: 'help wanted' }, { name: null }],
    });

    expect(labels).toEqual(['good first issue', 'help wanted']);
  });

  test('fetches a single issue from a target repository', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;
    const observedIssueRequests: unknown[] = [];
    const observedRepoRequests: unknown[] = [];

    internals.octokit = {
      rest: {
        issues: {
          get: async (params: { owner: string; repo: string; issue_number: number }) => {
            observedIssueRequests.push(params);
            return {
              data: {
                id: 3014,
                number: 3014,
                title: 'bug(openai): codex_cli_only 未拦截 /v1/chat/completions 兼容入口',
                body: 'Steps to reproduce are listed here.',
                html_url: 'https://github.com/Wei-Shaw/sub2api/issues/3014',
                repository_url: 'https://api.github.com/repos/Wei-Shaw/sub2api',
                labels: [],
                created_at: '2026-06-03T00:00:00.000Z',
                updated_at: '2026-06-03T01:00:00.000Z',
                locked: false,
                assignees: [],
              },
            };
          },
        },
        repos: {
          get: async (params: { owner: string; repo: string }) => {
            observedRepoRequests.push(params);
            return {
              data: {
                description: 'Sub converter API',
                stargazers_count: 1234,
              },
            };
          },
        },
        search: {
          issuesAndPullRequests: async () => ({
            data: {
              total_count: 0,
              items: [],
            },
          }),
        },
      },
    } as unknown as GitHubServiceInternals['octokit'];

    const issue = await service.fetchIssue('https://github.com/Wei-Shaw/sub2api', 3014);

    expect(observedIssueRequests).toEqual([
      {
        owner: 'Wei-Shaw',
        repo: 'sub2api',
        issue_number: 3014,
      },
    ]);
    expect(observedRepoRequests).toEqual([
      {
        owner: 'Wei-Shaw',
        repo: 'sub2api',
      },
    ]);
    expect(issue).toMatchObject({
      number: 3014,
      repoFullName: 'Wei-Shaw/sub2api',
      repoName: 'sub2api',
      repoDescription: 'Sub converter API',
      repoStars: 1234,
    });
  });

  test('rejects pull requests and blocked single issue targets', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;

    internals.octokit = {
      rest: {
        issues: {
          get: async () => ({
            data: {
              id: 44,
              number: 44,
              title: 'Blocked target',
              body: '',
              html_url: 'https://github.com/acme/demo/issues/44',
              repository_url: 'https://api.github.com/repos/acme/demo',
              labels: [{ name: 'blocked' }],
              created_at: '2026-06-03T00:00:00.000Z',
              updated_at: '2026-06-03T01:00:00.000Z',
              locked: false,
              assignees: [],
            },
          }),
        },
        repos: {
          get: async () => ({ data: { description: '', stargazers_count: 0 } }),
        },
        search: {
          issuesAndPullRequests: async () => ({ data: { total_count: 0, items: [] } }),
        },
      },
    } as unknown as GitHubServiceInternals['octokit'];

    await expect(service.fetchIssue('acme/demo', 44)).rejects.toThrow('cannot be handled automatically');
  });

  test('extracts recent human claim signals from issue comments', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const stale = new Date(Date.now() - 250 * 24 * 60 * 60 * 1000).toISOString();

    internals.octokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              {
                body: 'Assigned this issue to @alice. Please go ahead.',
                user: { login: 'maintainer', type: 'User' },
                author_association: 'MEMBER',
                created_at: recent,
                html_url: 'https://github.com/acme/demo/issues/18#issuecomment-1',
              },
              {
                body: "I'd like to work on this.",
                user: { login: 'alice', type: 'User' },
                author_association: 'CONTRIBUTOR',
                created_at: recent,
                html_url: 'https://github.com/acme/demo/issues/18#issuecomment-2',
              },
              {
                body: "I'll work on this.",
                user: { login: 'old-contributor', type: 'User' },
                author_association: 'CONTRIBUTOR',
                created_at: stale,
                html_url: 'https://github.com/acme/demo/issues/18#issuecomment-3',
              },
              {
                body: "I'd like to work on this.",
                user: { login: 'triage-bot[bot]', type: 'Bot' },
                author_association: 'NONE',
                created_at: recent,
                html_url: 'https://github.com/acme/demo/issues/18#issuecomment-4',
              },
            ],
          }),
        },
      },
    } as unknown as GitHubServiceInternals['octokit'];

    const context = await service.fetchIssueClaimContext('acme/demo', 18);

    expect(context.claimAssessment.status).toBe('claimed');
    expect(context.claimAssessment.evidence).toHaveLength(2);
    expect(context.recentComments.map((comment) => comment.author)).not.toContain('triage-bot[bot]');
    expect(context.recentComments.map((comment) => comment.author)).not.toContain('old-contributor');
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

    expect(
      service.buildDiscoveryFailureMessage([
        {
          labelGroup: ['good first issue'],
          reason: 'rate limited',
          rateLimited: true,
        },
      ]),
    ).toContain('Search API is currently rate-limited');

    expect(
      service.buildDiscoveryFailureMessage([
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
      ]),
    ).toContain('good first issue/good-first-issue, help wanted');
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

  test('filters cached issues by a configurable inclusive repository star range', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;
    internals.saveCachedIssues([
      createIssue({ number: 1, repoStars: 10 }),
      createIssue({ number: 2, repoStars: 100 }),
      createIssue({ number: 3, repoStars: 1_000 }),
    ]);
    internals.octokit = { rest: {} } as unknown as GitHubServiceInternals['octokit'];

    const defaults = await service.fetchTrendingIssues();
    const bounded = await service.fetchTrendingIssues({ minStars: 100, maxStars: 500 });
    const broadened = await service.fetchTrendingIssues({ minStars: 0, maxStars: 20 });

    expect(defaults.map((issue) => issue.number)).toEqual([2, 3]);
    expect(bounded.map((issue) => issue.number)).toEqual([2]);
    expect(broadened.map((issue) => issue.number)).toEqual([1]);
  });

  test('rejects invalid repository star ranges', () => {
    const service = new GitHubService();

    expect(() => service.resolveRepositoryStarRange(-1, 10)).toThrow('non-negative integer');
    expect(() => service.resolveRepositoryStarRange(100, 99)).toThrow(
      'Maximum repository stars (99) cannot be lower than minimum repository stars (100).',
    );
  });

  test('ignores stale or malformed cached issue payloads', () => {
    const service = new GitHubService() as unknown as GitHubServiceInternals;
    const cachePath = service.getCachePath();

    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: '2000-01-01T00:00:00.000Z',
        issues: [createIssue()],
      }),
      'utf-8',
    );
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
    } as unknown as GitHubServiceInternals['octokit'];

    const cached = await service.fetchTrendingIssues();
    const refreshed = await service.fetchTrendingIssues({ refresh: true });

    expect(cached).toHaveLength(1);
    expect(refreshed).toEqual([]);
    expect(searchCalls).toBe(2);
  });

  test('keeps global and repository-scoped issue discovery caches separate', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;
    const queries: string[] = [];

    internals.saveCachedIssues([createIssue({ repoFullName: 'global/cache' })]);
    internals.octokit = {
      rest: {
        search: {
          issuesAndPullRequests: async (params?: { q?: string; page?: number }) => {
            queries.push(params?.q || '');
            return {
              data: {
                total_count: 0,
                items: [],
              },
            };
          },
        },
      },
    } as unknown as GitHubServiceInternals['octokit'];

    const repoIssues = await service.fetchTrendingIssues({ repoFullName: 'vercel/next.js' });

    expect(repoIssues).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries.every((query) => query.includes('repo:vercel/next.js'))).toBe(true);
    expect(queries.every((query) => !query.includes('label:'))).toBe(true);
  });

  test('falls back to the conservative delay when retry-after is invalid', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;
    const observedDelays: number[] = [];
    let callCount = 0;

    internals.octokit = {
      rest: {
        search: {
          issuesAndPullRequests: async () => {
            callCount += 1;
            throw { status: 403, headers: { 'retry-after': 'not-a-number' } };
          },
        },
      },
    } as unknown as GitHubServiceInternals['octokit'];

    internals.delay = async (ms: number) => {
      observedDelays.push(ms);
    };

    await expect(internals.paginateSearchWithRetry('label:"good first issue"')).rejects.toMatchObject({ status: 403 });
    expect(observedDelays).toEqual([10_000, 20_000]);
    expect(callCount).toBe(3);
  });

  test('resumes pagination from the next page after a rate limit error', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;
    const requestedPages: number[] = [];
    let failedOnce = false;

    internals.octokit = {
      rest: {
        search: {
          issuesAndPullRequests: async (params?: { page?: number }) => {
            const page = params?.page ?? 1;
            requestedPages.push(page);

            if (page === 3 && !failedOnce) {
              failedOnce = true;
              throw { status: 403, headers: { 'retry-after': '0' } };
            }

            return {
              data: {
                total_count: 120,
                items: [createSearchItem(page)],
              },
            };
          },
        },
      },
    } as unknown as GitHubServiceInternals['octokit'];

    internals.delay = async () => {};

    const items = await internals.paginateSearchWithRetry('label:"good first issue"');

    expect(requestedPages).toEqual([1, 2, 3, 3, 4]);
    expect(items.map((item) => item.id)).toEqual([1, 2, 3, 4]);
  });

  test('returns partial results when pagination retries are exhausted', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;
    const requestedPages: number[] = [];

    internals.octokit = {
      rest: {
        search: {
          issuesAndPullRequests: async (params?: { page?: number }) => {
            const page = params?.page ?? 1;
            requestedPages.push(page);

            if (page === 1) {
              return {
                data: {
                  total_count: 120,
                  items: [createSearchItem(1), createSearchItem(2)],
                },
              };
            }

            throw { status: 403, headers: { 'retry-after': '0' } };
          },
        },
      },
    } as unknown as GitHubServiceInternals['octokit'];

    internals.delay = async () => {};

    const items = await internals.paginateSearchWithRetry('label:"good first issue"');

    expect(requestedPages).toEqual([1, 2, 2, 2]);
    expect(items.map((item) => item.id)).toEqual([1, 2]);
  });

  test('stops pagination after reaching the configured page cap', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;
    let pagesYielded = 0;

    internals.octokit = {
      rest: {
        search: {
          issuesAndPullRequests: async (params?: { page?: number }) => {
            const page = params?.page ?? 1;
            pagesYielded++;
            return {
              data: {
                total_count: 300,
                items: [createSearchItem(page)],
              },
            };
          },
        },
      },
    } as unknown as GitHubServiceInternals['octokit'];

    internals.delay = async () => {};

    const items = await internals.paginateSearchWithRetry('label:"good first issue"');

    expect(pagesYielded).toBe(4);
    expect(items.map((item) => item.id)).toEqual([1, 2, 3, 4]);
  });

  test('paces successful pagination requests with a lightweight delay between pages', async () => {
    const service = new GitHubService();
    const internals = service as unknown as GitHubServiceInternals;
    const eventOrder: string[] = [];

    internals.octokit = {
      rest: {
        search: {
          issuesAndPullRequests: async (params?: { page?: number }) => {
            const page = params?.page ?? 1;
            eventOrder.push(`request:${page}`);
            return {
              data: {
                total_count: 90,
                items: [createSearchItem(page)],
              },
            };
          },
        },
      },
    } as unknown as GitHubServiceInternals['octokit'];

    internals.delay = async (ms: number) => {
      eventOrder.push(`delay:${ms}`);
    };

    const items = await internals.paginateSearchWithRetry('label:"good first issue"');

    expect(items.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(eventOrder).toEqual(['request:1', 'delay:3000', 'request:2', 'delay:3000', 'request:3']);
  });
});

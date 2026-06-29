import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ContributionPrService, contributionPrService, githubService } from '../src/services/index.js';
import { createPullRequestDraft, createRankedIssue, createRepositoryRules } from './helpers/factories.js';

interface ContributionPrInternals {
  initialize(octokit: unknown): void;
  submitDraftPullRequest(input: {
    issue: ReturnType<typeof createRankedIssue>;
    prDraft: ReturnType<typeof createPullRequestDraft>;
    workspacePath: string;
    changedFiles: string[];
    repositoryRules?: ReturnType<typeof createRepositoryRules>;
  }): Promise<{
    branchName: string;
    url: string;
    number: number;
  }>;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('ContributionPrService', () => {
  test('builds a real pull request payload from the structured draft', () => {
    const parsed = contributionPrService.buildDraftPullRequest(createPullRequestDraft());

    expect(parsed.title).toBe('Add aria-label handling to icon-only buttons');
    expect(parsed.body).toContain('## Summary');
    expect(parsed.body).not.toContain('Title:');
  });

  test('uses repository PR templates when building the pull request payload', () => {
    const parsed = contributionPrService.buildDraftPullRequest(
      createPullRequestDraft({
        summary: 'Tighten keyboard accessibility around dialogs.',
        changes: ['Update dialog focus trapping'],
        validation: ['bun test'],
      }),
      createRepositoryRules({
        prTemplateBody: '## Summary\n\n{{summary}}\n\n## Validation\n\n{{validation}}',
      }),
    );

    expect(parsed.body).toContain('Tighten keyboard accessibility around dialogs.');
    expect(parsed.body).toContain('- bun test');
    expect(parsed.body).toContain('## Changes');
  });

  test('preserves finalized repository rule sections in the pull request payload', () => {
    const parsed = contributionPrService.buildDraftPullRequest(
      createPullRequestDraft({
        body: [
          '## Summary',
          '',
          'Accessibility fix only.',
          '',
          '## Related Issue',
          '',
          '- Related issue: acme/demo#42',
          '- Link: https://github.com/acme/demo/issues/42',
          '',
          '## Release Notes',
          '',
          '- Accessibility fix only.',
        ].join('\n'),
      }),
      createRepositoryRules({
        requiredIssueLinking: 'Reference the GitHub issue in the PR body.',
        requiredReleaseNotes: true,
      }),
    );

    expect(parsed.body).toContain('## Related Issue');
    expect(parsed.body).toContain('acme/demo#42');
    expect(parsed.body).toContain('## Release Notes');
  });

  test('builds bounded branch names and commit messages for generated contribution PRs', () => {
    const issue = createRankedIssue({
      repoFullName: 'acme/widgets',
      number: 42,
      title: 'Fix keyboard focus in icon-only widgets with an intentionally long title',
    });

    const branchName = contributionPrService.buildPublishBranchName(
      issue,
      createRepositoryRules({ branchNamingRule: 'Use fix/... branch names for bug fixes.' }),
    );
    const commitMessage = contributionPrService.buildContributionCommitMessage(
      issue,
      createRepositoryRules({ commitMessageRule: 'Use fix: for bug-fix commits.' }),
    );

    expect(branchName).toMatch(/^fix\/42-fix-keyboard-focus-in-icon-only-+\d+$/);
    expect(commitMessage).toStartWith('fix: address acme/widgets#42 Fix keyboard focus');
    expect(commitMessage.length).toBeLessThanOrEqual(120);
  });

  test('reuses scoped commit headers and broader branch prefixes from repository rules', () => {
    const issue = createRankedIssue({
      repoFullName: 'acme/widgets',
      number: 42,
      title: 'Fix keyboard focus in icon-only widgets',
    });

    const branchName = contributionPrService.buildPublishBranchName(
      issue,
      createRepositoryRules({ branchNamingRule: 'Use bugfix/... branch names for bug fixes.' }),
    );
    const commitMessage = contributionPrService.buildContributionCommitMessage(
      issue,
      createRepositoryRules({ commitMessageRule: 'Use fix(accessibility): for accessibility bug-fix commits.' }),
    );

    expect(branchName).toMatch(/^bugfix\/42-fix-keyboard-focus-in-icon-only-+\d+$/);
    expect(commitMessage).toStartWith('fix(accessibility): address acme/widgets#42');
  });

  test('submits a draft PR against an existing fork and reuses an open PR when present', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'openmeta-contribution-pr-'));
    tempDirs.push(workspacePath);
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(join(workspacePath, 'src', 'app.ts'), 'export const version = 1;\n', 'utf-8');

    const originalGetUsername = githubService.getUsername;
    const service = new ContributionPrService() as unknown as ContributionPrInternals;
    const calls: string[] = [];

    (githubService as unknown as { getUsername: () => string }).getUsername = () => 'octocat';
    service.initialize({
      rest: {
        repos: {
          get: async ({ owner, repo }: { owner: string; repo: string }) => {
            calls.push(`repos.get:${owner}/${repo}`);
            if (owner === 'acme') {
              return { data: { default_branch: 'main' } };
            }

            return {
              data: {
                fork: true,
                parent: { full_name: 'acme/demo' },
                default_branch: 'main',
              },
            };
          },
          getBranch: async () => ({
            data: {
              commit: {
                sha: 'base-commit-sha',
                commit: {
                  tree: {
                    sha: 'base-tree-sha',
                  },
                },
              },
            },
          }),
          mergeUpstream: async () => {
            calls.push('repos.mergeUpstream');
            return { data: {} };
          },
        },
        pulls: {
          list: async () => ({
            data: [{ html_url: 'https://github.com/acme/demo/pull/9', number: 9 }],
          }),
        },
        git: {
          createTree: async () => ({ data: { sha: 'tree-sha' } }),
          createCommit: async () => ({ data: { sha: 'commit-sha' } }),
          createRef: async () => ({ data: {} }),
        },
      },
    });

    try {
      const result = await service.submitDraftPullRequest({
        issue: createRankedIssue({ repoFullName: 'acme/demo', number: 7 }),
        prDraft: createPullRequestDraft(),
        workspacePath,
        changedFiles: ['src/app.ts'],
      });

      expect(result.url).toBe('https://github.com/acme/demo/pull/9');
      expect(result.number).toBe(9);
      expect(calls).toContain('repos.get:acme/demo');
      expect(calls).toContain('repos.get:octocat/demo');
      expect(calls).toContain('repos.mergeUpstream');
    } finally {
      (githubService as unknown as { getUsername: () => string }).getUsername = originalGetUsername;
    }
  });

  test('continues when syncing an existing fork with upstream fails', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'openmeta-contribution-pr-sync-failure-'));
    tempDirs.push(workspacePath);
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(join(workspacePath, 'src', 'app.ts'), 'export const version = 1;\n', 'utf-8');

    const originalGetUsername = githubService.getUsername;
    const service = new ContributionPrService() as unknown as ContributionPrInternals;

    (githubService as unknown as { getUsername: () => string }).getUsername = () => 'octocat';
    service.initialize({
      rest: {
        repos: {
          get: async ({ owner }: { owner: string; repo: string }) =>
            owner === 'acme'
              ? { data: { default_branch: 'main' } }
              : {
                  data: {
                    fork: true,
                    parent: { full_name: 'acme/demo' },
                    default_branch: 'main',
                  },
                },
          getBranch: async () => ({
            data: {
              commit: {
                sha: 'base-commit-sha',
                commit: {
                  tree: {
                    sha: 'base-tree-sha',
                  },
                },
              },
            },
          }),
          mergeUpstream: async () => {
            throw new Error('merge failed');
          },
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async () => ({ data: { html_url: 'https://github.com/acme/demo/pull/10', number: 10 } }),
        },
        git: {
          createTree: async () => ({ data: { sha: 'tree-sha' } }),
          createCommit: async () => ({ data: { sha: 'commit-sha' } }),
          createRef: async () => ({ data: {} }),
        },
      },
    });

    try {
      const result = await service.submitDraftPullRequest({
        issue: createRankedIssue({ repoFullName: 'acme/demo', number: 8 }),
        prDraft: createPullRequestDraft(),
        workspacePath,
        changedFiles: ['src/app.ts'],
      });

      expect(result.url).toBe('https://github.com/acme/demo/pull/10');
      expect(result.number).toBe(10);
    } finally {
      (githubService as unknown as { getUsername: () => string }).getUsername = originalGetUsername;
    }
  });

  test('creates a draft PR when no open PR already exists', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'openmeta-contribution-pr-create-'));
    tempDirs.push(workspacePath);
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(join(workspacePath, 'src', 'app.ts'), 'export const version = 1;\n', 'utf-8');

    const originalGetUsername = githubService.getUsername;
    const service = new ContributionPrService() as unknown as ContributionPrInternals;
    let createdHead = '';

    (githubService as unknown as { getUsername: () => string }).getUsername = () => 'octocat';
    service.initialize({
      rest: {
        repos: {
          get: async ({ owner }: { owner: string; repo: string }) =>
            owner === 'acme'
              ? { data: { default_branch: 'main' } }
              : {
                  data: {
                    fork: true,
                    parent: { full_name: 'acme/demo' },
                    default_branch: 'main',
                  },
                },
          getBranch: async () => ({
            data: {
              commit: {
                sha: 'base-commit-sha',
                commit: {
                  tree: {
                    sha: 'base-tree-sha',
                  },
                },
              },
            },
          }),
          mergeUpstream: async () => ({ data: {} }),
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async ({ head }: { head: string }) => {
            createdHead = head;
            return { data: { html_url: 'https://github.com/acme/demo/pull/10', number: 10 } };
          },
        },
        git: {
          createTree: async () => ({ data: { sha: 'tree-sha' } }),
          createCommit: async () => ({ data: { sha: 'commit-sha' } }),
          createRef: async () => ({ data: {} }),
        },
      },
    });

    try {
      const result = await service.submitDraftPullRequest({
        issue: createRankedIssue({ repoFullName: 'acme/demo', number: 8 }),
        prDraft: createPullRequestDraft(),
        workspacePath,
        changedFiles: ['src/app.ts'],
      });

      expect(result.url).toBe('https://github.com/acme/demo/pull/10');
      expect(result.number).toBe(10);
      expect(createdHead).toMatch(/^octocat:openmeta\/agent-8-/);
    } finally {
      (githubService as unknown as { getUsername: () => string }).getUsername = originalGetUsername;
    }
  });

  test('updates an existing fork branch when createRef reports a duplicate ref', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'openmeta-contribution-pr-update-ref-'));
    tempDirs.push(workspacePath);
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(join(workspacePath, 'src', 'app.ts'), 'export const version = 2;\n', 'utf-8');

    const originalGetUsername = githubService.getUsername;
    const service = new ContributionPrService() as unknown as ContributionPrInternals;
    let updatedRef = '';

    (githubService as unknown as { getUsername: () => string }).getUsername = () => 'octocat';
    service.initialize({
      rest: {
        repos: {
          get: async ({ owner }: { owner: string; repo: string }) =>
            owner === 'acme'
              ? { data: { default_branch: 'main' } }
              : {
                  data: {
                    fork: true,
                    parent: { full_name: 'acme/demo' },
                    default_branch: 'main',
                  },
                },
          getBranch: async () => ({
            data: {
              commit: {
                sha: 'base-commit-sha',
                commit: {
                  tree: {
                    sha: 'base-tree-sha',
                  },
                },
              },
            },
          }),
          mergeUpstream: async () => ({ data: {} }),
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async () => ({ data: { html_url: 'https://github.com/acme/demo/pull/11', number: 11 } }),
        },
        git: {
          createTree: async () => ({ data: { sha: 'tree-sha' } }),
          createCommit: async () => ({ data: { sha: 'commit-sha' } }),
          createRef: async () => {
            throw { status: 422 };
          },
          updateRef: async ({ ref }: { ref: string }) => {
            updatedRef = ref;
            return { data: {} };
          },
        },
      },
    });

    try {
      const result = await service.submitDraftPullRequest({
        issue: createRankedIssue({ repoFullName: 'acme/demo', number: 9 }),
        prDraft: createPullRequestDraft(),
        workspacePath,
        changedFiles: ['src/app.ts'],
      });

      expect(result.number).toBe(11);
      expect(updatedRef).toMatch(/^heads\/openmeta\/agent-9-/);
    } finally {
      (githubService as unknown as { getUsername: () => string }).getUsername = originalGetUsername;
    }
  });

  test('rethrows unexpected createRef errors while publishing fork commits', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'openmeta-contribution-pr-create-ref-error-'));
    tempDirs.push(workspacePath);
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(join(workspacePath, 'src', 'app.ts'), 'export const version = 2;\n', 'utf-8');

    const originalGetUsername = githubService.getUsername;
    const service = new ContributionPrService() as unknown as ContributionPrInternals;

    (githubService as unknown as { getUsername: () => string }).getUsername = () => 'octocat';
    service.initialize({
      rest: {
        repos: {
          get: async ({ owner }: { owner: string; repo: string }) =>
            owner === 'acme'
              ? { data: { default_branch: 'main' } }
              : {
                  data: {
                    fork: true,
                    parent: { full_name: 'acme/demo' },
                    default_branch: 'main',
                  },
                },
          getBranch: async () => ({
            data: {
              commit: {
                sha: 'base-commit-sha',
                commit: {
                  tree: {
                    sha: 'base-tree-sha',
                  },
                },
              },
            },
          }),
          mergeUpstream: async () => ({ data: {} }),
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async () => ({ data: { html_url: 'https://github.com/acme/demo/pull/11', number: 11 } }),
        },
        git: {
          createTree: async () => ({ data: { sha: 'tree-sha' } }),
          createCommit: async () => ({ data: { sha: 'commit-sha' } }),
          createRef: async () => {
            throw { status: 500, message: 'boom' };
          },
          updateRef: async () => ({ data: {} }),
        },
      },
    });

    try {
      await expect(
        service.submitDraftPullRequest({
          issue: createRankedIssue({ repoFullName: 'acme/demo', number: 9 }),
          prDraft: createPullRequestDraft(),
          workspacePath,
          changedFiles: ['src/app.ts'],
        }),
      ).rejects.toEqual(expect.objectContaining({ status: 500 }));
    } finally {
      (githubService as unknown as { getUsername: () => string }).getUsername = originalGetUsername;
    }
  });

  test('fails clearly when the service is not initialized', async () => {
    const service = new ContributionPrService() as unknown as ContributionPrInternals;

    await expect(
      service.submitDraftPullRequest({
        issue: createRankedIssue({ repoFullName: 'acme/demo', number: 10 }),
        prDraft: createPullRequestDraft(),
        workspacePath: '/tmp/nowhere',
        changedFiles: ['src/app.ts'],
      }),
    ).rejects.toThrow('GitHub service not initialized');
  });

  test('rejects invalid issue repository references before making API calls', async () => {
    const service = new ContributionPrService() as unknown as ContributionPrInternals;
    service.initialize({ rest: { repos: {}, pulls: {}, git: {} } });

    await expect(
      service.submitDraftPullRequest({
        issue: createRankedIssue({ repoFullName: 'invalid-repo-name' }),
        prDraft: createPullRequestDraft(),
        workspacePath: '/tmp/nowhere',
        changedFiles: ['src/app.ts'],
      }),
    ).rejects.toThrow('Invalid issue repository reference: invalid-repo-name');
  });

  test('rejects an existing repository that is not a fork of the upstream repo', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'openmeta-contribution-pr-wrong-fork-'));
    tempDirs.push(workspacePath);
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(join(workspacePath, 'src', 'app.ts'), 'export const version = 3;\n', 'utf-8');

    const originalGetUsername = githubService.getUsername;
    const service = new ContributionPrService() as unknown as ContributionPrInternals;

    (githubService as unknown as { getUsername: () => string }).getUsername = () => 'octocat';
    service.initialize({
      rest: {
        repos: {
          get: async ({ owner }: { owner: string; repo: string }) =>
            owner === 'acme'
              ? { data: { default_branch: 'main' } }
              : {
                  data: {
                    fork: false,
                    parent: { full_name: 'someone/else' },
                    default_branch: 'main',
                  },
                },
        },
        pulls: {},
        git: {},
      },
    });

    try {
      await expect(
        service.submitDraftPullRequest({
          issue: createRankedIssue({ repoFullName: 'acme/demo', number: 11 }),
          prDraft: createPullRequestDraft(),
          workspacePath,
          changedFiles: ['src/app.ts'],
        }),
      ).rejects.toThrow('exists but is not a fork of acme/demo');
    } finally {
      (githubService as unknown as { getUsername: () => string }).getUsername = originalGetUsername;
    }
  });

  test('creates a fork when one does not exist yet and waits for it to become ready', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'openmeta-contribution-pr-new-fork-'));
    tempDirs.push(workspacePath);
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(join(workspacePath, 'src', 'app.ts'), 'export const version = 4;\n', 'utf-8');

    const originalGetUsername = githubService.getUsername;
    const originalSetTimeout = globalThis.setTimeout;
    const service = new ContributionPrService() as unknown as ContributionPrInternals;
    let repoGetCount = 0;
    let createForkCalled = false;

    (githubService as unknown as { getUsername: () => string }).getUsername = () => 'octocat';
    globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return 0 as unknown as Timer;
    }) as typeof setTimeout;

    service.initialize({
      rest: {
        repos: {
          get: async ({ owner }: { owner: string; repo: string }) => {
            if (owner === 'acme') {
              return { data: { default_branch: 'main' } };
            }

            repoGetCount += 1;
            if (repoGetCount === 1) {
              throw { status: 404 };
            }

            return {
              data: {
                fork: true,
                parent: { full_name: 'acme/demo' },
                default_branch: 'trunk',
              },
            };
          },
          getBranch: async () => ({
            data: {
              commit: {
                sha: 'base-commit-sha',
                commit: {
                  tree: {
                    sha: 'base-tree-sha',
                  },
                },
              },
            },
          }),
          createFork: async () => {
            createForkCalled = true;
            return { data: {} };
          },
          mergeUpstream: async () => ({ data: {} }),
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async () => ({ data: { html_url: 'https://github.com/acme/demo/pull/12', number: 12 } }),
        },
        git: {
          createTree: async () => ({ data: { sha: 'tree-sha' } }),
          createCommit: async () => ({ data: { sha: 'commit-sha' } }),
          createRef: async () => ({ data: {} }),
        },
      },
    });

    try {
      const result = await service.submitDraftPullRequest({
        issue: createRankedIssue({ repoFullName: 'acme/demo', number: 12 }),
        prDraft: createPullRequestDraft(),
        workspacePath,
        changedFiles: ['src/app.ts'],
      });

      expect(createForkCalled).toBe(true);
      expect(repoGetCount).toBeGreaterThanOrEqual(2);
      expect(result.number).toBe(12);
    } finally {
      (githubService as unknown as { getUsername: () => string }).getUsername = originalGetUsername;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('fails when a newly created fork never becomes ready', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'openmeta-contribution-pr-fork-timeout-'));
    tempDirs.push(workspacePath);
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(join(workspacePath, 'src', 'app.ts'), 'export const version = 5;\n', 'utf-8');

    const originalGetUsername = githubService.getUsername;
    const originalSetTimeout = globalThis.setTimeout;
    const service = new ContributionPrService() as unknown as ContributionPrInternals;

    (githubService as unknown as { getUsername: () => string }).getUsername = () => 'octocat';
    globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return 0 as unknown as Timer;
    }) as typeof setTimeout;

    service.initialize({
      rest: {
        repos: {
          get: async ({ owner }: { owner: string; repo: string }) => {
            if (owner === 'acme') {
              return { data: { default_branch: 'main' } };
            }

            throw { status: 404 };
          },
          createFork: async () => ({ data: {} }),
        },
        pulls: {},
        git: {},
      },
    });

    try {
      await expect(
        service.submitDraftPullRequest({
          issue: createRankedIssue({ repoFullName: 'acme/demo', number: 13 }),
          prDraft: createPullRequestDraft(),
          workspacePath,
          changedFiles: ['src/app.ts'],
        }),
      ).rejects.toThrow('Fork octocat/demo was not ready in time.');
    } finally {
      (githubService as unknown as { getUsername: () => string }).getUsername = originalGetUsername;
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

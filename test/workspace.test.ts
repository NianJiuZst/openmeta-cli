import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import { pathToFileURL } from 'url';
import { workspaceService } from '../src/services/workspace.js';
import { createMemory, createRankedIssue } from './helpers/factories.js';

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openmeta-workspace-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        if (!(error instanceof Error) || !/EBUSY/i.test(error.message)) {
          throw error;
        }
      }
    }
  }
});

describe('workspaceService.applyGeneratedChanges', () => {
  test('writes updated files inside the workspace and returns relative paths', () => {
    const workspacePath = makeWorkspace();
    const filePath = join(workspacePath, 'src', 'button.ts');
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const button = 1;\n', 'utf-8');

    const result = workspaceService.applyGeneratedChanges(workspacePath, [
      {
        path: 'src/button.ts',
        reason: 'Update implementation',
        content: 'export const button = 2;\n',
      },
    ]);

    expect(result.appliedFiles).toEqual(['src/button.ts']);
    expect(result.reviewRequired).toBe(false);
    expect(readFileSync(filePath, 'utf-8')).toBe('export const button = 2;\n');
  });

  test('skips unsafe paths outside the workspace', () => {
    const workspacePath = makeWorkspace();
    const outsidePath = join(workspacePath, '..', 'escape.ts');

    const result = workspaceService.applyGeneratedChanges(workspacePath, [
      {
        path: '../escape.ts',
        reason: 'Unsafe path',
        content: 'export const leaked = true;\n',
      },
    ]);

    expect(result.appliedFiles).toEqual([]);
    expect(result.reviewRequired).toBe(true);
    expect(result.skippedFiles[0]?.reason).toContain('outside the workspace');
    expect(existsSync(outsidePath)).toBe(false);
  });

  test('does not report files whose content is unchanged', () => {
    const workspacePath = makeWorkspace();
    const filePath = join(workspacePath, 'README.md');
    writeFileSync(filePath, '# Demo\n', 'utf-8');

    const result = workspaceService.applyGeneratedChanges(workspacePath, [
      {
        path: 'README.md',
        reason: 'No-op',
        content: '# Demo\n',
      },
    ]);

    expect(result.appliedFiles).toEqual([]);
    expect(result.reviewRequired).toBe(false);
    expect(result.skippedFiles[0]?.reason).toContain('unchanged');
  });

  test('requires review when generated edits target files outside implementation context', () => {
    const workspacePath = makeWorkspace();
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(join(workspacePath, 'src', 'known.ts'), 'export const known = 1;\n', 'utf-8');
    writeFileSync(join(workspacePath, 'src', 'surprise.ts'), 'export const surprise = 1;\n', 'utf-8');

    const result = workspaceService.applyGeneratedChanges(
      workspacePath,
      [
        {
          path: 'src/surprise.ts',
          reason: 'Unexpected edit',
          content: 'export const surprise = 2;\n',
        },
      ],
      {
        allowedPaths: ['src/known.ts'],
      },
    );

    expect(result.appliedFiles).toEqual([]);
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReason).toContain('selected implementation context');
    expect(readFileSync(join(workspacePath, 'src', 'surprise.ts'), 'utf-8')).toBe('export const surprise = 1;\n');
  });

  test('requires review when generated patch touches too many files', () => {
    const workspacePath = makeWorkspace();
    const changes = Array.from({ length: 7 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      reason: 'Too broad',
      content: `export const value${index} = true;\n`,
    }));

    const result = workspaceService.applyGeneratedChanges(workspacePath, changes);

    expect(result.appliedFiles).toEqual([]);
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReason).toContain('automatic apply limit');
  });
});

describe('workspaceService.detectTestCommands', () => {
  test(
    'uses a local repository path by creating an isolated worktree instead of cloning into the managed workspace',
    async () => {
    const tempRoot = makeWorkspace();
    const openMetaHome = join(tempRoot, 'openmeta-home');
    const sourcePath = join(tempRoot, 'source');
    process.env['OPENMETA_HOME'] = openMetaHome;

    mkdirSync(sourcePath, { recursive: true });
    const git = simpleGit(sourcePath);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'OpenMeta Test');
    await git.addConfig('user.email', 'openmeta@example.com');
    writeFileSync(join(sourcePath, 'README.md'), '# Local Demo\n', 'utf-8');
    await git.add('README.md');
    await git.commit('chore: seed local repo');

    try {
      const workspace = await (
        workspaceService as unknown as {
          prepareRepositoryWorkspace(
            repoFullName: string,
            memory: ReturnType<typeof createMemory>,
            runChecks: boolean,
            executionMode?: 'interactive' | 'headless',
            repoPath?: string,
          ): Promise<{
            workspacePath: string;
            branchName?: string;
            topLevelFiles: string[];
          }>;
        }
      ).prepareRepositoryWorkspace(
        'acme/demo',
        createMemory({ repoFullName: 'acme/demo' }),
        false,
        'interactive',
        sourcePath,
      );

      expect(workspace.workspacePath).toContain(join('openmeta-home', 'worktrees'));
      expect(workspace.workspacePath).not.toBe(sourcePath);
      expect(workspace.branchName).toMatch(/^openmeta\/analyze-acme-demo/);
      expect(workspace.topLevelFiles).toContain('README.md');

      const managedMirrorPath = join(openMetaHome, 'workspaces', 'acme__demo');
      expect(existsSync(managedMirrorPath)).toBe(false);
    } finally {
      delete process.env['OPENMETA_HOME'];
    }
    },
    { timeout: 20_000 },
  );

  test(
    'prepares repository workspace without a real issue target',
    async () => {
    const tempRoot = makeWorkspace();
    const openMetaHome = join(tempRoot, 'openmeta-home');
    const remotePath = join(tempRoot, 'remote.git');
    const seedPath = join(tempRoot, 'seed');
    process.env['OPENMETA_HOME'] = openMetaHome;

    mkdirSync(seedPath, { recursive: true });
    const seedGit = simpleGit(seedPath);
    await seedGit.init(['--initial-branch=main']);
    await seedGit.addConfig('user.name', 'OpenMeta Test');
    await seedGit.addConfig('user.email', 'openmeta@example.com');
    mkdirSync(join(seedPath, 'src'), { recursive: true });
    writeFileSync(join(seedPath, 'README.md'), '# Demo\n\nMissing setup notes.\n', 'utf-8');
    writeFileSync(
      join(seedPath, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'bun test',
        },
      }),
      'utf-8',
    );
    writeFileSync(join(seedPath, 'src', 'index.ts'), 'export const demo = true;\n', 'utf-8');
    await seedGit.add('.');
    await seedGit.commit('chore: seed repo');
    await simpleGit().clone(seedPath, remotePath, ['--bare']);

    const service = workspaceService as unknown as {
      buildRepoUrl(repoFullName: string): string;
      prepareRepositoryWorkspace(
        repoFullName: string,
        memory: ReturnType<typeof createMemory>,
        runChecks: boolean,
        executionMode?: 'interactive' | 'headless',
      ): Promise<{
        workspacePath: string;
        defaultBranch: string;
        branchName?: string;
        topLevelFiles: string[];
        candidateFiles: string[];
        snippets: Array<{ path: string; content: string }>;
        testCommands: Array<{ command: string }>;
      }>;
    };
    const originalBuildRepoUrl = service.buildRepoUrl;
    service.buildRepoUrl = () => pathToFileURL(remotePath).href;

    try {
      const workspace = await service.prepareRepositoryWorkspace(
        'acme/demo',
        createMemory({
          repoFullName: 'acme/demo',
          preferredPaths: ['src/index.ts'],
        }),
        false,
      );

      expect(workspace.defaultBranch).toBe('main');
      expect(workspace.branchName).toMatch(/^openmeta\/analyze-acme-demo/);
      expect(workspace.topLevelFiles).toContain('README.md');
      expect(workspace.candidateFiles).toContain('README.md');
      expect(workspace.candidateFiles).toContain('src/index.ts');
      expect(workspace.snippets.some((snippet) => snippet.path === 'README.md')).toBe(true);
      expect(workspace.testCommands.map((command) => command.command)).toContain('bun run test');
    } finally {
      service.buildRepoUrl = originalBuildRepoUrl;
      delete process.env['OPENMETA_HOME'];
    }
    },
    { timeout: 20_000 },
  );

  test(
    'creates a shallow single-branch clone for new managed workspaces',
    async () => {
    const tempRoot = makeWorkspace();
    const openMetaHome = join(tempRoot, 'openmeta-home');
    const remotePath = join(tempRoot, 'remote.git');
    const seedPath = join(tempRoot, 'seed');
    process.env['OPENMETA_HOME'] = openMetaHome;

    mkdirSync(seedPath, { recursive: true });
    const seedGit = simpleGit(seedPath);
    await seedGit.init(['--initial-branch=main']);
    await seedGit.addConfig('user.name', 'OpenMeta Test');
    await seedGit.addConfig('user.email', 'openmeta@example.com');
    writeFileSync(join(seedPath, 'README.md'), '# Demo\n', 'utf-8');
    await seedGit.add('README.md');
    await seedGit.commit('chore: seed repo');
    await simpleGit().clone(seedPath, remotePath, ['--bare']);

    const service = workspaceService as unknown as {
      buildRepoUrl(repoFullName: string): string;
      prepareRepositoryWorkspace(
        repoFullName: string,
        memory: ReturnType<typeof createMemory>,
        runChecks: boolean,
        executionMode?: 'interactive' | 'headless',
        repoPath?: string,
      ): Promise<{ workspacePath: string }>;
    };
    const originalBuildRepoUrl = service.buildRepoUrl;
    service.buildRepoUrl = () => pathToFileURL(remotePath).href;

    try {
      const workspace = await service.prepareRepositoryWorkspace(
        'acme/demo',
        createMemory({ repoFullName: 'acme/demo' }),
        false,
      );
      const clonedGit = simpleGit(workspace.workspacePath);
      const shallowFile = join(workspace.workspacePath, '.git', 'shallow');
      const remoteBranches = await clonedGit.branch(['-r']);

      expect(existsSync(shallowFile)).toBe(true);
      expect(remoteBranches.all).toEqual(['origin/main']);
    } finally {
      service.buildRepoUrl = originalBuildRepoUrl;
      delete process.env['OPENMETA_HOME'];
    }
    },
    { timeout: 20_000 },
  );

  test(
    'rebuilds a managed workspace when the cached clone has an invalid HEAD',
    async () => {
    const tempRoot = makeWorkspace();
    const openMetaHome = join(tempRoot, 'openmeta-home');
    const remotePath = join(tempRoot, 'remote.git');
    const seedPath = join(tempRoot, 'seed');
    process.env['OPENMETA_HOME'] = openMetaHome;

    mkdirSync(seedPath, { recursive: true });
    const seedGit = simpleGit(seedPath);
    await seedGit.init(['--initial-branch=main']);
    await seedGit.addConfig('user.name', 'OpenMeta Test');
    await seedGit.addConfig('user.email', 'openmeta@example.com');
    writeFileSync(join(seedPath, 'README.md'), '# Demo\n', 'utf-8');
    await seedGit.add('README.md');
    await seedGit.commit('chore: seed repo');
    await simpleGit().clone(seedPath, remotePath, ['--bare']);

    const service = workspaceService as unknown as {
      buildRepoUrl(repoFullName: string): string;
      prepareRepositoryWorkspace(
        repoFullName: string,
        memory: ReturnType<typeof createMemory>,
        runChecks: boolean,
        executionMode?: 'interactive' | 'headless',
        repoPath?: string,
      ): Promise<{ workspacePath: string; topLevelFiles: string[] }>;
    };
    const originalBuildRepoUrl = service.buildRepoUrl;
    service.buildRepoUrl = () => pathToFileURL(remotePath).href;

    try {
      const firstWorkspace = await service.prepareRepositoryWorkspace(
        'acme/demo',
        createMemory({ repoFullName: 'acme/demo' }),
        false,
      );
      const headPath = join(firstWorkspace.workspacePath, '.git', 'refs', 'heads', 'main');
      writeFileSync(headPath, '0000000000000000000000000000000000000000\n', 'utf-8');

      const recoveredWorkspace = await service.prepareRepositoryWorkspace(
        'acme/demo',
        createMemory({ repoFullName: 'acme/demo' }),
        false,
      );
      const recoveredGit = simpleGit(recoveredWorkspace.workspacePath);
      const branchSummary = await recoveredGit.branchLocal();

      expect(recoveredWorkspace.workspacePath).toBe(firstWorkspace.workspacePath);
      expect(recoveredWorkspace.topLevelFiles).toContain('README.md');
      expect(branchSummary.current).toMatch(/^openmeta\/analyze-acme-demo/);
    } finally {
      service.buildRepoUrl = originalBuildRepoUrl;
      delete process.env['OPENMETA_HOME'];
    }
    },
    { timeout: 20_000 },
  );

  test('prefers bun for package scripts when a bun lockfile is present', () => {
    const workspacePath = makeWorkspace();
    writeFileSync(
      join(workspacePath, 'package.json'),
      JSON.stringify({
        scripts: {
          lint: 'eslint .',
          build: 'vite build',
        },
      }),
      'utf-8',
    );
    writeFileSync(join(workspacePath, 'bun.lock'), '', 'utf-8');

    const commands = (
      workspaceService as unknown as {
        detectTestCommands(path: string): Array<{ command: string }>;
      }
    ).detectTestCommands(workspacePath);

    expect(commands.map((command) => command.command)).toContain('bun run lint');
    expect(commands.map((command) => command.command)).toContain('bun run build');
  });

  test('skips repository-defined validation scripts in headless mode', () => {
    const commands = [
      { command: 'bun run test', reason: 'Detected package.json test script (bun)', source: 'repo-script' as const },
      { command: 'pytest', reason: 'Detected pyproject.toml', source: 'tool-default' as const },
    ];

    const selected = (
      workspaceService as unknown as {
        selectValidationCommands: (
          commands: Array<{ command: string; reason: string; source: 'tool-default' | 'repo-script' }>,
          mode: 'interactive' | 'headless',
        ) => { commands: Array<{ command: string }>; warnings: string[] };
      }
    ).selectValidationCommands(commands, 'headless');

    expect(selected.commands.map((command) => command.command)).toEqual(['pytest']);
    expect(selected.warnings[0]).toContain('Skipped bun run test during headless validation');
  });

  test('reads workspace files safely and ignores paths outside the repository root', () => {
    const workspacePath = makeWorkspace();
    mkdirSync(join(workspacePath, 'src'), { recursive: true });
    writeFileSync(join(workspacePath, 'src', 'index.ts'), 'export const ready = true;\n', 'utf-8');

    const snippets = workspaceService.readWorkspaceFiles(workspacePath, ['src/index.ts', '../escape.ts']);

    expect(snippets).toEqual([
      {
        path: 'src/index.ts',
        content: 'export const ready = true;\n',
      },
    ]);
  });

  test('creates a unique workspace branch name when the base branch already exists', async () => {
    const workspacePath = makeWorkspace();
    const git = simpleGit(workspacePath);

    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'OpenMeta Test');
    await git.addConfig('user.email', 'openmeta@example.com');
    writeFileSync(join(workspacePath, 'README.md'), '# Demo\n', 'utf-8');
    await git.add('README.md');
    await git.commit('chore: initial commit');
    await git.checkoutLocalBranch('openmeta/42-add-accessible-labels-to-icon-buttons');

    const branchName = await (
      workspaceService as unknown as {
        createWorkspaceBranchName: (
          gitInstance: ReturnType<typeof simpleGit>,
          issue: ReturnType<typeof createRankedIssue>,
        ) => Promise<string>;
      }
    ).createWorkspaceBranchName(git, createRankedIssue());

    expect(branchName).toMatch(/^openmeta\/42-add-accessible-labels-to-icon-buttons-\d+$/);
  });

  test('prioritizes file paths explicitly referenced in the issue body', () => {
    const workspacePath = makeWorkspace();
    mkdirSync(join(workspacePath, 'src', 'components'), { recursive: true });
    writeFileSync(
      join(workspacePath, 'src', 'components', 'Dropzone.tsx'),
      'export const Dropzone = () => null;\n',
      'utf-8',
    );
    writeFileSync(join(workspacePath, 'src', 'misc.ts'), 'export const misc = true;\n', 'utf-8');

    const rankedFiles = (
      workspaceService as unknown as {
        rankCandidateFiles: (
          issue: { title: string; body: string; analysis: { coreDemand: string; techRequirements: string[] } },
          memory: { preferredPaths: string[] },
          files: string[],
        ) => string[];
      }
    ).rankCandidateFiles(
      {
        title: 'Fix accessibility in Dropzone',
        body: 'The problem is in `src/components/Dropzone.tsx` and should be fixed there.',
        analysis: {
          coreDemand: 'Add accessibility attributes to the dropzone.',
          techRequirements: ['react', 'typescript'],
        },
      },
      { preferredPaths: [] },
      ['src/misc.ts', 'src/components/Dropzone.tsx'],
    );

    expect(rankedFiles[0]).toBe('src/components/Dropzone.tsx');
  });

  test('prioritizes historically successful files from memory path signals', () => {
    const rankedFiles = (
      workspaceService as unknown as {
        rankCandidateFiles: (
          issue: { title: string; body: string; analysis: { coreDemand: string; techRequirements: string[] } },
          memory: {
            preferredPaths: string[];
            pathSignals: Array<{
              path: string;
              candidateCount: number;
              changedCount: number;
              successfulValidationCount: number;
              publishedCount: number;
            }>;
            recentIssues: Array<{
              changedFiles: string[];
              status: 'selected' | 'draft_only' | 'review_required' | 'validated' | 'published' | 'pr_opened';
            }>;
          },
          files: string[],
        ) => string[];
      }
    ).rankCandidateFiles(
      {
        title: 'Improve accessibility in icon interactions',
        body: 'Audit the button flow for better labels and affordances.',
        analysis: {
          coreDemand: 'Tighten icon button accessibility behavior.',
          techRequirements: ['react', 'typescript'],
        },
      },
      {
        preferredPaths: [],
        pathSignals: [
          {
            path: 'src/components/IconButton.tsx',
            candidateCount: 2,
            changedCount: 2,
            successfulValidationCount: 2,
            publishedCount: 1,
          },
        ],
        recentIssues: [
          {
            changedFiles: ['src/components/IconButton.tsx'],
            status: 'published',
          },
        ],
      },
      ['src/utils/labels.ts', 'src/components/IconButton.tsx'],
    );

    expect(rankedFiles[0]).toBe('src/components/IconButton.tsx');
  });

  test('prioritizes repository analysis paths with docs, config, source, tests, and memory signals', () => {
    const rankedFiles = (
      workspaceService as unknown as {
        rankRepositoryAnalysisFiles: (memory: ReturnType<typeof createMemory>, files: string[]) => string[];
      }
    ).rankRepositoryAnalysisFiles(
      createMemory({
        preferredPaths: ['src/components/IconButton.tsx'],
      }),
      [
        'docs/internal/archive.txt',
        'README.md',
        'package.json',
        'src/components/IconButton.tsx',
        'test/icon-button.test.ts',
        'assets/logo.png',
      ],
    );

    expect(rankedFiles.slice(0, 4)).toEqual([
      'src/components/IconButton.tsx',
      'README.md',
      'package.json',
      'test/icon-button.test.ts',
    ]);
  });
});

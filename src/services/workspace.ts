import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { type SimpleGit, simpleGit } from 'simple-git';
import { ensureDirectory, getOpenMetaWorkspaceRoot, logger } from '../infra/index.js';
import type {
  GeneratedChangeApplyResult,
  GeneratedFileChange,
  RankedIssue,
  RepoFileSnippet,
  RepoMemory,
  RepoWorkspaceContext,
  TestCommand,
  TestResult,
} from '../types/index.js';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'target', 'vendor']);

const MAX_DISCOVERED_FILES = 250;
const MAX_SNIPPET_CHARS = 8000;
const MAX_GENERATED_FILES = 6;
const MAX_GENERATED_FILE_CHARS = 60_000;
type ExecutionMode = 'interactive' | 'headless';

function normalizeRepoRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

interface PreparedWorkspaceState {
  workspacePath: string;
  defaultBranch: string;
  workspaceDirty: boolean;
  branchName?: string;
}

function sanitizeRepoName(repoFullName: string): string {
  return repoFullName.replace(/\//g, '__');
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export class WorkspaceService {
  private getWorkspacePath(repoFullName: string): string {
    return join(ensureDirectory(getOpenMetaWorkspaceRoot()), sanitizeRepoName(repoFullName));
  }

  private getWorktreeRoot(): string {
    return join(ensureDirectory(getOpenMetaWorkspaceRoot()), '..', 'worktrees');
  }

  async prepareWorkspace(
    issue: RankedIssue,
    memory: RepoMemory,
    runChecks: boolean,
    executionMode: ExecutionMode = 'interactive',
    repoPath?: string,
  ): Promise<RepoWorkspaceContext> {
    const workspaceState = await this.prepareGitWorkspace(
      issue.repoFullName,
      (git) => this.createWorkspaceBranchName(git, issue),
      repoPath,
    );
    const candidateFiles = this.rankCandidateFiles(
      issue,
      memory,
      this.discoverFiles(workspaceState.workspacePath),
    ).slice(0, 8);

    return this.buildWorkspaceContext({
      workspacePath: workspaceState.workspacePath,
      workspaceDirty: workspaceState.workspaceDirty,
      defaultBranch: workspaceState.defaultBranch,
      branchName: workspaceState.branchName,
      candidateFiles,
      runChecks,
      executionMode,
    });
  }

  async prepareRepositoryWorkspace(
    repoFullName: string,
    memory: RepoMemory,
    runChecks: boolean,
    executionMode: ExecutionMode = 'interactive',
    repoPath?: string,
  ): Promise<RepoWorkspaceContext> {
    const workspaceState = await this.prepareGitWorkspace(
      repoFullName,
      (git) => this.createRepositoryAnalysisBranchName(git, repoFullName),
      repoPath,
    );
    const candidateFiles = this.rankRepositoryAnalysisFiles(
      memory,
      this.discoverFiles(workspaceState.workspacePath),
    ).slice(0, 12);

    return this.buildWorkspaceContext({
      workspacePath: workspaceState.workspacePath,
      candidateFiles,
      workspaceDirty: workspaceState.workspaceDirty,
      defaultBranch: workspaceState.defaultBranch,
      branchName: workspaceState.branchName,
      runChecks,
      executionMode,
    });
  }

  applyGeneratedChanges(
    workspacePath: string,
    fileChanges: GeneratedFileChange[],
    options: { allowedPaths?: string[] } = {},
  ): GeneratedChangeApplyResult {
    const rootPath = resolve(workspacePath);
    const allowedPaths = new Set(
      (options.allowedPaths ?? []).map((path) => normalizeRepoRelativePath(path)).filter(Boolean),
    );
    const appliedFiles: string[] = [];
    const skippedFiles: GeneratedChangeApplyResult['skippedFiles'] = [];

    if (fileChanges.length > MAX_GENERATED_FILES) {
      return {
        appliedFiles: [],
        skippedFiles: fileChanges.map((change) => ({
          path: change.path,
          reason: `Generated patch touches ${fileChanges.length} files; automatic apply limit is ${MAX_GENERATED_FILES}.`,
        })),
        reviewRequired: true,
        reviewReason: `Generated patch touches ${fileChanges.length} files, which exceeds the automatic apply limit of ${MAX_GENERATED_FILES}.`,
      };
    }

    for (const change of fileChanges) {
      const relativePath = normalizeRepoRelativePath(change.path);
      if (!relativePath) {
        skippedFiles.push({ path: change.path, reason: 'Generated path is empty.' });
        continue;
      }

      const targetPath = resolve(rootPath, relativePath);
      if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${sep}`)) {
        logger.warn(`Skipping unsafe generated path outside the workspace: ${change.path}`);
        skippedFiles.push({ path: change.path, reason: 'Generated path is outside the workspace.' });
        continue;
      }

      if (allowedPaths.size > 0 && !allowedPaths.has(relativePath)) {
        skippedFiles.push({
          path: relativePath,
          reason: 'Generated path was not part of the selected implementation context.',
        });
        continue;
      }

      if (change.content.length > MAX_GENERATED_FILE_CHARS) {
        skippedFiles.push({
          path: relativePath,
          reason: `Generated content exceeds ${MAX_GENERATED_FILE_CHARS} characters.`,
        });
        continue;
      }

      const existingContent = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : null;
      if (existingContent === change.content) {
        skippedFiles.push({ path: relativePath, reason: 'Generated content is unchanged.' });
        continue;
      }

      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, change.content, 'utf-8');
      appliedFiles.push(relativePath);
    }

    const unsafeSkipped = skippedFiles.filter(
      (file) =>
        file.reason.includes('outside the workspace') ||
        file.reason.includes('not part of the selected implementation context') ||
        file.reason.includes('exceeds'),
    );

    return {
      appliedFiles,
      skippedFiles,
      reviewRequired: unsafeSkipped.length > 0,
      reviewReason:
        unsafeSkipped.length > 0 ? unsafeSkipped.map((file) => `${file.path}: ${file.reason}`).join('; ') : undefined,
    };
  }

  runValidationCommands(workspacePath: string, commands: TestCommand[]): TestResult[] {
    return this.runTestCommands(workspacePath, commands);
  }

  readWorkspaceFiles(workspacePath: string, filePaths: string[]): RepoFileSnippet[] {
    const rootPath = resolve(workspacePath);

    return filePaths.flatMap((filePath) => {
      const relativePath = normalizeRepoRelativePath(filePath);
      if (!relativePath) {
        return [];
      }

      const targetPath = resolve(rootPath, relativePath);
      if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${sep}`)) {
        logger.warn(`Skipping unsafe workspace read outside the repository root: ${filePath}`);
        return [];
      }

      return [
        {
          path: relativePath,
          content: this.readSnippet(targetPath),
        },
      ];
    });
  }

  private async detectDefaultBranch(git: SimpleGit): Promise<string> {
    try {
      const branchReference = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      const segments = branchReference.trim().split('/');
      return segments.at(-1) || 'main';
    } catch {
      const branches = await git.branch();

      if (branches.all.includes('main')) {
        return 'main';
      }

      if (branches.all.includes('master')) {
        return 'master';
      }

      return branches.current || 'main';
    }
  }

  private buildRepoUrl(repoFullName: string): string {
    return `https://github.com/${repoFullName}.git`;
  }

  private async prepareGitWorkspace(
    repoFullName: string,
    createBranchName: (git: SimpleGit) => Promise<string>,
    repoPath?: string,
  ): Promise<PreparedWorkspaceState> {
    if (repoPath) {
      return this.prepareExternalWorkspace(repoFullName, repoPath, createBranchName);
    }

    return this.prepareManagedWorkspace(repoFullName, createBranchName);
  }

  private async prepareManagedWorkspace(
    repoFullName: string,
    createBranchName: (git: SimpleGit) => Promise<string>,
  ): Promise<PreparedWorkspaceState> {
    const workspacePath = this.getWorkspacePath(repoFullName);
    const repoUrl = this.buildRepoUrl(repoFullName);
    const defaultBranch = await this.detectRemoteDefaultBranch(repoUrl);

    try {
      if (!existsSync(workspacePath)) {
        await this.cloneManagedWorkspace(repoUrl, workspacePath, defaultBranch);
      }

      const git = simpleGit(workspacePath);
      await this.syncManagedWorkspace(git);

      if (!existsSync(join(workspacePath, '.git', 'shallow'))) {
        try {
          await git.fetch('origin', defaultBranch, { '--depth': '1', '--prune': null });
        } catch (error) {
          logger.debug(`Unable to re-fetch ${repoFullName} as a shallow workspace`, error);
        }
      }

      return await this.finalizeWorkspaceBranch(git, workspacePath, defaultBranch, createBranchName);
    } catch (error) {
      if (!this.isRecoverableManagedWorkspaceError(error)) {
        throw error;
      }

      logger.warn(`Managed workspace cache for ${repoFullName} is invalid. Rebuilding the shallow clone.`, error);
      rmSync(workspacePath, { recursive: true, force: true });
      await this.cloneManagedWorkspace(repoUrl, workspacePath, defaultBranch);
      const recoveredGit = simpleGit(workspacePath);
      await this.syncManagedWorkspace(recoveredGit);

      try {
        await recoveredGit.fetch('origin', defaultBranch, { '--depth': '1', '--prune': null });
      } catch (error) {
        logger.debug(`Unable to re-fetch ${repoFullName} as a shallow workspace`, error);
      }

      return await this.finalizeWorkspaceBranch(recoveredGit, workspacePath, defaultBranch, createBranchName);
    }
  }

  private async prepareExternalWorkspace(
    repoFullName: string,
    repoPath: string,
    createBranchName: (git: SimpleGit) => Promise<string>,
  ): Promise<PreparedWorkspaceState> {
    const sourcePath = resolve(repoPath);
    if (!existsSync(sourcePath)) {
      throw new Error(`Configured local repository path does not exist: ${repoPath}`);
    }

    const sourceGit = simpleGit(sourcePath);
    const isRepo = await sourceGit.checkIsRepo();
    if (!isRepo) {
      throw new Error(`Configured local repository path is not a git repository: ${repoPath}`);
    }

    await this.assertRepositoryReadyForWorktree(sourceGit, sourcePath);

    const defaultBranch = await this.detectDefaultBranch(sourceGit);
    try {
      await sourceGit.fetch('origin', defaultBranch, { '--depth': '1', '--prune': null });
    } catch (error) {
      logger.debug(`Unable to refresh external repository ${sourcePath} from origin/${defaultBranch}`, error);
    }

    const branchName = await createBranchName(sourceGit);
    const worktreePath = this.getExecutionWorktreePath(repoFullName, branchName);
    const parentDir = dirname(worktreePath);
    mkdirSync(parentDir, { recursive: true });

    if (existsSync(worktreePath)) {
      const worktreeGit = simpleGit(worktreePath);
      try {
        await worktreeGit.raw(['worktree', 'remove', '--force', worktreePath]);
      } catch (error) {
        logger.debug(`Unable to remove stale worktree at ${worktreePath}`, error);
      }
    }

    const baseRef = `origin/${defaultBranch}`;
    try {
      await sourceGit.raw(['worktree', 'add', '-b', branchName, worktreePath, baseRef]);
    } catch {
      await sourceGit.raw(['worktree', 'add', '-b', branchName, worktreePath, defaultBranch]);
    }

    const worktreeGit = simpleGit(worktreePath);
    return this.finalizeWorkspaceBranch(worktreeGit, worktreePath, defaultBranch, async () => branchName, true);
  }

  private async syncManagedWorkspace(git: SimpleGit): Promise<void> {
    try {
      await git.fetch('origin');
    } catch (error) {
      logger.debug('Unable to fetch managed workspace before preparing branch', error);
    }
  }

  private async finalizeWorkspaceBranch(
    git: SimpleGit,
    workspacePath: string,
    defaultBranch: string,
    createBranchName: (git: SimpleGit) => Promise<string>,
    branchAlreadyCreated: boolean = false,
  ): Promise<PreparedWorkspaceState> {
    const status = await git.status();
    const workspaceDirty = status.files.length > 0;
    const branchName = workspaceDirty ? undefined : await createBranchName(git);

    if (!workspaceDirty && branchName && !branchAlreadyCreated) {
      await git.checkout(defaultBranch);
      try {
        await git.pull('origin', defaultBranch, { '--ff-only': null });
      } catch (error) {
        logger.debug('Unable to fast-forward workspace before branch creation', error);
      }

      await git.checkoutLocalBranch(branchName);
    }

    return {
      workspacePath,
      defaultBranch,
      workspaceDirty,
      branchName,
    };
  }

  private async cloneManagedWorkspace(repoUrl: string, workspacePath: string, defaultBranch: string): Promise<void> {
    mkdirSync(dirname(workspacePath), { recursive: true });
    await simpleGit().clone(repoUrl, workspacePath, ['--depth', '1', '--single-branch', '--branch', defaultBranch]);
  }

  private isRecoverableManagedWorkspaceError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\binvalid HEAD\b|\bbad object HEAD\b|\bambiguous argument 'HEAD'\b|\bNeeded a single revision\b|\bunable to read tree\b/i.test(
      message,
    );
  }

  private getExecutionWorktreePath(repoFullName: string, branchName: string): string {
    return join(
      ensureDirectory(this.getWorktreeRoot()),
      sanitizeRepoName(repoFullName),
      branchName.replace(/\//g, '__'),
    );
  }

  private async assertRepositoryReadyForWorktree(git: SimpleGit, sourcePath: string): Promise<void> {
    const gitDir = await git.revparse(['--git-dir']);
    const absoluteGitDir = resolve(sourcePath, gitDir.trim());
    const conflictMarkers = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'BISECT_LOG']
      .map((marker) => join(absoluteGitDir, marker))
      .filter((filePath) => existsSync(filePath));

    if (conflictMarkers.length > 0) {
      throw new Error(`Local repository is mid-operation and cannot be reused safely: ${sourcePath}`);
    }
    await git.status();
  }

  private async detectRemoteDefaultBranch(repoUrl: string): Promise<string> {
    const lsRemote = spawnSync('git', ['ls-remote', '--symref', repoUrl, 'HEAD'], {
      encoding: 'utf-8',
      timeout: 30000,
    });

    const firstLine = lsRemote.stdout.split('\n').find((line) => line.startsWith('ref:'));
    const match = firstLine?.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/);
    if (match?.[1]) {
      return match[1];
    }

    return 'main';
  }

  private buildWorkspaceContext(input: {
    workspacePath: string;
    workspaceDirty: boolean;
    defaultBranch: string;
    branchName?: string;
    candidateFiles: string[];
    runChecks: boolean;
    executionMode: ExecutionMode;
  }): RepoWorkspaceContext {
    const topLevelFiles = readdirSync(input.workspacePath).slice(0, 50);
    const snippets = input.candidateFiles.map((path) => ({
      path,
      content: this.readSnippet(join(input.workspacePath, path)),
    }));
    const testCommands = this.detectTestCommands(input.workspacePath);
    const { commands: validationCommands, warnings: validationWarnings } = this.selectValidationCommands(
      testCommands,
      input.executionMode,
    );
    const testResults = input.runChecks
      ? this.runTestCommands(input.workspacePath, validationCommands.slice(0, 3))
      : [];

    return {
      workspacePath: input.workspacePath,
      workspaceDirty: input.workspaceDirty,
      defaultBranch: input.defaultBranch,
      branchName: input.branchName,
      topLevelFiles,
      candidateFiles: input.candidateFiles,
      snippets,
      testCommands,
      validationCommands,
      validationWarnings,
      testResults,
    };
  }

  private async createWorkspaceBranchName(git: SimpleGit, issue: RankedIssue): Promise<string> {
    const baseBranchName = `openmeta/${issue.number}-${slugify(issue.title) || 'issue'}`;
    const localBranches = await git.branchLocal();
    if (!localBranches.all.includes(baseBranchName)) {
      return baseBranchName;
    }

    return `${baseBranchName}-${Date.now()}`;
  }

  private async createRepositoryAnalysisBranchName(git: SimpleGit, repoFullName: string): Promise<string> {
    const baseBranchName = `openmeta/analyze-${slugify(repoFullName.replace(/\//g, '-')) || 'repo'}`;
    const localBranches = await git.branchLocal();
    if (!localBranches.all.includes(baseBranchName)) {
      return baseBranchName;
    }

    return `${baseBranchName}-${Date.now()}`;
  }

  private discoverFiles(root: string): string[] {
    const queue = [root];
    const files: string[] = [];

    while (queue.length > 0 && files.length < MAX_DISCOVERED_FILES) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) {
            queue.push(join(current, entry.name));
          }
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        files.push(normalizeRepoRelativePath(relative(root, join(current, entry.name))));
        if (files.length >= MAX_DISCOVERED_FILES) {
          break;
        }
      }
    }

    return files;
  }

  private rankCandidateFiles(issue: RankedIssue, memory: RepoMemory, files: string[]): string[] {
    const referencedPaths = this.extractReferencedPaths(`${issue.title}\n${issue.body}`);
    const keywords = `${issue.title} ${issue.analysis.coreDemand} ${issue.analysis.techRequirements.join(' ')}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3);

    return [...files].sort(
      (left, right) =>
        this.scorePath(right, keywords, memory, referencedPaths) -
        this.scorePath(left, keywords, memory, referencedPaths),
    );
  }

  private rankRepositoryAnalysisFiles(memory: RepoMemory, files: string[]): string[] {
    return [...files].sort(
      (left, right) => this.scoreRepositoryAnalysisPath(right, memory) - this.scoreRepositoryAnalysisPath(left, memory),
    );
  }

  private scoreRepositoryAnalysisPath(path: string, memory: RepoMemory): number {
    let score = 0;
    const lowerPath = path.toLowerCase();
    const fileName = basename(lowerPath);
    const pathSignal = (memory.pathSignals ?? []).find((signal) => signal.path === path);
    const recentIssue = (memory.recentIssues ?? []).find((issue) => issue.changedFiles.includes(path));

    if (memory.preferredPaths.some((candidate) => candidate === path)) {
      score += 60;
    }

    if (pathSignal) {
      score += pathSignal.candidateCount;
      score += pathSignal.changedCount * 6;
      score += pathSignal.successfulValidationCount * 10;
      score += pathSignal.publishedCount * 14;
    }

    if (recentIssue) {
      score += recentIssue.status === 'published' || recentIssue.status === 'pr_opened' ? 12 : 6;
    }

    if (fileName === 'readme.md') {
      score += 62;
    }

    if (['package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'makefile'].includes(fileName)) {
      score += 68;
    }

    if (/(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./.test(lowerPath)) {
      score += 34;
    }

    if (/\.(ts|tsx|js|jsx|py|go|rs|java|kt)$/.test(fileName)) {
      score += 28;
    }

    if (/\.(md|mdx)$/.test(fileName)) {
      score += 12;
    }

    if (/\.(png|jpg|jpeg|gif|webp|ico|svg|lock|map)$/.test(fileName)) {
      score -= 20;
    }

    if (lowerPath.includes('archive') || lowerPath.includes('vendor')) {
      score -= 12;
    }

    return score;
  }

  private scorePath(path: string, keywords: string[], memory: RepoMemory, referencedPaths: string[]): number {
    let score = 0;
    const lowerPath = path.toLowerCase();
    const pathSignals = memory.pathSignals ?? [];
    const recentIssues = memory.recentIssues ?? [];
    const pathSignal = pathSignals.find((signal) => signal.path === path);
    const recentIssue = recentIssues.find((issue) => issue.changedFiles.includes(path));

    for (const keyword of keywords) {
      if (lowerPath.includes(keyword)) {
        score += 5;
      }
    }

    if (memory.preferredPaths.some((candidate) => candidate === path)) {
      score += 12;
    }

    if (pathSignal) {
      score += pathSignal.candidateCount;
      score += pathSignal.changedCount * 6;
      score += pathSignal.successfulValidationCount * 10;
      score += pathSignal.publishedCount * 14;
    }

    if (recentIssue) {
      score += 6;

      if (recentIssue.status === 'published' || recentIssue.status === 'pr_opened') {
        score += 6;
      } else if (recentIssue.status === 'validated') {
        score += 3;
      }
    }

    for (const referencedPath of referencedPaths) {
      const lowerReferencedPath = referencedPath.toLowerCase();
      if (lowerPath.endsWith(lowerReferencedPath)) {
        score += 48;
        break;
      }

      if (lowerPath.includes(lowerReferencedPath) || basename(lowerPath) === basename(lowerReferencedPath)) {
        score += 24;
      }
    }

    const fileName = basename(path).toLowerCase();
    if (fileName === 'readme.md') {
      score += 6;
    }

    if (/\.(ts|tsx|js|jsx|py|go|rs|java|kt)$/.test(fileName)) {
      score += 4;
    }

    return score;
  }

  private readSnippet(path: string): string {
    try {
      const content = readFileSync(path, 'utf-8');
      return content.slice(0, MAX_SNIPPET_CHARS);
    } catch {
      return '';
    }
  }

  private extractReferencedPaths(content: string): string[] {
    const matches = content.matchAll(
      /(?:^|[\s`'"])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|md|css|scss))/gm,
    );
    return [
      ...new Set([...matches].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value))),
    ];
  }

  private detectTestCommands(workspacePath: string): TestCommand[] {
    const commands: TestCommand[] = [];
    const packageJsonPath = join(workspacePath, 'package.json');
    const cargoPath = join(workspacePath, 'Cargo.toml');
    const goModPath = join(workspacePath, 'go.mod');
    const pyprojectPath = join(workspacePath, 'pyproject.toml');
    const makefilePath = join(workspacePath, 'Makefile');

    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
          scripts?: Record<string, string>;
          packageManager?: string;
        };
        const scripts = packageJson.scripts ?? {};
        const scriptRunner = this.detectPackageScriptRunner(workspacePath, packageJson.packageManager);

        if (scripts['test'])
          commands.push({
            command: this.buildPackageScriptCommand(scriptRunner, 'test'),
            reason: `Detected package.json test script (${scriptRunner})`,
            source: 'repo-script',
          });
        if (scripts['lint'])
          commands.push({
            command: this.buildPackageScriptCommand(scriptRunner, 'lint'),
            reason: `Detected package.json lint script (${scriptRunner})`,
            source: 'repo-script',
          });
        if (scripts['typecheck'])
          commands.push({
            command: this.buildPackageScriptCommand(scriptRunner, 'typecheck'),
            reason: `Detected package.json typecheck script (${scriptRunner})`,
            source: 'repo-script',
          });
        if (scripts['build'])
          commands.push({
            command: this.buildPackageScriptCommand(scriptRunner, 'build'),
            reason: `Detected package.json build script (${scriptRunner})`,
            source: 'repo-script',
          });
      } catch (error) {
        logger.debug('Unable to parse package.json for test command detection', error);
      }
    }

    if (existsSync(cargoPath)) {
      commands.push({ command: 'cargo test', reason: 'Detected Cargo.toml', source: 'tool-default' });
    }

    if (existsSync(goModPath)) {
      commands.push({ command: 'go test ./...', reason: 'Detected go.mod', source: 'tool-default' });
    }

    if (existsSync(pyprojectPath)) {
      commands.push({ command: 'pytest', reason: 'Detected pyproject.toml', source: 'tool-default' });
    }

    if (existsSync(makefilePath)) {
      commands.push({ command: 'make test', reason: 'Detected Makefile', source: 'repo-script' });
    }

    return commands.filter(
      (item, index, list) => list.findIndex((candidate) => candidate.command === item.command) === index,
    );
  }

  private selectValidationCommands(
    commands: TestCommand[],
    executionMode: ExecutionMode,
  ): { commands: TestCommand[]; warnings: string[] } {
    if (executionMode !== 'headless') {
      return {
        commands: commands.slice(0, 3),
        warnings: [],
      };
    }

    const selected = commands.filter((command) => command.source === 'tool-default').slice(0, 3);
    const warnings = commands
      .filter((command) => command.source === 'repo-script')
      .map(
        (command) =>
          `Skipped ${command.command} during headless validation because it comes from repository-defined scripts.`,
      );

    return {
      commands: selected,
      warnings,
    };
  }

  private detectPackageScriptRunner(workspacePath: string, packageManager?: string): 'bun' | 'pnpm' | 'yarn' | 'npm' {
    const normalizedPackageManager = packageManager?.toLowerCase();
    if (normalizedPackageManager?.startsWith('bun@')) {
      return 'bun';
    }

    if (normalizedPackageManager?.startsWith('pnpm@')) {
      return 'pnpm';
    }

    if (normalizedPackageManager?.startsWith('yarn@')) {
      return 'yarn';
    }

    if (normalizedPackageManager?.startsWith('npm@')) {
      return 'npm';
    }

    if (existsSync(join(workspacePath, 'bun.lock')) || existsSync(join(workspacePath, 'bun.lockb'))) {
      return 'bun';
    }

    if (existsSync(join(workspacePath, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }

    if (existsSync(join(workspacePath, 'yarn.lock'))) {
      return 'yarn';
    }

    if (existsSync(join(workspacePath, 'package-lock.json'))) {
      return 'npm';
    }

    return 'bun';
  }

  private buildPackageScriptCommand(runner: 'bun' | 'pnpm' | 'yarn' | 'npm', scriptName: string): string {
    if (runner === 'yarn') {
      return `yarn ${scriptName}`;
    }

    return `${runner} run ${scriptName}`;
  }

  private runTestCommands(workspacePath: string, commands: TestCommand[]): TestResult[] {
    return commands.map((item) => {
      const toolDefault = this.resolveToolDefaultCommand(item);
      const result = toolDefault
        ? spawnSync(toolDefault.command, toolDefault.args, {
            cwd: workspacePath,
            encoding: 'utf-8',
            timeout: 120000,
          })
        : spawnSync(item.command, {
            cwd: workspacePath,
            encoding: 'utf-8',
            shell: true,
            timeout: 120000,
          });

      const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(0, 2000);
      return {
        command: item.command,
        exitCode: typeof result.status === 'number' ? result.status : null,
        passed: result.status === 0,
        output,
      };
    });
  }

  private resolveToolDefaultCommand(command: TestCommand): { command: string; args: string[] } | null {
    if (command.source !== 'tool-default') {
      return null;
    }

    switch (command.command) {
      case 'cargo test':
        return { command: 'cargo', args: ['test'] };
      case 'go test ./...':
        return { command: 'go', args: ['test', './...'] };
      case 'pytest':
        return { command: 'pytest', args: [] };
      default:
        return null;
    }
  }
}

export const workspaceService = new WorkspaceService();

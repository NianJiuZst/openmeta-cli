import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { PatchDraft, PullRequestDraft, RepositoryImprovementSuggestion } from '../contracts/index.js';
import {
  configService,
  ensureDirectory,
  getLocalDateStamp,
  getOpenMetaArtifactRoot,
  logger,
  parseGitHubRepoFullName,
  selectPrompt,
  ui,
} from '../infra/index.js';
import {
  contentService,
  githubService,
  llmService,
  memoryService,
  repositoryTargetingService,
  workspaceService,
} from '../services/index.js';
import type { AppConfig, RankedIssue, RepoMemory, RepoWorkspaceContext } from '../types/index.js';

export interface AnalyzeRunOptions {
  repo?: string;
  preset?: string;
  repoPath?: string;
  headless?: boolean;
  runChecks?: boolean;
  dryRun?: boolean;
}

interface AnalyzeArtifacts {
  artifactDir: string;
  analysisPath: string;
  patchDraftPath: string;
  prDraftPath: string;
}

interface AnalyzeResult {
  repoFullName: string;
  workspace: RepoWorkspaceContext;
  selectedSuggestion: RepositoryImprovementSuggestion;
  suggestions: RepositoryImprovementSuggestion[];
  patchDraft: PatchDraft;
  prDraft: PullRequestDraft;
  artifacts: AnalyzeArtifacts;
}

interface PresetAnalyzeGroup {
  repoFullName: string;
  workspace: RepoWorkspaceContext;
  memory: RepoMemory;
  suggestions: RepositoryImprovementSuggestion[];
}

interface PresetAnalyzeCandidate {
  repoFullName: string;
  workspace: RepoWorkspaceContext;
  memory: RepoMemory;
  suggestion: RepositoryImprovementSuggestion;
}

export class AnalyzeOrchestrator {
  async runMachine(options: AnalyzeRunOptions = {}): Promise<
    AnalyzeResult & {
      mode: {
        headless: boolean;
        runChecks: boolean;
        dryRun: boolean;
      };
    }
  > {
    const config = await configService.get();
    const scope = repositoryTargetingService.resolveScope(config, {
      repo: options.repo,
      preset: options.preset,
      allowGlobal: false,
    });

    if (scope.mode === 'none') {
      throw new Error('Repository analysis requires --repo, for example: openmeta analyze --repo owner/name.');
    }

    const headless = Boolean(options.headless);
    const runChecks = Boolean(options.runChecks);
    const dryRun = Boolean(options.dryRun);
    const repoPath = options.repoPath?.trim() || undefined;

    await this.validateConfig(config);
    await this.initializeClients(config);
    this.showLocalRepositoryHint(repoPath);

    const totalSteps = 7;
    const groups =
      scope.mode === 'single'
        ? [
            await this.collectSingleAnalysisGroup(scope.repo!, {
              headless,
              runChecks,
              repoPath,
              totalSteps,
            }),
          ]
        : await this.collectAnalysisGroups(scope.repos, {
            headless,
            runChecks,
            totalSteps,
          });
    const candidates = groups.flatMap((group) =>
      group.suggestions.map(
        (suggestion) =>
          ({
            repoFullName: group.repoFullName,
            workspace: group.workspace,
            memory: group.memory,
            suggestion,
          }) satisfies PresetAnalyzeCandidate,
      ),
    );
    const selectedCandidate = headless
      ? this.selectTopCandidate(candidates)
      : await this.promptForCandidate(candidates);
    const repoFullName = selectedCandidate.repoFullName;
    const workspace = selectedCandidate.workspace;
    const memory = selectedCandidate.memory;
    const selectedSuggestion = selectedCandidate.suggestion;
    const suggestions = groups.find((group) => group.repoFullName === repoFullName)?.suggestions || [
      selectedSuggestion,
    ];
    const syntheticIssue = this.buildSyntheticIssue(repoFullName, selectedSuggestion);

    await ui.task(
      {
        title: 'Selecting the strongest repository suggestion',
        doneMessage: 'Repository suggestion selected',
        failedMessage: 'Repository suggestion selection failed',
        tone: 'info',
        step: { index: 5, total: totalSteps },
      },
      async () => selectedSuggestion,
    );

    const patchDraftResult = await ui.task(
      {
        title: 'Drafting patch strategy for the selected suggestion',
        doneMessage: 'Patch strategy drafted',
        failedMessage: 'Patch strategy drafting failed',
        tone: 'info',
        step: { index: 6, total: totalSteps },
        heartbeat: {
          message: 'Still drafting patch strategy',
        },
      },
      async () => llmService.generatePatchDraft(syntheticIssue, workspace, memory),
    );
    const patchDraft = patchDraftResult.data;
    const prDraftResult = await ui.task(
      {
        title: 'Drafting pull request narrative for the selected suggestion',
        doneMessage: 'Pull request narrative drafted',
        failedMessage: 'Pull request narrative drafting failed',
        tone: 'info',
        step: { index: 7, total: totalSteps },
        heartbeat: {
          message: 'Still drafting pull request narrative',
        },
      },
      async () => llmService.generatePrDraft(syntheticIssue, patchDraft, workspace),
    );
    const prDraft = prDraftResult.data;

    const artifacts = this.prepareArtifactPaths(repoFullName, selectedSuggestion.id);
    const analysisMarkdown = contentService.formatRepositoryAnalysisMarkdown(
      repoFullName,
      workspace,
      suggestions,
      selectedSuggestion,
      scope.mode === 'preset'
        ? groups.map((group) => ({
            repoFullName: group.repoFullName,
            suggestions: group.suggestions,
          }))
        : undefined,
    );
    const patchDraftMarkdown = contentService.formatPatchDraftMarkdown(patchDraft);
    const prDraftMarkdown = contentService.formatPullRequestDraftMarkdown(prDraft);

    if (!dryRun) {
      this.writeLocalArtifacts({
        artifacts,
        analysisMarkdown,
        patchDraftMarkdown,
        prDraftMarkdown,
      });
    }

    return {
      repoFullName,
      workspace,
      selectedSuggestion,
      suggestions,
      patchDraft,
      prDraft,
      artifacts,
      mode: {
        headless,
        runChecks,
        dryRun,
      },
    };
  }

  async run(options: AnalyzeRunOptions = {}): Promise<void> {
    const result = await this.runMachine(options);
    const { repoFullName, mode, workspace, suggestions, selectedSuggestion, patchDraft, prDraft, artifacts } = result;
    const config = await configService.get();
    const scope = repositoryTargetingService.resolveScope(config, {
      repo: options.repo,
      preset: options.preset,
      allowGlobal: false,
    });
    const scopeLabel =
      scope.mode === 'single'
        ? scope.repo!
        : scope.presetName
          ? `preset ${scope.presetName}`
          : `${scope.repos.length} repositories`;

    ui.hero({
      label: 'OpenMeta Analyze',
      title: 'Find a contribution path even when the issue tracker is quiet',
      subtitle:
        'OpenMeta will inspect the repository, ask the model for grounded improvement ideas, and draft PR-ready artifacts for the strongest suggestion.',
      lines: [
        `Scope: ${scopeLabel}`,
        mode.runChecks
          ? 'Detected validation commands may run during workspace preparation.'
          : 'This analysis will skip baseline validation commands.',
        mode.headless
          ? 'Headless mode will select the highest-scoring suggestion automatically.'
          : 'You can choose which suggestion should become the draft target.',
      ],
    });

    if (scope.mode === 'single') {
      this.showWorkspaceSummary(workspace);
    } else {
      const candidates = suggestions.length;
      ui.stats('Preset analysis scope', [
        { label: 'Repositories', value: String(scope.repos.length), tone: 'success' },
        { label: 'Candidates', value: String(candidates), tone: 'info' },
        { label: 'Top score', value: String(selectedSuggestion.prPotentialScore), tone: 'accent' },
        { label: 'Preset', value: scope.presetName || 'custom', tone: 'info' },
      ]);
    }
    if (suggestions.length === 0) {
      ui.emptyState(
        'OpenMeta Analyze',
        'No repository suggestions generated',
        'The model did not find a grounded contribution path from the current repository context.',
      );
      return;
    }

    this.showSuggestions(suggestions);

    if (mode.dryRun) {
      ui.callout({
        label: 'OpenMeta Analyze',
        title: 'Dry-run artifact preview',
        subtitle: 'No repository analysis files were written.',
        lines: [artifacts.analysisPath, artifacts.patchDraftPath, artifacts.prDraftPath],
        tone: 'info',
      });
    }

    this.showResult({
      repoFullName,
      workspace,
      selectedSuggestion,
      suggestions,
      patchDraft,
      prDraft,
      artifacts,
    });
  }

  private showLocalRepositoryHint(repoPath?: string): void {
    if (repoPath) {
      const message = `Using local repository path via isolated worktree: ${repoPath}`;
      logger.info(message);
      ui.callout({
        label: 'OpenMeta Analyze',
        title: 'Local repository reuse enabled',
        subtitle:
          'OpenMeta will reuse the provided local repository through an isolated worktree, create a fresh branch, and keep PR work off your existing checkout.',
        lines: [`Path: ${repoPath}`],
        tone: 'info',
      });
      return;
    }

    const message =
      'Tip: if this repository already exists locally, pass --repo-path <local-path>. OpenMeta will reuse it via an isolated worktree, create a fresh branch, and open the PR from that branch.';
    logger.info(message);
    ui.callout({
      label: 'OpenMeta Analyze',
      title: 'Faster local reuse available',
      subtitle:
        'If the repository is already on disk, pass --repo-path <local-path>. OpenMeta will reuse it via an isolated worktree, create a fresh branch, and avoid another full local checkout.',
      tone: 'info',
    });
  }

  private async validateConfig(config: AppConfig): Promise<void> {
    if (!config.github.pat || !config.github.username) {
      throw new Error('GitHub configuration is incomplete. Please run "openmeta init" first.');
    }

    if (!config.llm.apiKey) {
      throw new Error('LLM API configuration is incomplete. Please run "openmeta init" first.');
    }
  }

  private async initializeClients(config: AppConfig): Promise<void> {
    githubService.initialize(config.github.pat, config.github.username);
    const ghValid = await ui.task(
      {
        title: 'Validating GitHub access',
        doneMessage: 'GitHub access verified',
        failedMessage: 'GitHub access failed',
        tone: 'info',
        step: { index: 1, total: 7 },
      },
      async () => {
        const valid = await githubService.validateCredentials();
        if (!valid) {
          throw new Error('GitHub validation failed');
        }
        return true;
      },
    );
    if (!ghValid) {
      throw new Error('GitHub credentials validation failed. Run "openmeta init" to refresh your token.');
    }
    llmService.initialize(
      config.llm.apiKey,
      config.llm.apiBaseUrl,
      config.llm.modelName,
      config.llm.apiHeaders,
      config.llm.provider,
      config.llm.reasoningEffort,
      config.llm.stream === true,
    );
    const llmValid = await ui.task(
      {
        title: 'Validating LLM provider',
        doneMessage: 'LLM provider verified',
        failedMessage: 'LLM provider failed',
        tone: 'info',
        step: { index: 2, total: 7 },
      },
      async () => {
        const valid = await llmService.validateConnection();
        if (!valid) {
          const detail = llmService.getLastValidationError();
          throw new Error(`LLM validation failed${detail ? `: ${detail}` : ''}`);
        }
        return true;
      },
    );
    if (!llmValid) {
      throw new Error('LLM API connection failed. Run "openmeta init" to update your provider settings.');
    }
  }

  private showWorkspaceSummary(workspace: RepoWorkspaceContext): void {
    ui.stats('Repository workspace', [
      { label: 'Candidate files', value: String(workspace.candidateFiles.length), tone: 'success' },
      {
        label: 'Detected checks',
        value: String(workspace.testCommands.length),
        tone: workspace.testCommands.length > 0 ? 'info' : 'muted',
      },
      {
        label: 'Runnable checks',
        value: String(workspace.validationCommands.length),
        tone: workspace.validationCommands.length > 0 ? 'accent' : 'muted',
      },
      {
        label: 'Dirty workspace',
        value: workspace.workspaceDirty ? 'YES' : 'NO',
        tone: workspace.workspaceDirty ? 'warning' : 'success',
      },
    ]);
    ui.keyValues('Repository context', [
      { label: 'Path', value: workspace.workspacePath, tone: 'info' },
      { label: 'Default branch', value: workspace.defaultBranch, tone: 'info' },
      { label: 'Analysis branch', value: workspace.branchName || 'workspace already dirty', tone: 'info' },
      { label: 'Candidate files', value: workspace.candidateFiles.slice(0, 8).join(', ') || 'n/a', tone: 'info' },
    ]);
  }

  private showSuggestions(suggestions: RepositoryImprovementSuggestion[]): void {
    ui.recordList(
      'Repository suggestions',
      suggestions.slice(0, 5).map((suggestion) => ({
        title: suggestion.title,
        subtitle: suggestion.summary,
        meta: [
          `score ${suggestion.prPotentialScore}`,
          `workload ${suggestion.estimatedWorkload}`,
          `id ${suggestion.id}`,
        ],
        lines: [
          `Files: ${suggestion.targetFiles.map((file) => file.path).join(', ')}`,
          `Validation: ${suggestion.validationPlan.join('; ') || 'not specified'}`,
        ],
        tone: suggestion.prPotentialScore >= 80 ? 'success' : 'info',
      })),
    );
  }

  private selectTopCandidate(candidates: PresetAnalyzeCandidate[]): PresetAnalyzeCandidate {
    const [selected] = [...candidates].sort(
      (left, right) => right.suggestion.prPotentialScore - left.suggestion.prPotentialScore,
    );
    if (!selected) {
      throw new Error('No repository suggestions are available to select.');
    }

    return selected;
  }

  private selectTopSuggestion(suggestions: RepositoryImprovementSuggestion[]): RepositoryImprovementSuggestion {
    const [selected] = [...suggestions].sort((left, right) => right.prPotentialScore - left.prPotentialScore);
    if (!selected) {
      throw new Error('No repository suggestions are available to select.');
    }

    return selected;
  }

  private async promptForSuggestion(
    suggestions: RepositoryImprovementSuggestion[],
  ): Promise<RepositoryImprovementSuggestion> {
    return selectPrompt<RepositoryImprovementSuggestion>({
      message: 'Select a repository suggestion to draft:',
      pageSize: Math.min(10, suggestions.length),
      choices: suggestions.slice(0, 5).map((suggestion) => ({
        name: suggestion.title,
        description: `score ${suggestion.prPotentialScore} | ${suggestion.summary.slice(0, 72)}`,
        value: suggestion,
      })),
    });
  }

  private async promptForCandidate(candidates: PresetAnalyzeCandidate[]): Promise<PresetAnalyzeCandidate> {
    if (candidates.length === 1) {
      return candidates[0]!;
    }

    return selectPrompt<PresetAnalyzeCandidate>({
      message: 'Select a repository suggestion to draft:',
      pageSize: Math.min(10, candidates.length),
      choices: candidates.slice(0, 10).map((candidate) => ({
        name: `${candidate.repoFullName} - ${candidate.suggestion.title}`,
        description: `score ${candidate.suggestion.prPotentialScore} | ${candidate.suggestion.summary.slice(0, 72)}`,
        value: candidate,
      })),
    });
  }

  private async collectSingleAnalysisGroup(
    repoFullName: string,
    options: {
      headless: boolean;
      runChecks: boolean;
      repoPath?: string;
      totalSteps: number;
    },
  ): Promise<PresetAnalyzeGroup> {
    const memory = memoryService.load(repoFullName);
    const workspace = await ui.task(
      {
        title: 'Preparing repository workspace',
        doneMessage: 'Repository workspace prepared',
        failedMessage: 'Repository workspace preparation failed',
        tone: 'info',
        step: { index: 3, total: options.totalSteps },
        heartbeat: {
          message: 'Still preparing repository workspace',
        },
      },
      async () =>
        workspaceService.prepareRepositoryWorkspace(
          repoFullName,
          memory,
          options.runChecks,
          options.headless ? 'headless' : 'interactive',
          options.repoPath,
        ),
    );

    const suggestionsResult = await ui.task(
      {
        title: 'Inspecting repository for grounded contribution ideas',
        doneMessage: 'Repository suggestions generated',
        failedMessage: 'Repository suggestion analysis failed',
        tone: 'info',
        step: { index: 4, total: options.totalSteps },
        heartbeat: {
          message: 'Still inspecting repository context',
        },
      },
      async () => llmService.analyzeRepository(repoFullName, workspace, memory),
    );

    return {
      repoFullName,
      workspace,
      memory,
      suggestions: suggestionsResult.data,
    };
  }

  private async collectAnalysisGroups(
    repos: string[],
    options: {
      headless: boolean;
      runChecks: boolean;
      totalSteps: number;
    },
  ): Promise<PresetAnalyzeGroup[]> {
    const groups: PresetAnalyzeGroup[] = [];

    for (const repoFullName of repos) {
      const memory = memoryService.load(repoFullName);
      const workspace = await ui.task(
        {
          title: `Preparing repository workspace for ${repoFullName}`,
          doneMessage: 'Repository workspace prepared',
          failedMessage: 'Repository workspace preparation failed',
          tone: 'info',
          step: { index: 3, total: options.totalSteps },
        },
        async () =>
          workspaceService.prepareRepositoryWorkspace(
            repoFullName,
            memory,
            options.runChecks,
            options.headless ? 'headless' : 'interactive',
          ),
      );

      const suggestionsResult = await ui.task(
        {
          title: `Analyzing repository contribution paths for ${repoFullName}`,
          doneMessage: 'Repository suggestions generated',
          failedMessage: 'Repository analysis failed',
          tone: 'info',
          step: { index: 4, total: options.totalSteps },
        },
        async () => llmService.analyzeRepository(repoFullName, workspace, memory),
      );

      groups.push({
        repoFullName,
        workspace,
        memory,
        suggestions: suggestionsResult.data,
      });
    }

    return groups;
  }

  private buildSyntheticIssue(repoFullName: string, suggestion: RepositoryImprovementSuggestion): RankedIssue {
    const now = new Date().toISOString();
    const repoName = repoFullName.split('/').at(-1) || repoFullName;

    return {
      id: 0,
      number: 0,
      title: suggestion.title,
      body: [
        suggestion.summary,
        '',
        suggestion.rationale,
        '',
        'Target files:',
        ...suggestion.targetFiles.map((file) => `- ${file.path}: ${file.reason}`),
        '',
        'Proposed changes:',
        ...suggestion.proposedChanges.map((change) => `- ${change}`),
        '',
        'Validation plan:',
        ...suggestion.validationPlan.map((step) => `- ${step}`),
      ].join('\n'),
      htmlUrl: `https://github.com/${repoFullName}`,
      repoName,
      repoFullName,
      repoDescription: 'Repository analysis suggestion generated by OpenMeta.',
      repoStars: 0,
      labels: ['openmeta-analysis'],
      createdAt: now,
      updatedAt: now,
      matchScore: suggestion.prPotentialScore,
      analysis: {
        coreDemand: suggestion.summary,
        techRequirements: suggestion.targetFiles.map((file) => file.path),
        solutionSuggestion: suggestion.proposedChanges.join(' '),
        estimatedWorkload: suggestion.estimatedWorkload,
      },
      opportunity: {
        score: suggestion.prPotentialScore,
        overallScore: suggestion.prPotentialScore,
        summary: suggestion.rationale,
        breakdown: {
          technicalFit: suggestion.prPotentialScore,
          freshness: 70,
          onboardingClarity: 70,
          mergePotential: suggestion.prPotentialScore,
          impact: suggestion.prPotentialScore,
        },
      },
    };
  }

  private prepareArtifactPaths(repoFullName: string, suggestionId: string): AnalyzeArtifacts {
    const dirName = `${repoFullName.replace(/\//g, '__')}__${suggestionId}`;
    const artifactDir = ensureDirectory(join(getOpenMetaArtifactRoot(), getLocalDateStamp(), 'analysis', dirName));
    return {
      artifactDir,
      analysisPath: join(artifactDir, 'repository-analysis.md'),
      patchDraftPath: join(artifactDir, 'patch-draft.md'),
      prDraftPath: join(artifactDir, 'pr-draft.md'),
    };
  }

  private writeLocalArtifacts(input: {
    artifacts: AnalyzeArtifacts;
    analysisMarkdown: string;
    patchDraftMarkdown: string;
    prDraftMarkdown: string;
  }): void {
    mkdirSync(input.artifacts.artifactDir, { recursive: true });
    writeFileSync(input.artifacts.analysisPath, input.analysisMarkdown, 'utf-8');
    writeFileSync(input.artifacts.patchDraftPath, input.patchDraftMarkdown, 'utf-8');
    writeFileSync(input.artifacts.prDraftPath, input.prDraftMarkdown, 'utf-8');
  }

  private showResult(result: AnalyzeResult): void {
    logger.success(`Repository analysis artifacts written to ${result.artifacts.artifactDir}`);
    ui.hero({
      label: 'OpenMeta Analyze',
      title: 'Repository analysis produced a contribution-ready draft',
      subtitle: 'The selected improvement now has analysis notes, a patch strategy, and a PR narrative saved locally.',
      lines: [
        `Repository: ${result.repoFullName}`,
        `Suggestion: ${result.selectedSuggestion.title}`,
        `Artifacts: ${result.artifacts.artifactDir}`,
      ],
      tone: 'success',
    });
    ui.keyValues('Analysis result', [
      { label: 'Workspace', value: result.workspace.workspacePath, tone: 'info' },
      { label: 'Patch goal', value: result.patchDraft.goal, tone: 'info' },
      { label: 'PR title', value: result.prDraft.title, tone: 'info' },
      { label: 'Analysis artifact', value: result.artifacts.analysisPath, tone: 'info' },
    ]);
  }
}

export const analyzeOrchestrator = new AnalyzeOrchestrator();

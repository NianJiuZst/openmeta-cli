import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as infra from '../src/infra/index.js';
import { AgentOrchestrator } from '../src/orchestration/agent.js';
import { AnalyzeOrchestrator } from '../src/orchestration/analyze.js';
import {
  contentService,
  inboxService,
  issueRankingService,
  llmService,
  memoryService,
  proofOfWorkService,
  workspaceService,
} from '../src/services/index.js';
import type { AppConfig, ContributionAgentResult, RankedIssue } from '../src/types/index.js';
import {
  createInboxItem,
  createMemory,
  createPatchDraft,
  createProofRecord,
  createPullRequestDraft,
  createRankedIssue,
  createRepositoryRules,
  createRepositorySuggestion,
  createWorkspace,
} from './helpers/factories.js';

interface AgentRunInternals {
  run(options?: {
    headless?: boolean;
    force?: boolean;
    schedulerRun?: boolean;
    runChecks?: boolean;
    draftOnly?: boolean;
    localArtifactsOnly?: boolean;
    refresh?: boolean;
    minStars?: number;
    maxStars?: number;
    repo?: string;
    preset?: string;
    allRepos?: boolean;
    repoPath?: string;
    issue?: string;
    dryRun?: boolean;
  }): Promise<void>;
  confirmManualHeadlessRun(config: AppConfig): Promise<void>;
  initializeClients(config: AppConfig, options?: { validateLlm?: boolean }): Promise<void>;
  promptForIssue(issues: RankedIssue[]): Promise<RankedIssue>;
  generateConcretePatch(
    issue: RankedIssue,
    workspace: ReturnType<typeof createWorkspace>,
    patchDraft: ReturnType<typeof createPatchDraft>,
    runChecks: boolean,
    draftOnly?: boolean,
  ): Promise<{
    changedFiles: string[];
    validationResults: ReturnType<typeof createWorkspace>['testResults'];
    reviewRequired: boolean;
  }>;
  submitContributionPullRequestIfPossible(input: unknown): Promise<{
    branchName?: string;
    url?: string;
    number?: number;
    changedFiles: string[];
    validationResults: ReturnType<typeof createWorkspace>['testResults'];
  }>;
  publishArtifactsIfNeeded(input: unknown): Promise<{ published: boolean }>;
  prepareLocalArtifactPaths(issue: RankedIssue): ContributionAgentResult['artifacts'];
  writeLocalArtifacts(input: unknown): void;
  showResult(result: ContributionAgentResult): void;
  showStructuredReviewNotice(input: { title: string; subtitle: string; lines?: string[] }): void;
  assessExecutionFeasibility(input: unknown): Promise<{
    assessment: { summary: string };
    shouldStop: boolean;
    effectiveDraftOnly: boolean;
    effectiveLocalArtifactsOnly: boolean;
    allowRealPr: boolean;
    skipReasons: string[];
  }>;
}

interface AnalyzeRunInternals {
  run(options: {
    repo?: string;
    preset?: string;
    repoPath?: string;
    headless?: boolean;
    runChecks?: boolean;
    dryRun?: boolean;
  }): Promise<void>;
  runMachine(options: {
    repo?: string;
    preset?: string;
    repoPath?: string;
    headless?: boolean;
    runChecks?: boolean;
    dryRun?: boolean;
  }): Promise<unknown>;
  initializeClients(config: AppConfig): Promise<void>;
  promptForCandidate<T>(candidates: T[]): Promise<T>;
  prepareArtifactPaths(
    repoFullName: string,
    suggestionId: string,
  ): {
    artifactDir: string;
    analysisPath: string;
    patchDraftPath: string;
    prDraftPath: string;
  };
  writeLocalArtifacts(input: unknown): void;
  showResult(input: unknown): void;
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    userProfile: {
      techStack: ['typescript', 'react'],
      proficiency: 'intermediate',
      focusAreas: ['frontend'],
    },
    github: {
      pat: 'ghp_test_token',
      username: 'octocat',
    },
    repositoryTargeting: {
      activePreset: '',
      presets: {},
    },
    llm: {
      provider: 'custom',
      apiBaseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      modelName: 'test-model',
      apiHeaders: {},
    },
    automation: {
      enabled: true,
      scheduleTime: '09:00',
      timezone: 'UTC',
      contentType: 'research_note',
      scheduler: 'manual',
      minMatchScore: 75,
      skipIfAlreadyGeneratedToday: false,
    },
    scoring: {
      weights: { freshness: 0.25, onboardingClarity: 0.25, mergePotential: 0.3, impact: 0.2, riskPenalty: 0.35 },
      overallWeights: { technicalMatch: 0.45, opportunityScore: 0.55 },
      preset: 'balanced',
    },
    commitTemplate: 'feat: {{title}}',
  };

  return {
    ...base,
    ...overrides,
    github: {
      ...base.github,
      ...overrides.github,
    },
    repositoryTargeting: {
      ...base.repositoryTargeting,
      ...overrides.repositoryTargeting,
      presets: {
        ...base.repositoryTargeting.presets,
        ...overrides.repositoryTargeting?.presets,
      },
    },
    llm: {
      ...base.llm,
      ...overrides.llm,
    },
    automation: {
      ...base.automation,
      ...overrides.automation,
    },
    scoring: {
      ...base.scoring,
      ...overrides.scoring,
      weights: {
        ...base.scoring.weights,
        ...overrides.scoring?.weights,
      },
      overallWeights: {
        ...base.scoring.overallWeights,
        ...overrides.scoring?.overallWeights,
      },
    },
  };
}

function createArtifacts(): ContributionAgentResult['artifacts'] {
  return {
    artifactDir: '/tmp/openmeta/artifacts',
    dossierPath: '/tmp/openmeta/artifacts/dossier.md',
    patchDraftPath: '/tmp/openmeta/artifacts/patch-draft.md',
    prDraftPath: '/tmp/openmeta/artifacts/pr-draft.md',
    memoryPath: '/tmp/openmeta/artifacts/repo-memory.md',
    inboxPath: '/tmp/openmeta/artifacts/inbox.md',
    proofOfWorkPath: '/tmp/openmeta/artifacts/proof-of-work.md',
  };
}

function muteUi(): void {
  spyOn(infra.ui, 'hero').mockImplementation(() => {});
  spyOn(infra.ui, 'stepper').mockImplementation(() => {});
  spyOn(infra.ui, 'section').mockImplementation(() => {});
  spyOn(infra.ui, 'recordList').mockImplementation(() => {});
  spyOn(infra.ui, 'card').mockImplementation(() => {});
  spyOn(infra.ui, 'stats').mockImplementation(() => {});
  spyOn(infra.ui, 'keyValues').mockImplementation(() => {});
  spyOn(infra.ui, 'callout').mockImplementation(() => {});
  spyOn(infra.ui, 'emptyState').mockImplementation(() => {});
  spyOn(infra.ui, 'banner').mockImplementation(() => {});
  spyOn(infra.ui, 'timeline').mockImplementation(() => {});
  spyOn(infra.ui, 'task').mockImplementation(async (_options, task) =>
    task({
      setMessage() {},
    } as never),
  );
}

beforeEach(() => {
  muteUi();
  spyOn(llmService, 'assessIssueFeasibility').mockResolvedValue({
    version: '1',
    kind: 'issue_feasibility_assessment',
    status: 'success',
    data: {
      decision: 'proceed',
      executionMode: 'full',
      confidence: 'high',
      summary: 'Test environment can execute the selected issue.',
      requiredCapabilities: ['typescript'],
      gaps: [],
      validationPlan: ['Run repository validation commands when requested.'],
      rationale: 'Unit tests mock feasibility as available unless the scenario overrides it.',
    },
  });
});

afterEach(() => {
  mock.restore();
});

describe('AgentOrchestrator run flow', () => {
  test('confirms manual headless runs before returning when no ranked issues are found', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
    const config = createConfig();
    const emptyStateSpy = spyOn(infra.ui, 'emptyState').mockImplementation(() => {});
    const confirmSpy = spyOn(
      orchestrator as object as { confirmManualHeadlessRun: AgentRunInternals['confirmManualHeadlessRun'] },
      'confirmManualHeadlessRun',
    ).mockResolvedValue(undefined);
    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([]);

    await orchestrator.run({ headless: true });

    expect(confirmSpy).toHaveBeenCalledWith(config);
    expect(emptyStateSpy).toHaveBeenCalledWith(
      'OpenMeta Agent',
      'No viable issues found',
      'No issues met the current technical match threshold. Broaden your profile or try again later.',
    );
  });

  test('skips manual headless confirmation when draft-only local artifact mode is requested', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
    const config = createConfig();
    const confirmSpy = spyOn(
      orchestrator as object as { confirmManualHeadlessRun: AgentRunInternals['confirmManualHeadlessRun'] },
      'confirmManualHeadlessRun',
    ).mockResolvedValue(undefined);

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([]);

    await orchestrator.run({
      headless: true,
      draftOnly: true,
      localArtifactsOnly: true,
    });

    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test('passes repository star ranges into issue discovery', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
    spyOn(infra.configService, 'get').mockResolvedValue(createConfig());
    spyOn(
      orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    const loadSpy = spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([]);

    await orchestrator.run({
      headless: true,
      schedulerRun: true,
      minStars: 100,
      maxStars: 500,
    });

    expect(loadSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ minStars: 100, maxStars: 500 }));
  });

  test('returns early when automation cannot select an issue above the threshold', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
    const issue = createRankedIssue();
    const emptyStateSpy = spyOn(infra.ui, 'emptyState').mockImplementation(() => {});
    spyOn(infra.configService, 'get').mockResolvedValue(createConfig());
    spyOn(
      orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([issue]);
    spyOn(issueRankingService, 'selectIssueForAutomation').mockReturnValue(undefined);

    await orchestrator.run({ headless: true, schedulerRun: true });

    expect(emptyStateSpy).toHaveBeenCalledWith(
      'OpenMeta Agent',
      'No issue met the automation threshold',
      'Top opportunities were below 75/100. Lower the threshold or widen your profile.',
    );
  });

  test('keeps the run in artifact mode when repository rules block automatic PR creation', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
    const calloutSpy = spyOn(infra.ui, 'callout').mockImplementation(() => {});

    const result = await orchestrator.submitContributionPullRequestIfPossible({
      config: createConfig(),
      allowRealPr: true,
      headless: true,
      issue: createRankedIssue(),
      prDraft: createPullRequestDraft(),
      workspace: createWorkspace({
        repositoryRules: createRepositoryRules({
          blockingRequirements: ['Repository requires an associated issue link before raising a PR.'],
        }),
      }),
      changedFiles: ['src/components/IconButton.tsx'],
      validationResults: [],
    });

    expect(result.url).toBeUndefined();
    expect(calloutSpy).toHaveBeenCalled();
    expect(result.reviewReason).toContain('issue linking');
  });

  test('blocks PR creation when repository requires prior discussion evidence and none is present', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;

    const result = await orchestrator.submitContributionPullRequestIfPossible({
      config: createConfig(),
      allowRealPr: true,
      headless: true,
      issue: createRankedIssue({ body: 'Bug report without maintainer discussion.' }),
      prDraft: createPullRequestDraft(),
      workspace: createWorkspace({
        repositoryRules: createRepositoryRules({
          requiredIssueLinking: undefined,
          requiredValidationNotes: [],
          requiredChecklistItems: [],
          requiresPriorDiscussion: true,
          requiredDiscussionEvidence: true,
        }),
      }),
      changedFiles: ['src/components/IconButton.tsx'],
      validationResults: [],
    });

    expect(result.url).toBeUndefined();
    expect(result.reviewReason).toContain('prior discussion');
  });

  test('blocks PR creation when repository requires issue linking and release notes that the draft does not provide', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;

    const result = await orchestrator.submitContributionPullRequestIfPossible({
      config: createConfig(),
      allowRealPr: true,
      headless: true,
      issue: createRankedIssue(),
      prDraft: createPullRequestDraft({
        body: '## Summary\n\nAccessibility fix only.',
        validation: ['bun test passed'],
      }),
      workspace: createWorkspace({
        repositoryRules: createRepositoryRules({
          requiredIssueLinking: 'Reference the GitHub issue in the PR body.',
          requiredReleaseNotes: true,
        }),
      }),
      changedFiles: ['src/components/IconButton.tsx'],
      validationResults: [{ command: 'bun test', exitCode: 0, passed: true, output: 'ok' }],
    });

    expect(result.url).toBeUndefined();
    expect(result.reviewReason).toContain('issue linking');
    expect(result.reviewReason).toContain('release note');
  });

  test('blocks PR creation when repository requires a conventional PR title and the draft title does not match', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;

    const result = await orchestrator.submitContributionPullRequestIfPossible({
      config: createConfig(),
      allowRealPr: true,
      headless: true,
      issue: createRankedIssue(),
      prDraft: createPullRequestDraft({
        title: 'Add aria-label handling to icon-only buttons',
      }),
      workspace: createWorkspace({
        repositoryRules: createRepositoryRules({
          prTitleRule: 'Use conventional commit style titles such as fix(scope): ...',
          requiredIssueLinking: undefined,
          requiredValidationNotes: [],
        }),
      }),
      changedFiles: ['src/components/IconButton.tsx'],
      validationResults: [],
    });

    expect(result.url).toBeUndefined();
    expect(result.reviewReason).toContain('PR title');
  });

  test('runs the full interactive flow and records a published outcome', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
    const config = createConfig();
    const issue = createRankedIssue({ repoFullName: 'acme/demo', number: 42 });
    const memory = createMemory();
    const workspace = createWorkspace({
      workspacePath: '/tmp/openmeta-demo',
      branchName: 'openmeta/42-accessibility',
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const validationResults = [{ command: 'bun test', exitCode: 0, passed: true, output: '1 passed' }];
    const artifacts = createArtifacts();
    const showResultSpy = spyOn(
      orchestrator as object as { showResult: AgentRunInternals['showResult'] },
      'showResult',
    ).mockImplementation(() => {});

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(
      orchestrator as object as { promptForIssue: AgentRunInternals['promptForIssue'] },
      'promptForIssue',
    ).mockResolvedValue(issue);
    spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([issue]);
    spyOn(memoryService, 'load').mockReturnValue(memory);
    spyOn(workspaceService, 'prepareWorkspace').mockResolvedValue(workspace);
    spyOn(memoryService, 'update').mockReturnValue(memory);
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: patchDraft,
    });
    spyOn(
      orchestrator as object as { generateConcretePatch: AgentRunInternals['generateConcretePatch'] },
      'generateConcretePatch',
    ).mockResolvedValue({
      changedFiles: ['src/app.ts'],
      validationResults,
      reviewRequired: false,
    });
    spyOn(llmService, 'generatePrDraft').mockResolvedValue({
      version: '1',
      kind: 'pull_request_draft',
      status: 'success',
      data: prDraft,
    });
    spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
    spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
    spyOn(contentService, 'formatContributionDossier').mockReturnValue('# Dossier');
    spyOn(
      orchestrator as object as {
        assessExecutionFeasibility: AgentRunInternals['assessExecutionFeasibility'];
      },
      'assessExecutionFeasibility',
    ).mockResolvedValue({
      assessment: { summary: 'Ready to proceed' },
      shouldStop: false,
      effectiveDraftOnly: false,
      effectiveLocalArtifactsOnly: false,
      allowRealPr: true,
      skipReasons: [],
    });
    spyOn(
      orchestrator as object as {
        submitContributionPullRequestIfPossible: AgentRunInternals['submitContributionPullRequestIfPossible'];
      },
      'submitContributionPullRequestIfPossible',
    ).mockResolvedValue({
      branchName: 'openmeta/agent-42',
      url: 'https://github.com/acme/demo/pull/42',
      number: 42,
      changedFiles: ['src/app.ts'],
      validationResults,
    });
    spyOn(
      orchestrator as object as { prepareLocalArtifactPaths: AgentRunInternals['prepareLocalArtifactPaths'] },
      'prepareLocalArtifactPaths',
    ).mockReturnValue(artifacts);
    spyOn(
      orchestrator as object as { writeLocalArtifacts: AgentRunInternals['writeLocalArtifacts'] },
      'writeLocalArtifacts',
    ).mockImplementation(() => {});
    spyOn(
      orchestrator as object as { publishArtifactsIfNeeded: AgentRunInternals['publishArtifactsIfNeeded'] },
      'publishArtifactsIfNeeded',
    ).mockResolvedValue({
      published: true,
    });
    spyOn(inboxService, 'saveItem').mockReturnValue([createInboxItem()]);
    spyOn(inboxService, 'renderMarkdown').mockReturnValue('# Inbox');
    spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
    spyOn(proofOfWorkService, 'renderMarkdown').mockReturnValue('# Proof');
    spyOn(proofOfWorkService, 'record').mockReturnValue([createProofRecord()]);
    spyOn(memoryService, 'renderMarkdown').mockReturnValue('# Memory');
    spyOn(memoryService, 'recordOutcome').mockReturnValue(memory);
    spyOn(
      orchestrator as object as {
        assessExecutionFeasibility: AgentRunInternals['assessExecutionFeasibility'];
      },
      'assessExecutionFeasibility',
    ).mockResolvedValue({
      assessment: { summary: 'Ready to proceed' },
      shouldStop: false,
      effectiveDraftOnly: false,
      effectiveLocalArtifactsOnly: false,
      allowRealPr: true,
      skipReasons: [],
    });

    await orchestrator.run();

    expect(showResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        issue,
        workspace: expect.objectContaining({ workspacePath: workspace.workspacePath }),
        patchDraft,
        prDraft,
        pullRequestUrl: 'https://github.com/acme/demo/pull/42',
        changedFiles: ['src/app.ts'],
      }),
    );
  });

  test('runs against an explicitly targeted issue without discovery selection', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
    const config = createConfig();
    const issue = createRankedIssue({
      repoFullName: 'Wei-Shaw/sub2api',
      repoName: 'sub2api',
      number: 3014,
    });
    const memory = createMemory({ repoFullName: 'Wei-Shaw/sub2api' });
    const workspace = createWorkspace({
      workspacePath: '/tmp/openmeta-sub2api',
      branchName: 'openmeta/3014-openai-compat',
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const artifacts = createArtifacts();
    const showResultSpy = spyOn(
      orchestrator as object as { showResult: AgentRunInternals['showResult'] },
      'showResult',
    ).mockImplementation(() => {});
    const loadTargetIssueSpy = spyOn(issueRankingService, 'loadTargetIssue').mockResolvedValue([issue]);
    const loadRankedIssuesSpy = spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([]);
    const promptForIssueSpy = spyOn(
      orchestrator as object as { promptForIssue: AgentRunInternals['promptForIssue'] },
      'promptForIssue',
    ).mockResolvedValue(issue);

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(memoryService, 'load').mockReturnValue(memory);
    spyOn(workspaceService, 'prepareWorkspace').mockResolvedValue(workspace);
    spyOn(memoryService, 'update').mockReturnValue(memory);
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: patchDraft,
    });
    spyOn(
      orchestrator as object as { generateConcretePatch: AgentRunInternals['generateConcretePatch'] },
      'generateConcretePatch',
    ).mockResolvedValue({
      changedFiles: ['src/openai.ts'],
      validationResults: [],
      reviewRequired: false,
    });
    spyOn(llmService, 'generatePrDraft').mockResolvedValue({
      version: '1',
      kind: 'pull_request_draft',
      status: 'success',
      data: prDraft,
    });
    spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
    spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
    spyOn(contentService, 'formatContributionDossier').mockReturnValue('# Dossier');
    spyOn(
      orchestrator as object as {
        submitContributionPullRequestIfPossible: AgentRunInternals['submitContributionPullRequestIfPossible'];
      },
      'submitContributionPullRequestIfPossible',
    ).mockResolvedValue({
      branchName: 'openmeta/agent-3014',
      url: 'https://github.com/Wei-Shaw/sub2api/pull/3015',
      number: 3015,
      changedFiles: ['src/openai.ts'],
      validationResults: [],
    });
    spyOn(
      orchestrator as object as { prepareLocalArtifactPaths: AgentRunInternals['prepareLocalArtifactPaths'] },
      'prepareLocalArtifactPaths',
    ).mockReturnValue(artifacts);
    spyOn(
      orchestrator as object as { writeLocalArtifacts: AgentRunInternals['writeLocalArtifacts'] },
      'writeLocalArtifacts',
    ).mockImplementation(() => {});
    spyOn(
      orchestrator as object as { publishArtifactsIfNeeded: AgentRunInternals['publishArtifactsIfNeeded'] },
      'publishArtifactsIfNeeded',
    ).mockResolvedValue({
      published: false,
    });
    spyOn(inboxService, 'saveItem').mockReturnValue([createInboxItem()]);
    spyOn(inboxService, 'renderMarkdown').mockReturnValue('# Inbox');
    spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
    spyOn(proofOfWorkService, 'renderMarkdown').mockReturnValue('# Proof');
    spyOn(proofOfWorkService, 'record').mockReturnValue([createProofRecord()]);
    spyOn(memoryService, 'renderMarkdown').mockReturnValue('# Memory');
    spyOn(memoryService, 'recordOutcome').mockReturnValue(memory);
    spyOn(
      orchestrator as object as {
        assessExecutionFeasibility: AgentRunInternals['assessExecutionFeasibility'];
      },
      'assessExecutionFeasibility',
    ).mockResolvedValue({
      assessment: { summary: 'Ready to proceed' },
      shouldStop: false,
      effectiveDraftOnly: false,
      effectiveLocalArtifactsOnly: false,
      allowRealPr: true,
      skipReasons: [],
    });

    await orchestrator.run({ issue: 'https://github.com/Wei-Shaw/sub2api/issues/3014' });

    expect(loadTargetIssueSpy).toHaveBeenCalledWith(config, {
      repoFullName: 'Wei-Shaw/sub2api',
      issueNumber: 3014,
    });
    expect(loadRankedIssuesSpy).not.toHaveBeenCalled();
    expect(promptForIssueSpy).not.toHaveBeenCalled();
    expect(showResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        issue,
        pullRequestUrl: 'https://github.com/Wei-Shaw/sub2api/pull/3015',
        changedFiles: ['src/openai.ts'],
      }),
    );
  });

  test('uses the active preset for scout discovery and falls back to repository analysis when no issue clears the threshold', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
    const baseAutomation = createConfig().automation;
    const config = createConfig({
      repositoryTargeting: {
        activePreset: 'frontend',
        presets: {
          frontend: {
            repos: ['vercel/next.js', 'facebook/react'],
          },
        },
      },
      automation: {
        ...baseAutomation,
        minMatchScore: 95,
      },
    });
    const weakIssue = createRankedIssue({
      repoFullName: 'vercel/next.js',
      opportunity: {
        score: 72,
        overallScore: 74,
        summary: 'Below threshold',
        breakdown: {
          technicalFit: 70,
          freshness: 70,
          onboardingClarity: 72,
          mergePotential: 74,
          impact: 76,
        },
      },
    });
    const nextWorkspace = createWorkspace({
      workspacePath: '/tmp/openmeta-nextjs',
      branchName: 'openmeta/analyze-vercel-next-js',
      candidateFiles: ['README.md'],
    });
    const reactWorkspace = createWorkspace({
      workspacePath: '/tmp/openmeta-react',
      branchName: 'openmeta/analyze-facebook-react',
      candidateFiles: ['packages/react/index.js'],
    });
    const nextMemory = createMemory({ repoFullName: 'vercel/next.js' });
    const reactMemory = createMemory({ repoFullName: 'facebook/react' });
    const selectedSuggestion = createRepositorySuggestion({
      id: 'next-analysis',
      title: 'Tighten next config validation',
      prPotentialScore: 97,
      targetFiles: [{ path: 'packages/next/src/server/config.ts', reason: 'Validation logic' }],
    });
    const lowerSuggestion = createRepositorySuggestion({
      id: 'react-analysis',
      title: 'Document react packaging edge case',
      prPotentialScore: 81,
      targetFiles: [{ path: 'packages/react/README.md', reason: 'Docs' }],
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const artifacts = createArtifacts();
    const showResultSpy = spyOn(
      orchestrator as object as { showResult: AgentRunInternals['showResult'] },
      'showResult',
    ).mockImplementation(() => {});
    const loadRankedIssuesSpy = spyOn(issueRankingService, 'loadRankedIssues')
      .mockResolvedValueOnce([weakIssue])
      .mockResolvedValueOnce([]);

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(memoryService, 'load').mockReturnValueOnce(nextMemory).mockReturnValueOnce(reactMemory);
    spyOn(workspaceService, 'prepareRepositoryWorkspace')
      .mockResolvedValueOnce(nextWorkspace)
      .mockResolvedValueOnce(reactWorkspace);
    spyOn(llmService, 'analyzeRepository')
      .mockResolvedValueOnce({
        version: '1',
        kind: 'repository_suggestion_list',
        status: 'success',
        data: [selectedSuggestion],
      })
      .mockResolvedValueOnce({
        version: '1',
        kind: 'repository_suggestion_list',
        status: 'success',
        data: [lowerSuggestion],
      });
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: patchDraft,
    });
    spyOn(
      orchestrator as object as { generateConcretePatch: AgentRunInternals['generateConcretePatch'] },
      'generateConcretePatch',
    ).mockResolvedValue({
      changedFiles: ['packages/next/src/server/config.ts'],
      validationResults: [],
      reviewRequired: false,
    });
    spyOn(llmService, 'generatePrDraft').mockResolvedValue({
      version: '1',
      kind: 'pull_request_draft',
      status: 'success',
      data: prDraft,
    });
    spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
    spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
    spyOn(contentService, 'formatContributionDossier').mockReturnValue('# Dossier');
    spyOn(
      orchestrator as object as {
        submitContributionPullRequestIfPossible: AgentRunInternals['submitContributionPullRequestIfPossible'];
      },
      'submitContributionPullRequestIfPossible',
    ).mockResolvedValue({
      changedFiles: ['packages/next/src/server/config.ts'],
      validationResults: [],
    });
    spyOn(
      orchestrator as object as { prepareLocalArtifactPaths: AgentRunInternals['prepareLocalArtifactPaths'] },
      'prepareLocalArtifactPaths',
    ).mockReturnValue(artifacts);
    spyOn(
      orchestrator as object as { writeLocalArtifacts: AgentRunInternals['writeLocalArtifacts'] },
      'writeLocalArtifacts',
    ).mockImplementation(() => {});
    spyOn(
      orchestrator as object as { publishArtifactsIfNeeded: AgentRunInternals['publishArtifactsIfNeeded'] },
      'publishArtifactsIfNeeded',
    ).mockResolvedValue({
      published: false,
    });
    spyOn(inboxService, 'saveItem').mockReturnValue([createInboxItem()]);
    spyOn(inboxService, 'renderMarkdown').mockReturnValue('# Inbox');
    spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
    spyOn(proofOfWorkService, 'renderMarkdown').mockReturnValue('# Proof');
    spyOn(proofOfWorkService, 'record').mockReturnValue([createProofRecord()]);
    spyOn(memoryService, 'renderMarkdown').mockReturnValue('# Memory');
    spyOn(memoryService, 'recordOutcome').mockReturnValue(nextMemory);
    spyOn(
      orchestrator as object as {
        assessExecutionFeasibility: AgentRunInternals['assessExecutionFeasibility'];
      },
      'assessExecutionFeasibility',
    ).mockResolvedValue({
      assessment: { summary: 'Ready to proceed' },
      shouldStop: false,
      effectiveDraftOnly: false,
      effectiveLocalArtifactsOnly: false,
      allowRealPr: true,
      skipReasons: [],
    });

    await orchestrator.run();

    expect(loadRankedIssuesSpy).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        repoFullName: 'vercel/next.js',
      }),
    );
    expect(workspaceService.prepareRepositoryWorkspace).toHaveBeenCalledTimes(2);
    expect(llmService.generatePatchDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'vercel/next.js',
        title: 'Tighten next config validation',
      }),
      nextWorkspace,
      nextMemory,
    );
    expect(showResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: expect.objectContaining({
          repoFullName: 'vercel/next.js',
          number: 0,
        }),
        changedFiles: ['packages/next/src/server/config.ts'],
      }),
    );
  });

  test('uses feasibility-adjusted scores before falling back from preset issue flow', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
    const config = createConfig({
      repositoryTargeting: {
        activePreset: 'frontend',
        presets: {
          frontend: {
            repos: ['vercel/next.js', 'facebook/react'],
          },
        },
      },
    });
    const rawHigherIssue = createRankedIssue({
      repoFullName: 'vercel/next.js',
      repoName: 'next.js',
      number: 11,
      opportunity: {
        score: 74,
        overallScore: 74,
        summary: 'Raw score is higher but adjusted below threshold',
        breakdown: {
          technicalFit: 78,
          freshness: 76,
          onboardingClarity: 74,
          mergePotential: 72,
          impact: 70,
        },
      },
      scoutFeasibility: {
        level: 'likely_fixable',
        issueScope: 'small_code_change',
        repoRisks: [],
        issueRisks: [],
        missingLocalCapabilities: ['docker'],
        mitigations: [],
        confidence: 'medium',
        scoreAdjustment: -4,
        adjustedOverallScore: 70,
        explanation: 'Docker is missing but the issue can still be inspected statically.',
      },
    });
    const adjustedQualifiedIssue = createRankedIssue({
      repoFullName: 'facebook/react',
      repoName: 'react',
      number: 12,
      title: 'Fix TypeScript docs generation guard',
      opportunity: {
        score: 73,
        overallScore: 73,
        summary: 'Raw score is below threshold but local feasibility raises it',
        breakdown: {
          technicalFit: 82,
          freshness: 78,
          onboardingClarity: 76,
          mergePotential: 72,
          impact: 66,
        },
      },
      scoutFeasibility: {
        level: 'ready',
        issueScope: 'small_code_change',
        repoRisks: [],
        issueRisks: [],
        missingLocalCapabilities: [],
        mitigations: [],
        confidence: 'high',
        scoreAdjustment: 3,
        adjustedOverallScore: 76,
        explanation: 'Local TypeScript tooling is available.',
      },
    });
    const memory = createMemory({ repoFullName: 'facebook/react' });
    const workspace = createWorkspace({
      workspacePath: '/tmp/openmeta-react',
      branchName: 'openmeta/12-typescript-docs-generation',
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const artifacts = createArtifacts();
    const promptForIssueSpy = spyOn(
      orchestrator as object as { promptForIssue: AgentRunInternals['promptForIssue'] },
      'promptForIssue',
    ).mockResolvedValue(adjustedQualifiedIssue);
    const prepareWorkspaceSpy = spyOn(workspaceService, 'prepareWorkspace').mockResolvedValue(workspace);
    const prepareRepositoryWorkspaceSpy = spyOn(workspaceService, 'prepareRepositoryWorkspace').mockRejectedValue(
      new Error('preset repository-analysis fallback should not run'),
    );
    const showResultSpy = spyOn(
      orchestrator as object as { showResult: AgentRunInternals['showResult'] },
      'showResult',
    ).mockImplementation(() => {});

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(issueRankingService, 'loadRankedIssues')
      .mockResolvedValueOnce([rawHigherIssue])
      .mockResolvedValueOnce([adjustedQualifiedIssue]);
    spyOn(memoryService, 'load').mockReturnValue(memory);
    spyOn(memoryService, 'update').mockReturnValue(memory);
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: patchDraft,
    });
    spyOn(
      orchestrator as object as { generateConcretePatch: AgentRunInternals['generateConcretePatch'] },
      'generateConcretePatch',
    ).mockResolvedValue({
      changedFiles: ['packages/react/src/docs.ts'],
      validationResults: [],
      reviewRequired: false,
    });
    spyOn(llmService, 'generatePrDraft').mockResolvedValue({
      version: '1',
      kind: 'pull_request_draft',
      status: 'success',
      data: prDraft,
    });
    spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
    spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
    spyOn(contentService, 'formatContributionDossier').mockReturnValue('# Dossier');
    spyOn(
      orchestrator as object as {
        submitContributionPullRequestIfPossible: AgentRunInternals['submitContributionPullRequestIfPossible'];
      },
      'submitContributionPullRequestIfPossible',
    ).mockResolvedValue({
      changedFiles: ['packages/react/src/docs.ts'],
      validationResults: [],
    });
    spyOn(
      orchestrator as object as { prepareLocalArtifactPaths: AgentRunInternals['prepareLocalArtifactPaths'] },
      'prepareLocalArtifactPaths',
    ).mockReturnValue(artifacts);
    spyOn(
      orchestrator as object as { writeLocalArtifacts: AgentRunInternals['writeLocalArtifacts'] },
      'writeLocalArtifacts',
    ).mockImplementation(() => {});
    spyOn(
      orchestrator as object as { publishArtifactsIfNeeded: AgentRunInternals['publishArtifactsIfNeeded'] },
      'publishArtifactsIfNeeded',
    ).mockResolvedValue({
      published: false,
    });
    spyOn(inboxService, 'saveItem').mockReturnValue([createInboxItem()]);
    spyOn(inboxService, 'renderMarkdown').mockReturnValue('# Inbox');
    spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
    spyOn(proofOfWorkService, 'renderMarkdown').mockReturnValue('# Proof');
    spyOn(proofOfWorkService, 'record').mockReturnValue([createProofRecord()]);
    spyOn(memoryService, 'renderMarkdown').mockReturnValue('# Memory');
    spyOn(memoryService, 'recordOutcome').mockReturnValue(memory);
    spyOn(
      orchestrator as object as {
        assessExecutionFeasibility: AgentRunInternals['assessExecutionFeasibility'];
      },
      'assessExecutionFeasibility',
    ).mockResolvedValue({
      assessment: { summary: 'Ready to proceed' },
      shouldStop: false,
      effectiveDraftOnly: false,
      effectiveLocalArtifactsOnly: false,
      allowRealPr: true,
      skipReasons: [],
    });

    await orchestrator.run();

    expect(promptForIssueSpy).toHaveBeenCalledWith(expect.arrayContaining([adjustedQualifiedIssue]));
    expect(prepareWorkspaceSpy).toHaveBeenCalledWith(adjustedQualifiedIssue, memory, true, 'interactive', undefined);
    expect(prepareRepositoryWorkspaceSpy).not.toHaveBeenCalled();
    expect(showResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: adjustedQualifiedIssue,
        changedFiles: ['packages/react/src/docs.ts'],
      }),
    );
  });

  test('keeps the run in review mode when patch and PR drafts require review', async () => {
    const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
    const issue = createRankedIssue();
    const memory = createMemory();
    const workspace = createWorkspace({
      testResults: [],
    });
    const patchDraft = createPatchDraft({ goal: 'Needs review goal' });
    const prDraft = createPullRequestDraft({ title: 'Needs review title' });
    const reviewNoticeSpy = spyOn(
      orchestrator as object as { showStructuredReviewNotice: AgentRunInternals['showStructuredReviewNotice'] },
      'showStructuredReviewNotice',
    ).mockImplementation(() => {});
    const generateConcretePatchSpy = spyOn(
      orchestrator as object as { generateConcretePatch: AgentRunInternals['generateConcretePatch'] },
      'generateConcretePatch',
    ).mockResolvedValue({
      changedFiles: [],
      validationResults: [],
      reviewRequired: false,
    });

    spyOn(infra.configService, 'get').mockResolvedValue(createConfig());
    spyOn(
      orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(
      orchestrator as object as { promptForIssue: AgentRunInternals['promptForIssue'] },
      'promptForIssue',
    ).mockResolvedValue(issue);
    spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([issue]);
    spyOn(memoryService, 'load').mockReturnValue(memory);
    spyOn(workspaceService, 'prepareWorkspace').mockResolvedValue(workspace);
    spyOn(memoryService, 'update').mockReturnValue(memory);
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'needs_review',
      data: patchDraft,
    });
    spyOn(llmService, 'generatePrDraft').mockResolvedValue({
      version: '1',
      kind: 'pull_request_draft',
      status: 'needs_review',
      data: prDraft,
    });
    spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
    spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
    spyOn(contentService, 'formatContributionDossier').mockReturnValue('# Dossier');
    spyOn(
      orchestrator as object as {
        submitContributionPullRequestIfPossible: AgentRunInternals['submitContributionPullRequestIfPossible'];
      },
      'submitContributionPullRequestIfPossible',
    ).mockResolvedValue({
      changedFiles: [],
      validationResults: [],
    });
    spyOn(
      orchestrator as object as { prepareLocalArtifactPaths: AgentRunInternals['prepareLocalArtifactPaths'] },
      'prepareLocalArtifactPaths',
    ).mockReturnValue(createArtifacts());
    spyOn(
      orchestrator as object as { writeLocalArtifacts: AgentRunInternals['writeLocalArtifacts'] },
      'writeLocalArtifacts',
    ).mockImplementation(() => {});
    spyOn(
      orchestrator as object as { publishArtifactsIfNeeded: AgentRunInternals['publishArtifactsIfNeeded'] },
      'publishArtifactsIfNeeded',
    ).mockResolvedValue({
      published: false,
    });
    spyOn(inboxService, 'saveItem').mockReturnValue([createInboxItem()]);
    spyOn(inboxService, 'renderMarkdown').mockReturnValue('# Inbox');
    spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
    spyOn(proofOfWorkService, 'renderMarkdown').mockReturnValue('# Proof');
    spyOn(proofOfWorkService, 'record').mockReturnValue([createProofRecord()]);
    spyOn(memoryService, 'renderMarkdown').mockReturnValue('# Memory');
    const recordOutcomeSpy = spyOn(memoryService, 'recordOutcome').mockReturnValue(memory);
    spyOn(
      orchestrator as object as {
        assessExecutionFeasibility: AgentRunInternals['assessExecutionFeasibility'];
      },
      'assessExecutionFeasibility',
    ).mockResolvedValue({
      assessment: { summary: 'Ready to proceed' },
      shouldStop: false,
      effectiveDraftOnly: false,
      effectiveLocalArtifactsOnly: false,
      allowRealPr: true,
      skipReasons: [],
    });
    const showResultSpy = spyOn(
      orchestrator as object as { showResult: AgentRunInternals['showResult'] },
      'showResult',
    ).mockImplementation(() => {});

    await orchestrator.run();

    expect(generateConcretePatchSpy).not.toHaveBeenCalled();
    expect(reviewNoticeSpy).toHaveBeenCalledTimes(2);
    expect(recordOutcomeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        published: false,
        reviewRequired: true,
      }),
    );
    expect(showResultSpy).toHaveBeenCalled();
  });
});

describe('AnalyzeOrchestrator run flow', () => {
  test('analyzes a repository, selects the top suggestion in headless mode, and writes draft artifacts', async () => {
    const orchestrator = new AnalyzeOrchestrator() as unknown as AnalyzeRunInternals;
    const config = createConfig();
    const workspace = createWorkspace({
      workspacePath: '/tmp/openmeta-demo',
      branchName: 'openmeta/analyze-acme-demo',
      candidateFiles: ['README.md', 'src/index.ts'],
    });
    const memory = createMemory({ repoFullName: 'acme/demo' });
    const topSuggestion = createRepositorySuggestion({
      id: 'config-validation',
      title: 'Add config validation tests',
      summary: 'Cover malformed provider config normalization.',
      targetFiles: [{ path: 'src/infra/config.ts', reason: 'Normalization logic' }],
      prPotentialScore: 93,
    });
    const lowerSuggestion = createRepositorySuggestion({
      id: 'docs-install',
      title: 'Document local install',
      prPotentialScore: 75,
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const artifacts = {
      artifactDir: '/tmp/openmeta/artifacts/analyze',
      analysisPath: '/tmp/openmeta/artifacts/analyze/repository-analysis.md',
      patchDraftPath: '/tmp/openmeta/artifacts/analyze/patch-draft.md',
      prDraftPath: '/tmp/openmeta/artifacts/analyze/pr-draft.md',
    };
    const writeArtifactsSpy = spyOn(
      orchestrator as object as { writeLocalArtifacts: AnalyzeRunInternals['writeLocalArtifacts'] },
      'writeLocalArtifacts',
    ).mockImplementation(() => {});
    const showResultSpy = spyOn(
      orchestrator as object as { showResult: AnalyzeRunInternals['showResult'] },
      'showResult',
    ).mockImplementation(() => {});
    const promptForCandidateSpy = spyOn(
      orchestrator as object as { promptForCandidate: AnalyzeRunInternals['promptForCandidate'] },
      'promptForCandidate',
    ).mockResolvedValue(lowerSuggestion);

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as object as { initializeClients: AnalyzeRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(memoryService, 'load').mockReturnValue(memory);
    spyOn(workspaceService, 'prepareRepositoryWorkspace').mockResolvedValue(workspace);
    spyOn(llmService, 'analyzeRepository').mockResolvedValue({
      version: '1',
      kind: 'repository_suggestion_list',
      status: 'success',
      data: [lowerSuggestion, topSuggestion],
    });
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: patchDraft,
    });
    spyOn(llmService, 'generatePrDraft').mockResolvedValue({
      version: '1',
      kind: 'pull_request_draft',
      status: 'success',
      data: prDraft,
    });
    spyOn(contentService, 'formatRepositoryAnalysisMarkdown').mockReturnValue('# Repository Analysis');
    spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
    spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
    spyOn(
      orchestrator as object as { prepareArtifactPaths: AnalyzeRunInternals['prepareArtifactPaths'] },
      'prepareArtifactPaths',
    ).mockReturnValue(artifacts);

    await orchestrator.run({ repo: 'https://github.com/acme/demo', headless: true });

    expect(promptForCandidateSpy).not.toHaveBeenCalled();
    expect(workspaceService.prepareRepositoryWorkspace).toHaveBeenCalledWith(
      'acme/demo',
      memory,
      false,
      'headless',
      undefined,
    );
    expect(llmService.generatePatchDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'acme/demo',
        number: 0,
        title: 'Add config validation tests',
        analysis: expect.objectContaining({
          coreDemand: 'Cover malformed provider config normalization.',
        }),
      }),
      workspace,
      memory,
    );
    expect(writeArtifactsSpy).toHaveBeenCalledWith({
      artifacts,
      analysisMarkdown: '# Repository Analysis',
      patchDraftMarkdown: '# Patch',
      prDraftMarkdown: '# PR',
    });
    expect(showResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'acme/demo',
        selectedSuggestion: topSuggestion,
        artifacts,
      }),
    );
  });

  test('analyzes repositories from the active preset and picks the strongest cross-repo suggestion', async () => {
    const orchestrator = new AnalyzeOrchestrator() as unknown as AnalyzeRunInternals;
    const config = createConfig({
      repositoryTargeting: {
        activePreset: 'frontend',
        presets: {
          frontend: {
            repos: ['acme/demo', 'acme/docs'],
          },
        },
      },
    });
    const demoWorkspace = createWorkspace({
      workspacePath: '/tmp/openmeta-demo',
      branchName: 'openmeta/analyze-acme-demo',
      candidateFiles: ['README.md'],
    });
    const docsWorkspace = createWorkspace({
      workspacePath: '/tmp/openmeta-docs',
      branchName: 'openmeta/analyze-acme-docs',
      candidateFiles: ['docs/setup.md'],
    });
    const demoMemory = createMemory({ repoFullName: 'acme/demo' });
    const docsMemory = createMemory({ repoFullName: 'acme/docs' });
    const demoSuggestion = createRepositorySuggestion({
      id: 'demo-high',
      title: 'Add runtime config guard',
      prPotentialScore: 96,
      targetFiles: [{ path: 'src/config.ts', reason: 'Guard invalid config' }],
    });
    const docsSuggestion = createRepositorySuggestion({
      id: 'docs-lower',
      title: 'Clarify setup docs',
      prPotentialScore: 78,
      targetFiles: [{ path: 'docs/setup.md', reason: 'Onboarding docs' }],
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const artifacts = {
      artifactDir: '/tmp/openmeta/artifacts/preset-analyze',
      analysisPath: '/tmp/openmeta/artifacts/preset-analyze/repository-analysis.md',
      patchDraftPath: '/tmp/openmeta/artifacts/preset-analyze/patch-draft.md',
      prDraftPath: '/tmp/openmeta/artifacts/preset-analyze/pr-draft.md',
    };
    const writeArtifactsSpy = spyOn(
      orchestrator as object as { writeLocalArtifacts: AnalyzeRunInternals['writeLocalArtifacts'] },
      'writeLocalArtifacts',
    ).mockImplementation(() => {});
    const showResultSpy = spyOn(
      orchestrator as object as { showResult: AnalyzeRunInternals['showResult'] },
      'showResult',
    ).mockImplementation(() => {});
    const analysisMarkdownSpy = spyOn(contentService, 'formatRepositoryAnalysisMarkdown').mockReturnValue(
      '# Repository Analysis',
    );

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as object as { initializeClients: AnalyzeRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(memoryService, 'load').mockReturnValueOnce(demoMemory).mockReturnValueOnce(docsMemory);
    spyOn(workspaceService, 'prepareRepositoryWorkspace')
      .mockResolvedValueOnce(demoWorkspace)
      .mockResolvedValueOnce(docsWorkspace);
    spyOn(llmService, 'analyzeRepository')
      .mockResolvedValueOnce({
        version: '1',
        kind: 'repository_suggestion_list',
        status: 'success',
        data: [demoSuggestion],
      })
      .mockResolvedValueOnce({
        version: '1',
        kind: 'repository_suggestion_list',
        status: 'success',
        data: [docsSuggestion],
      });
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: patchDraft,
    });
    spyOn(llmService, 'generatePrDraft').mockResolvedValue({
      version: '1',
      kind: 'pull_request_draft',
      status: 'success',
      data: prDraft,
    });
    spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
    spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
    spyOn(
      orchestrator as object as { prepareArtifactPaths: AnalyzeRunInternals['prepareArtifactPaths'] },
      'prepareArtifactPaths',
    ).mockReturnValue(artifacts);

    await orchestrator.run({ headless: true });

    expect(workspaceService.prepareRepositoryWorkspace).toHaveBeenCalledTimes(2);
    expect(llmService.generatePatchDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'acme/demo',
        title: 'Add runtime config guard',
      }),
      demoWorkspace,
      demoMemory,
    );
    expect(analysisMarkdownSpy).toHaveBeenCalledWith('acme/demo', demoWorkspace, [demoSuggestion], demoSuggestion, [
      { repoFullName: 'acme/demo', suggestions: [demoSuggestion] },
      { repoFullName: 'acme/docs', suggestions: [docsSuggestion] },
    ]);
    expect(writeArtifactsSpy).toHaveBeenCalledWith({
      artifacts,
      analysisMarkdown: '# Repository Analysis',
      patchDraftMarkdown: '# Patch',
      prDraftMarkdown: '# PR',
    });
    expect(showResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'acme/demo',
        selectedSuggestion: demoSuggestion,
        artifacts,
      }),
    );
  });

  test('passes repoPath through repository analysis workflow', async () => {
    const orchestrator = new AnalyzeOrchestrator() as unknown as AnalyzeRunInternals;
    const config = createConfig();
    const workspace = createWorkspace({
      workspacePath: '/tmp/openmeta-analysis-worktree',
      branchName: 'openmeta/analyze-acme-demo',
    });
    const memory = createMemory({ repoFullName: 'acme/demo' });
    const suggestion = createRepositorySuggestion({
      id: 'config-validation',
      title: 'Add config validation tests',
      prPotentialScore: 93,
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as object as { initializeClients: AnalyzeRunInternals['initializeClients'] },
      'initializeClients',
    ).mockResolvedValue(undefined);
    spyOn(memoryService, 'load').mockReturnValue(memory);
    const prepareSpy = spyOn(workspaceService, 'prepareRepositoryWorkspace').mockResolvedValue(workspace);
    spyOn(llmService, 'analyzeRepository').mockResolvedValue({
      version: '1',
      kind: 'repository_suggestion_list',
      status: 'success',
      data: [suggestion],
    });
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: patchDraft,
    });
    spyOn(llmService, 'generatePrDraft').mockResolvedValue({
      version: '1',
      kind: 'pull_request_draft',
      status: 'success',
      data: prDraft,
    });
    spyOn(contentService, 'formatRepositoryAnalysisMarkdown').mockReturnValue('# Repository Analysis');
    spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
    spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
    spyOn(
      orchestrator as object as { prepareArtifactPaths: AnalyzeRunInternals['prepareArtifactPaths'] },
      'prepareArtifactPaths',
    ).mockReturnValue({
      artifactDir: '/tmp/openmeta/artifacts/analyze',
      analysisPath: '/tmp/openmeta/artifacts/analyze/repository-analysis.md',
      patchDraftPath: '/tmp/openmeta/artifacts/analyze/patch-draft.md',
      prDraftPath: '/tmp/openmeta/artifacts/analyze/pr-draft.md',
    });
    spyOn(
      orchestrator as object as { writeLocalArtifacts: AnalyzeRunInternals['writeLocalArtifacts'] },
      'writeLocalArtifacts',
    ).mockImplementation(() => {});
    spyOn(orchestrator as object as { showResult: AnalyzeRunInternals['showResult'] }, 'showResult').mockImplementation(
      () => {},
    );

    await orchestrator.run({
      repo: 'acme/demo',
      repoPath: '/Users/example/src/demo',
      headless: true,
    });

    expect(prepareSpy).toHaveBeenCalledWith('acme/demo', memory, false, 'headless', '/Users/example/src/demo');
  });
});

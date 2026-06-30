import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { runInMachineContext } from '../src/infra/execution-context.js';
import * as infra from '../src/infra/index.js';
import type { MachineAgentResult } from '../src/orchestration/agent.js';
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
import type { AppConfig } from '../src/types/index.js';
import {
  createInboxItem,
  createMemory,
  createPatchDraft,
  createProofRecord,
  createPullRequestDraft,
  createRankedIssue,
  createRepositorySuggestion,
  createWorkspace,
} from './helpers/factories.js';

interface AgentMachineInternals {
  validateConfig(config: unknown, options?: unknown): Promise<void>;
  initializeClients(config: unknown, options?: unknown): Promise<void>;
  generateConcretePatch(
    issue: unknown,
    workspace: unknown,
    patchDraft: unknown,
    runChecks: boolean,
    draftOnly?: boolean,
  ): Promise<{
    changedFiles: string[];
    validationResults: unknown[];
    reviewRequired: boolean;
    implementationAttempts?: number;
    implementationStopReason?: string;
    implementationContextFilesAdded?: number;
  }>;
  submitContributionPullRequestIfPossible(input: unknown): Promise<{
    changedFiles: string[];
    validationResults: unknown[];
    url?: string;
    number?: number;
    reviewReason?: string;
  }>;
  prepareLocalArtifactPaths(issue: unknown): ReturnType<typeof createArtifacts>;
  writeLocalArtifacts(input: unknown): void;
  publishArtifactsIfNeeded(input: unknown): Promise<{ published: boolean }>;
}

interface AgentMachineRunShape {
  runMachine(options?: {
    headless?: boolean;
    force?: boolean;
    schedulerRun?: boolean;
    runChecks?: boolean;
    draftOnly?: boolean;
    localArtifactsOnly?: boolean;
    refresh?: boolean;
    repo?: string;
    issue?: string;
    dryRun?: boolean;
  }): Promise<MachineAgentResult>;
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
      weights: {
        freshness: 0.25,
        onboardingClarity: 0.25,
        mergePotential: 0.3,
        impact: 0.2,
        riskPenalty: 0.35,
      },
      overallWeights: {
        technicalMatch: 0.45,
        opportunityScore: 0.55,
      },
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

function createArtifacts() {
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

describe('machine flow result builders', () => {
  test('machine analyze emits stage progress to stderr during long-running phases', async () => {
    mock.restore();
    const config = createConfig();
    const workspace = createWorkspace({
      workspacePath: '/tmp/openmeta-machine-progress',
      branchName: 'openmeta/analyze-machine-progress',
      candidateFiles: ['README.md', 'src/index.ts'],
    });
    const memory = createMemory({ repoFullName: 'acme/demo' });
    const suggestion = createRepositorySuggestion({
      id: 'machine-progress',
      title: 'Surface machine progress',
      summary: 'Make long-running analysis stages visible to host tools.',
      targetFiles: [{ path: 'src/infra/ui/live.ts', reason: 'Machine progress rendering' }],
      prPotentialScore: 91,
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const stderrWrites: string[] = [];
    const orchestrator = new AnalyzeOrchestrator();

    spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(orchestrator as AnalyzeOrchestrator, 'validateConfig' as never).mockResolvedValue(undefined);
    spyOn(orchestrator as AnalyzeOrchestrator, 'initializeClients' as never).mockResolvedValue(undefined);
    spyOn(memoryService, 'load').mockReturnValue(memory);
    spyOn(workspaceService, 'prepareRepositoryWorkspace').mockResolvedValue(workspace);
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

    await runInMachineContext(() =>
      orchestrator.runMachine({
        repo: 'acme/demo',
        headless: true,
        dryRun: true,
      }),
    );

    const combined = stderrWrites.join('');
    expect(combined).toContain('--repo-path <local-path>');
    expect(combined).toContain('Step 3/7 Preparing repository workspace');
    expect(combined).toContain('Step 4/7 Inspecting repository for grounded contribution ideas');
    expect(combined).toContain('Inspecting repository for grounded contribution ideas');
    expect(combined).toContain('Selecting the strongest repository suggestion');
    expect(combined).toContain('Drafting patch strategy for the selected suggestion');
    expect(combined).toContain('Drafting pull request narrative for the selected suggestion');
  });

  test('machine scout returns ranked opportunities with mode metadata', async () => {
    const config = createConfig();
    const issue = createRankedIssue();
    const orchestrator = new AgentOrchestrator();

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(orchestrator as AgentOrchestrator, 'validateConfig' as never).mockResolvedValue(undefined);
    spyOn(orchestrator as AgentOrchestrator, 'initializeClients' as never).mockResolvedValue(undefined);
    spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([issue]);

    const result = await orchestrator.scoutMachine({ limit: 5, refresh: true });

    expect(result.mode.refresh).toBe(true);
    expect(result.opportunities).toEqual([issue]);
  });

  test('machine scout validates config and initializes clients before ranking', async () => {
    const config = createConfig();
    const issue = createRankedIssue();
    const orchestrator = new AgentOrchestrator();
    const validateSpy = spyOn(orchestrator as AgentOrchestrator, 'validateConfig' as never).mockResolvedValue(
      undefined,
    );
    const initializeSpy = spyOn(orchestrator as AgentOrchestrator, 'initializeClients' as never).mockResolvedValue(
      undefined,
    );

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([issue]);

    const result = await orchestrator.scoutMachine({ limit: 3 });

    expect(validateSpy).toHaveBeenCalledWith(config);
    expect(initializeSpy).toHaveBeenCalled();
    expect(result.opportunities).toEqual([issue]);
  });

  test('machine scout returns an actionable empty explanation when no issues survive the filters', async () => {
    const config = createConfig();
    const orchestrator = new AgentOrchestrator();

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(orchestrator as AgentOrchestrator, 'validateConfig' as never).mockResolvedValue(undefined);
    spyOn(orchestrator as AgentOrchestrator, 'initializeClients' as never).mockResolvedValue(undefined);
    spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([]);

    const result = await orchestrator.scoutMachine();

    expect(result.opportunities).toEqual([]);
    expect(result.emptyExplanation).toEqual(
      expect.objectContaining({
        title: 'No issues cleared the current filters',
      }),
    );
    expect(result.emptyExplanation?.detail).toContain('75/100 threshold');
    expect(result.emptyExplanation?.suggestions[0]).toContain('Lower automation.minMatchScore');
    expect(result.nextActions).toEqual(['broaden_profile_filters']);
  });

  test('machine analyze returns selected suggestion and artifact paths', async () => {
    const config = createConfig();
    const workspace = createWorkspace({
      workspacePath: '/tmp/openmeta-demo',
      branchName: 'openmeta/analyze-acme-demo',
      candidateFiles: ['README.md', 'src/index.ts'],
    });
    const memory = createMemory({ repoFullName: 'acme/demo' });
    const suggestion = createRepositorySuggestion({
      id: 'config-validation',
      title: 'Add config validation tests',
      summary: 'Cover malformed provider config normalization.',
      targetFiles: [{ path: 'src/infra/config.ts', reason: 'Normalization logic' }],
      prPotentialScore: 93,
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const orchestrator = new AnalyzeOrchestrator();

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(orchestrator as AnalyzeOrchestrator, 'validateConfig' as never).mockResolvedValue(undefined);
    spyOn(orchestrator as AnalyzeOrchestrator, 'initializeClients' as never).mockResolvedValue(undefined);
    spyOn(memoryService, 'load').mockReturnValue(memory);
    spyOn(workspaceService, 'prepareRepositoryWorkspace').mockResolvedValue(workspace);
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

    const result = await orchestrator.runMachine({ repo: 'acme/demo', dryRun: true, headless: true });

    expect(result.repoFullName).toBe('acme/demo');
    expect(result.selectedSuggestion).toEqual(suggestion);
    expect(result.artifacts.analysisPath).toContain('analysis');
    expect(result.mode.dryRun).toBe(true);
  });

  test('machine agent draft-only flow returns explicit execution flags', async () => {
    const config = createConfig();
    const issue = createRankedIssue({ repoFullName: 'acme/demo', number: 42 });
    const memory = createMemory();
    const workspace = createWorkspace({
      workspacePath: '/tmp/openmeta-demo',
      branchName: 'openmeta/42-accessibility',
      testResults: [],
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const artifacts = createArtifacts();
    const orchestrator = new AgentOrchestrator() as unknown as AgentMachineRunShape;
    const machineInternals = orchestrator as unknown as AgentMachineInternals;

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(machineInternals, 'validateConfig').mockResolvedValue(undefined);
    spyOn(machineInternals, 'initializeClients').mockResolvedValue(undefined);
    spyOn(issueRankingService, 'loadTargetIssue').mockResolvedValue([issue]);
    spyOn(memoryService, 'load').mockReturnValue(memory);
    spyOn(workspaceService, 'prepareWorkspace').mockResolvedValue(workspace);
    spyOn(memoryService, 'update').mockReturnValue(memory);
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: patchDraft,
    });
    spyOn(machineInternals, 'generateConcretePatch').mockResolvedValue({
      changedFiles: [],
      validationResults: [],
      reviewRequired: false,
      implementationAttempts: 0,
      implementationStopReason: 'draft_only',
      implementationContextFilesAdded: 0,
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
    spyOn(machineInternals, 'submitContributionPullRequestIfPossible').mockResolvedValue({
      changedFiles: [],
      validationResults: [],
    });
    spyOn(machineInternals, 'prepareLocalArtifactPaths').mockReturnValue(artifacts);
    const writeArtifactsSpy = spyOn(machineInternals, 'writeLocalArtifacts').mockImplementation(() => {});
    const publishSpy = spyOn(machineInternals, 'publishArtifactsIfNeeded').mockResolvedValue({
      published: false,
    });
    const saveInboxSpy = spyOn(inboxService, 'saveItem').mockReturnValue([createInboxItem()]);
    spyOn(inboxService, 'renderMarkdown').mockReturnValue('# Inbox');
    spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
    spyOn(proofOfWorkService, 'renderMarkdown').mockReturnValue('# Proof');
    const recordProofSpy = spyOn(proofOfWorkService, 'record').mockReturnValue([createProofRecord()]);
    spyOn(memoryService, 'renderMarkdown').mockReturnValue('# Memory');
    const recordOutcomeSpy = spyOn(memoryService, 'recordOutcome').mockReturnValue(memory);

    const result = await runInMachineContext(() =>
      orchestrator.runMachine({
        issue: 'https://github.com/acme/demo/issues/42',
        draftOnly: true,
        dryRun: true,
      }),
    );

    expect(result.executionOutcome).toBe('draft_only');
    expect(result.repoMutated).toBe(false);
    expect(result.prCreated).toBe(false);
    expect(result.artifactsWritten).toBe(false);
    expect(result.executionPolicy.headless).toBe(true);
    expect(result.implementationAttempts).toBe(0);
    expect(result.implementationStopReason).toBe('draft_only');
    expect(result.implementationContextFilesAdded).toBe(0);
    expect(writeArtifactsSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(saveInboxSpy).not.toHaveBeenCalled();
    expect(recordProofSpy).not.toHaveBeenCalled();
    expect(recordOutcomeSpy).not.toHaveBeenCalled();
  }, 10000);

  test('machine agent preset flow honors feasibility-adjusted threshold scores', async () => {
    const config = {
      ...createConfig(),
      repositoryTargeting: {
        activePreset: 'frontend',
        presets: {
          frontend: {
            repos: ['facebook/react'],
          },
        },
      },
    };
    const issue = createRankedIssue({
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
      testResults: [],
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const artifacts = createArtifacts();
    const orchestrator = new AgentOrchestrator() as unknown as AgentMachineRunShape;
    const machineInternals = orchestrator as unknown as AgentMachineInternals;

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(machineInternals, 'validateConfig').mockResolvedValue(undefined);
    spyOn(machineInternals, 'initializeClients').mockResolvedValue(undefined);
    spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([issue]);
    spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
    spyOn(memoryService, 'load').mockReturnValue(memory);
    spyOn(memoryService, 'update').mockReturnValue(memory);
    const prepareWorkspaceSpy = spyOn(workspaceService, 'prepareWorkspace').mockResolvedValue(workspace);
    const prepareRepositoryWorkspaceSpy = spyOn(workspaceService, 'prepareRepositoryWorkspace').mockRejectedValue(
      new Error('preset repository-analysis fallback should not run'),
    );
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: patchDraft,
    });
    spyOn(machineInternals, 'generateConcretePatch').mockResolvedValue({
      changedFiles: ['packages/react/src/docs.ts'],
      validationResults: [],
      reviewRequired: false,
      implementationAttempts: 2,
      implementationStopReason: 'applied',
      implementationContextFilesAdded: 3,
    });
    spyOn(llmService, 'generatePrDraft').mockResolvedValue({
      version: '1',
      kind: 'pull_request_draft',
      status: 'success',
      data: prDraft,
    });
    spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
    spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
    spyOn(machineInternals, 'submitContributionPullRequestIfPossible').mockResolvedValue({
      changedFiles: ['packages/react/src/docs.ts'],
      validationResults: [],
    });
    spyOn(machineInternals, 'prepareLocalArtifactPaths').mockReturnValue(artifacts);

    const result = await orchestrator.runMachine({ dryRun: true });

    expect(result.issue).toBe(issue);
    expect(result.executionOutcome).toBe('changes_applied');
    expect(result.implementationAttempts).toBe(2);
    expect(result.implementationStopReason).toBe('applied');
    expect(result.implementationContextFilesAdded).toBe(3);
    expect(result.executionPolicy.headless).toBe(true);
    expect(prepareWorkspaceSpy).toHaveBeenCalledWith(issue, memory, false, 'headless', undefined);
    expect(prepareRepositoryWorkspaceSpy).not.toHaveBeenCalled();
  });

  test('machine agent can write local artifacts without publish prompts', async () => {
    const config = createConfig();
    const issue = createRankedIssue({ repoFullName: 'acme/demo', number: 42 });
    const memory = createMemory();
    const workspace = createWorkspace({
      workspacePath: '/tmp/openmeta-demo',
      branchName: 'openmeta/42-accessibility',
      testResults: [],
    });
    const patchDraft = createPatchDraft();
    const prDraft = createPullRequestDraft();
    const artifacts = createArtifacts();
    const orchestrator = new AgentOrchestrator() as unknown as AgentMachineRunShape;
    const machineInternals = orchestrator as unknown as AgentMachineInternals;

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(machineInternals, 'validateConfig').mockResolvedValue(undefined);
    spyOn(machineInternals, 'initializeClients').mockResolvedValue(undefined);
    spyOn(issueRankingService, 'loadTargetIssue').mockResolvedValue([issue]);
    spyOn(memoryService, 'load').mockReturnValue(memory);
    spyOn(workspaceService, 'prepareWorkspace').mockResolvedValue(workspace);
    spyOn(memoryService, 'update').mockReturnValue(memory);
    spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: patchDraft,
    });
    spyOn(machineInternals, 'generateConcretePatch').mockResolvedValue({
      changedFiles: [],
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
    spyOn(machineInternals, 'submitContributionPullRequestIfPossible').mockResolvedValue({
      changedFiles: [],
      validationResults: [],
    });
    spyOn(machineInternals, 'prepareLocalArtifactPaths').mockReturnValue(artifacts);
    const writeArtifactsSpy = spyOn(machineInternals, 'writeLocalArtifacts').mockImplementation(() => {});
    const publishSpy = spyOn(machineInternals, 'publishArtifactsIfNeeded').mockResolvedValue({
      published: false,
    });
    const promptSpy = spyOn(infra, 'prompt');
    const saveInboxSpy = spyOn(inboxService, 'saveItem').mockReturnValue([createInboxItem()]);
    spyOn(inboxService, 'renderMarkdown').mockReturnValue('# Inbox');
    spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
    spyOn(proofOfWorkService, 'renderMarkdown').mockReturnValue('# Proof');
    const recordProofSpy = spyOn(proofOfWorkService, 'record').mockReturnValue([createProofRecord()]);
    spyOn(memoryService, 'renderMarkdown').mockReturnValue('# Memory');
    const recordOutcomeSpy = spyOn(memoryService, 'recordOutcome').mockReturnValue(memory);

    const result = await runInMachineContext(() =>
      orchestrator.runMachine({
        issue: 'https://github.com/acme/demo/issues/42',
        draftOnly: true,
        localArtifactsOnly: true,
      }),
    );

    expect(result.executionOutcome).toBe('local_artifacts_written');
    expect(result.repoMutated).toBe(false);
    expect(result.prCreated).toBe(false);
    expect(result.artifactsWritten).toBe(true);
    expect(result.published).toBe(false);
    expect(result.executionPolicy.headless).toBe(true);
    expect(writeArtifactsSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(saveInboxSpy).toHaveBeenCalledTimes(1);
    expect(recordProofSpy).toHaveBeenCalledTimes(1);
    expect(recordOutcomeSpy).toHaveBeenCalledTimes(1);
  });
});

import { Octokit } from '@octokit/rest';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { type SimpleGit, simpleGit } from 'simple-git';
import type {
  IssueFeasibilityAssessment,
  PatchDraft,
  PullRequestDraft,
  RepositoryImprovementSuggestion,
} from '../contracts/index.js';
import {
  configService,
  ensureDirectory,
  getLocalDateStamp,
  getOpenMetaArtifactRoot,
  isUserCancelledError,
  logger,
  parseGitHubRepoFullName,
  prompt,
  resolveGitHubIssueTarget,
  selectPrompt,
  ui,
} from '../infra/index.js';
import {
  contentService,
  contributionPrService,
  githubService,
  gitService,
  inboxService,
  issueRankingService,
  llmService,
  memoryService,
  permissionPolicyService,
  proofOfWorkService,
  repositoryTargetingService,
  workspaceService,
} from '../services/index.js';
import type {
  AppConfig,
  ContributionAgentResult,
  RankedIssue,
  RepoFileSnippet,
  RepoMemory,
  RepoWorkspaceContext,
  TestResult,
} from '../types/index.js';

export interface AgentRunOptions {
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
}

export interface ScoutRunOptions {
  limit?: number;
  refresh?: boolean;
  minStars?: number;
  maxStars?: number;
  repo?: string;
  preset?: string;
  allRepos?: boolean;
}

export interface MachineScoutResult {
  opportunities: RankedIssue[];
  mode: {
    limit: number;
    refresh: boolean;
    repo?: string;
    minStars?: number;
    maxStars?: number;
  };
  emptyExplanation?: {
    title: string;
    detail: string;
    suggestions: string[];
  };
  nextActions: string[];
}

export interface MachineAgentResult {
  issue: RankedIssue;
  workspace: RepoWorkspaceContext;
  patchDraft: PatchDraft;
  prDraft: PullRequestDraft;
  artifacts: ContributionAgentResult['artifacts'];
  changedFiles: string[];
  validationResults: TestResult[];
  reviewRequired: boolean;
  implementationAttempts?: number;
  implementationStopReason?:
    | 'draft_only'
    | 'dirty_workspace'
    | 'no_new_context'
    | 'max_attempts'
    | 'implementation_requires_review'
    | 'no_changes'
    | 'apply_review_required'
    | 'no_effective_change'
    | 'applied'
    | 'generation_failed';
  implementationContextFilesAdded?: number;
  published: boolean;
  prCreated: boolean;
  repoMutated: boolean;
  artifactsWritten: boolean;
  executionOutcome: 'draft_only' | 'local_artifacts_written' | 'changes_applied' | 'pr_opened' | 'blocked';
  executionPolicy: {
    headless: boolean;
    draftOnly: boolean;
    localArtifactsOnly: boolean;
    runChecks: boolean;
    dryRun: boolean;
    refresh: boolean;
    minStars?: number;
    maxStars?: number;
  };
  skipReasons: string[];
  nextActions: string[];
  pullRequestUrl?: string;
  pullRequestNumber?: number;
}

interface TargetRepoContext {
  path: string;
  owner: string;
  repo: string;
  defaultBranch: string;
}

interface ContributionPullRequestResult {
  branchName?: string;
  url?: string;
  number?: number;
  changedFiles: string[];
  validationResults: TestResult[];
}

interface ConcretePatchResult {
  changedFiles: string[];
  validationResults: TestResult[];
  reviewRequired: boolean;
  implementationAttempts?: number;
  implementationStopReason?:
    | 'draft_only'
    | 'dirty_workspace'
    | 'no_new_context'
    | 'max_attempts'
    | 'implementation_requires_review'
    | 'no_changes'
    | 'apply_review_required'
    | 'no_effective_change'
    | 'applied'
    | 'generation_failed';
  implementationContextFilesAdded?: number;
}

interface FeasibilityPolicy {
  assessment: IssueFeasibilityAssessment;
  shouldStop: boolean;
  effectiveDraftOnly: boolean;
  effectiveLocalArtifactsOnly: boolean;
  allowRealPr: boolean;
  skipReasons: string[];
}

interface PresetAnalyzeCandidate {
  repoFullName: string;
  workspace: RepoWorkspaceContext;
  memory: RepoMemory;
  suggestion: RepositoryImprovementSuggestion;
}

type AgentStageId = 'scout' | 'select' | 'prepare' | 'draft' | 'validate' | 'pr' | 'publish';
const ARTIFACT_PUBLISH_BRANCH = 'openmeta-artifacts';
const MAX_IMPLEMENTATION_ATTEMPTS = 3;
const MAX_IMPLEMENTATION_EXPANSION_FILES = 8;

const AGENT_STAGES: Array<{ id: AgentStageId; label: string; description: string }> = [
  {
    id: 'scout',
    label: 'Scout opportunities',
    description: 'Validate providers and rank candidate issues.',
  },
  {
    id: 'select',
    label: 'Select target',
    description: 'Choose the issue worth drafting now.',
  },
  {
    id: 'prepare',
    label: 'Prepare workspace',
    description: 'Clone, inspect files, and load repository memory.',
  },
  {
    id: 'draft',
    label: 'Draft patch',
    description: 'Generate patch strategy and concrete file changes.',
  },
  {
    id: 'validate',
    label: 'Review validation',
    description: 'Inspect baseline command results before publishing.',
  },
  {
    id: 'pr',
    label: 'Create draft PR',
    description: 'Optionally push generated changes to your fork.',
  },
  {
    id: 'publish',
    label: 'Publish artifacts',
    description: 'Write dossier assets and optionally commit them.',
  },
];

export class AgentOrchestrator {
  private octokit: Octokit | null = null;

  private buildScoutEmptyExplanation(
    config: AppConfig,
    options: { repoFullName?: string; refresh: boolean },
  ): { title: string; detail: string; suggestions: string[] } {
    const scopeLine = options.repoFullName
      ? `This run was limited to ${options.repoFullName}.`
      : 'This run searched the broader GitHub issue stream.';

    return {
      title: 'No issues cleared the current filters',
      detail: `${scopeLine} OpenMeta did not find any opportunities that survived the current profile weighting and ${config.automation.minMatchScore}/100 threshold.`,
      suggestions: [
        `Lower automation.minMatchScore below ${config.automation.minMatchScore}.`,
        options.repoFullName
          ? 'Try a different repository or remove the repo filter.'
          : 'Broaden your tech stack or focus areas in the saved profile.',
        options.refresh
          ? 'Try again later after new issues appear.'
          : 'Rerun with --refresh to ignore the local issue cache.',
      ],
    };
  }

  async runMachine(options: AgentRunOptions = {}): Promise<MachineAgentResult> {
    const totalSteps = 8;
    const config = await configService.get();
    const headless = options.headless ?? true;
    const schedulerRun = Boolean(options.schedulerRun);
    const runChecks = typeof options.runChecks === 'boolean' ? options.runChecks : !headless;
    const draftOnly = Boolean(options.draftOnly);
    const localArtifactsOnly = Boolean(options.localArtifactsOnly);
    const refresh = Boolean(options.refresh);
    const dryRun = Boolean(options.dryRun);
    const repoPath = options.repoPath?.trim() || undefined;
    const issueTarget = options.issue ? resolveGitHubIssueTarget(options.issue, options.repo) : undefined;
    const starRange = issueTarget
      ? undefined
      : githubService.resolveRepositoryStarRange(options.minStars, options.maxStars);
    const scope = issueTarget
      ? undefined
      : repositoryTargetingService.resolveScope(config, {
          repo: options.repo,
          preset: options.preset,
          allRepos: options.allRepos,
        });
    const repoFullName = issueTarget?.repoFullName ?? scope?.repo;

    await this.validateConfig(config);

    issueRankingService.warmEnvironmentCache();

    if (headless && !schedulerRun && !dryRun && !localArtifactsOnly) {
      await this.confirmManualHeadlessRun(config);
    }

    await this.initializeClients(config, {
      validateGithub: true,
      validateLlm: true,
      taskSteps: {
        github: { index: 1, total: totalSteps },
        llm: { index: 2, total: totalSteps },
      },
    });
    this.showLocalRepositoryHint(repoPath);

    const rankedIssues = issueTarget
      ? await ui.task(
          {
            title: 'Loading target issue',
            doneMessage: 'Target issue loaded',
            failedMessage: 'Target issue loading failed',
            tone: 'info',
            step: { index: 3, total: totalSteps },
          },
          async () => issueRankingService.loadTargetIssue(config, issueTarget),
        )
      : await ui.task(
          {
            title: 'Ranking contribution opportunities',
            doneMessage: 'Contribution opportunities ranked',
            failedMessage: 'Contribution opportunity ranking failed',
            tone: 'info',
            step: { index: 3, total: totalSteps },
            heartbeat: {
              message: 'Still ranking contribution opportunities',
            },
          },
          async (task) =>
            scope?.mode === 'preset'
              ? this.loadPresetRankedIssues(config, scope.repos, {
                  refresh,
                  minStars: starRange?.minStars,
                  maxStars: starRange?.maxStars,
                  onStatus: (message) => task.setMessage(message),
                })
              : issueRankingService.loadRankedIssues(config, {
                  refresh,
                  repoFullName,
                  minStars: starRange?.minStars,
                  maxStars: starRange?.maxStars,
                  onStatus: (message) => task.setMessage(message),
                }),
        );

    if (rankedIssues.length === 0) {
      throw new Error(
        issueTarget
          ? 'OpenMeta could not build a contribution target from the specified issue.'
          : 'No issues met the current technical match threshold. Broaden your profile or try again later.',
      );
    }

    const presetIssueFlowAllowed =
      !issueTarget &&
      scope?.mode === 'preset' &&
      issueRankingService.getAdjustedOverallScore(rankedIssues[0]) >= config.automation.minMatchScore;
    const presetQualifiedIssue = presetIssueFlowAllowed
      ? issueRankingService.selectIssueForAutomation(rankedIssues, config.automation.minMatchScore)
      : undefined;
    const selectedIssue = issueTarget
      ? rankedIssues[0]
      : scope?.mode === 'preset'
        ? presetQualifiedIssue
        : headless
          ? issueRankingService.selectIssueForAutomation(rankedIssues, config.automation.minMatchScore)
          : await this.promptForIssue(issueRankingService.diversifyScoutIssues(rankedIssues, 5));

    if (!selectedIssue) {
      if (!issueTarget && scope?.mode === 'preset') {
        const selectedCandidate = await this.selectPresetAnalysisCandidate(scope.repos, {
          headless,
          runChecks,
        });
        const syntheticIssue = this.buildSyntheticIssueFromSuggestion(
          selectedCandidate.repoFullName,
          selectedCandidate.suggestion,
        );
        const memory = selectedCandidate.memory;
        const feasibilityPolicy = await this.assessExecutionFeasibility({
          issue: syntheticIssue,
          workspace: selectedCandidate.workspace,
          headless,
          draftOnly,
          localArtifactsOnly,
        });
        if (feasibilityPolicy.shouldStop) {
          throw new Error(`Selected issue is not executable on this machine: ${feasibilityPolicy.assessment.summary}`);
        }
        const patchDraftResult = await ui.task(
          {
            title: 'Generating patch strategy',
            doneMessage: 'Patch strategy generated',
            failedMessage: 'Patch strategy generation failed',
            tone: 'info',
            step: { index: 5, total: totalSteps },
            heartbeat: {
              message: 'Still drafting patch strategy',
            },
          },
          async () => llmService.generatePatchDraft(syntheticIssue, selectedCandidate.workspace, memory),
        );
        const patchDraft = patchDraftResult.data;
        const implementationWorkspace = this.buildImplementationWorkspace(selectedCandidate.workspace, patchDraft);
        const implementation =
          patchDraftResult.status === 'success'
            ? await this.generateConcretePatch(
                syntheticIssue,
                implementationWorkspace,
                patchDraft,
                runChecks,
                feasibilityPolicy.effectiveDraftOnly,
              )
            : {
                changedFiles: [],
                validationResults: implementationWorkspace.testResults,
                reviewRequired: true,
              };
        const workspaceForArtifacts: RepoWorkspaceContext = {
          ...implementationWorkspace,
          testResults: implementation.validationResults,
        };
        const prDraftResult = await ui.task(
          {
            title: 'Generating PR narrative',
            doneMessage: 'PR narrative generated',
            failedMessage: 'PR narrative generation failed',
            tone: 'info',
            step: { index: 6, total: totalSteps },
            heartbeat: {
              message: 'Still drafting PR narrative',
            },
          },
          async () => llmService.generatePrDraft(syntheticIssue, patchDraft, workspaceForArtifacts),
        );
        const prDraft = prDraftResult.data;
        const patchDraftMarkdown = contentService.formatPatchDraftMarkdown(patchDraft);
        const prDraftMarkdown = contentService.formatPullRequestDraftMarkdown(prDraft);
        const contributionPullRequest = await ui.task(
          {
            title: 'Evaluating draft PR creation',
            doneMessage: 'Draft PR evaluation complete',
            failedMessage: 'Draft PR evaluation failed',
            tone: 'info',
            step: { index: 7, total: totalSteps },
          },
          async () =>
            this.submitContributionPullRequestIfPossible({
              config,
              allowRealPr:
                feasibilityPolicy.allowRealPr &&
                patchDraftResult.status === 'success' &&
                prDraftResult.status === 'success',
              headless,
              issue: syntheticIssue,
              prDraft,
              workspace: workspaceForArtifacts,
              changedFiles: implementation.changedFiles,
              validationResults: implementation.validationResults,
            }),
        );
        const artifacts = this.prepareLocalArtifactPaths(syntheticIssue);
        const reviewRequired =
          patchDraftResult.status !== 'success' || implementation.reviewRequired || prDraftResult.status !== 'success';
        const skipReasons = [
          ...(draftOnly ? ['draft_only'] : []),
          ...feasibilityPolicy.skipReasons,
          ...(feasibilityPolicy.effectiveLocalArtifactsOnly ? ['publish_skipped_local_artifacts_only'] : []),
          ...(patchDraftResult.status !== 'success' ? ['patch_draft_requires_review'] : []),
          ...(implementation.reviewRequired ? ['implementation_requires_review'] : []),
          ...(prDraftResult.status !== 'success' ? ['pr_draft_requires_review'] : []),
          ...(contributionPullRequest.url
            ? []
            : implementation.changedFiles.length > 0
              ? ['pr_not_created']
              : ['no_changes_applied']),
        ];

        if (!dryRun) {
          const inboxItem = {
            id: `${syntheticIssue.repoFullName}#${syntheticIssue.number}`,
            repoFullName: syntheticIssue.repoFullName,
            issueNumber: syntheticIssue.number,
            issueTitle: syntheticIssue.title,
            summary: syntheticIssue.opportunity.summary,
            overallScore: syntheticIssue.opportunity.overallScore,
            opportunityScore: syntheticIssue.opportunity.score,
            status: 'ready' as const,
            artifactDir: artifacts.artifactDir,
            generatedAt: new Date().toISOString(),
          };
          const inboxItems = inboxService.saveItem(inboxItem);
          const proofRecord = {
            id: `${syntheticIssue.repoFullName}#${syntheticIssue.number}@${Date.now()}`,
            repoFullName: syntheticIssue.repoFullName,
            issueNumber: syntheticIssue.number,
            issueTitle: syntheticIssue.title,
            overallScore: syntheticIssue.opportunity.overallScore,
            opportunityScore: syntheticIssue.opportunity.score,
            branchName: workspaceForArtifacts.branchName,
            artifactDir: artifacts.artifactDir,
            generatedAt: new Date().toISOString(),
            published: false,
            pullRequestUrl: contributionPullRequest.url,
            pullRequestNumber: contributionPullRequest.number,
          };
          const dossier = contentService.formatContributionDossier(
            syntheticIssue,
            workspaceForArtifacts,
            memory,
            patchDraft,
            prDraft,
          );
          const proofMarkdown = proofOfWorkService.renderMarkdown(
            [proofRecord, ...proofOfWorkService.load().records].slice(0, 100),
          );

          this.writeLocalArtifacts({
            artifacts,
            dossier,
            patchDraftMarkdown,
            prDraftMarkdown,
            memoryMarkdown: memoryService.renderMarkdown(memory),
            inboxMarkdown: inboxService.renderMarkdown(inboxItems),
            proofMarkdown,
          });

          const publishResult = feasibilityPolicy.effectiveLocalArtifactsOnly
            ? { published: false }
            : await ui.task(
                {
                  title: dryRun ? 'Previewing artifact publication' : 'Publishing contribution artifacts',
                  doneMessage: dryRun ? 'Artifact publication preview complete' : 'Contribution artifacts published',
                  failedMessage: dryRun
                    ? 'Artifact publication preview failed'
                    : 'Contribution artifact publication failed',
                  tone: 'info',
                  step: { index: 8, total: totalSteps },
                },
                async () =>
                  this.publishArtifactsIfNeeded({
                    config,
                    headless,
                    dryRun: options.dryRun,
                    issue: syntheticIssue,
                    patchDraftMarkdown,
                    prDraftMarkdown,
                    dossier,
                    memoryMarkdown: memoryService.renderMarkdown(memory),
                    inboxMarkdown: inboxService.renderMarkdown(inboxItems),
                    proofMarkdown,
                    changedFiles: implementation.changedFiles,
                    validationResults: implementation.validationResults,
                    pullRequestUrl: contributionPullRequest.url,
                  }),
              );

          const finalProofRecord = {
            ...proofRecord,
            published: publishResult.published,
          };
          const finalMemory = memoryService.recordOutcome({
            issue: syntheticIssue,
            workspace: workspaceForArtifacts,
            changedFiles: implementation.changedFiles,
            validationResults: implementation.validationResults,
            published: publishResult.published,
            pullRequestUrl: contributionPullRequest.url,
            reviewRequired,
          });
          proofOfWorkService.record(finalProofRecord);
          const finalProofMarkdown = proofOfWorkService.renderMarkdown(proofOfWorkService.load().records);
          this.writeLocalArtifacts({
            artifacts,
            dossier,
            patchDraftMarkdown,
            prDraftMarkdown,
            memoryMarkdown: memoryService.renderMarkdown(finalMemory),
            inboxMarkdown: inboxService.renderMarkdown(inboxItems),
            proofMarkdown: finalProofMarkdown,
          });
        }

        return {
          issue: syntheticIssue,
          workspace: workspaceForArtifacts,
          patchDraft,
          prDraft,
          artifacts,
          changedFiles: implementation.changedFiles,
          validationResults: implementation.validationResults,
          reviewRequired,
          implementationAttempts: implementation.implementationAttempts,
          implementationStopReason: implementation.implementationStopReason,
          implementationContextFilesAdded: implementation.implementationContextFilesAdded,
          published: false,
          prCreated: Boolean(contributionPullRequest.url),
          repoMutated: implementation.changedFiles.length > 0,
          artifactsWritten: !dryRun,
          executionOutcome: this.resolveMachineExecutionOutcome({
            draftOnly,
            localArtifactsOnly: feasibilityPolicy.effectiveLocalArtifactsOnly,
            changedFiles: implementation.changedFiles,
            prCreated: Boolean(contributionPullRequest.url),
            reviewRequired,
          }),
          executionPolicy: {
            headless,
            draftOnly: feasibilityPolicy.effectiveDraftOnly,
            localArtifactsOnly: feasibilityPolicy.effectiveLocalArtifactsOnly,
            runChecks,
            dryRun,
            refresh,
            minStars: starRange?.minStars,
            maxStars: starRange?.maxStars,
          },
          skipReasons: [...new Set(skipReasons)],
          nextActions: dryRun
            ? ['inspect_artifact_paths']
            : contributionPullRequest.url
              ? ['review_pull_request']
              : ['inspect_artifact_paths'],
          pullRequestUrl: contributionPullRequest.url,
          pullRequestNumber: contributionPullRequest.number,
        };
      }

      throw new Error(
        issueTarget
          ? 'OpenMeta could not select the specified target issue after scoring.'
          : `Top opportunities were below ${config.automation.minMatchScore}/100. Lower the threshold or widen your profile.`,
      );
    }

    const memoryBeforeRun = memoryService.load(selectedIssue.repoFullName);
    const workspace = await ui.task(
      {
        title: `Preparing workspace for ${selectedIssue.repoFullName}`,
        doneMessage: 'Workspace prepared',
        failedMessage: 'Workspace preparation failed',
        tone: 'info',
        step: { index: 4, total: totalSteps },
        heartbeat: {
          message: 'Still preparing repository workspace',
        },
      },
      async () =>
        workspaceService.prepareWorkspace(
          selectedIssue,
          memoryBeforeRun,
          runChecks,
          headless ? 'headless' : 'interactive',
          repoPath,
        ),
    );
    const memory = memoryService.update(selectedIssue, workspace);
    const feasibilityPolicy = await this.assessExecutionFeasibility({
      issue: selectedIssue,
      workspace,
      headless,
      draftOnly,
      localArtifactsOnly,
    });
    if (feasibilityPolicy.shouldStop) {
      throw new Error(`Selected issue is not executable on this machine: ${feasibilityPolicy.assessment.summary}`);
    }

    const patchDraftResult = await ui.task(
      {
        title: 'Generating patch strategy',
        doneMessage: 'Patch strategy generated',
        failedMessage: 'Patch strategy generation failed',
        tone: 'info',
        step: { index: 5, total: totalSteps },
        heartbeat: {
          message: 'Still drafting patch strategy',
        },
      },
      async () => llmService.generatePatchDraft(selectedIssue, workspace, memory),
    );
    const patchDraft = patchDraftResult.data;
    const implementationWorkspace = this.buildImplementationWorkspace(workspace, patchDraft);
    const implementation =
      patchDraftResult.status === 'success'
        ? await this.generateConcretePatch(
            selectedIssue,
            implementationWorkspace,
            patchDraft,
            runChecks,
            feasibilityPolicy.effectiveDraftOnly,
          )
        : {
            changedFiles: [],
            validationResults: implementationWorkspace.testResults,
            reviewRequired: true,
            implementationAttempts: 0,
            implementationStopReason: 'implementation_requires_review' as const,
            implementationContextFilesAdded: 0,
          };

    const workspaceForArtifacts: RepoWorkspaceContext = {
      ...implementationWorkspace,
      testResults: implementation.validationResults,
    };

    const prDraftResult = await ui.task(
      {
        title: 'Generating PR narrative',
        doneMessage: 'PR narrative generated',
        failedMessage: 'PR narrative generation failed',
        tone: 'info',
        step: { index: 6, total: totalSteps },
        heartbeat: {
          message: 'Still drafting PR narrative',
        },
      },
      async () => llmService.generatePrDraft(selectedIssue, patchDraft, workspaceForArtifacts),
    );
    const prDraft = prDraftResult.data;
    const patchDraftMarkdown = contentService.formatPatchDraftMarkdown(patchDraft);
    const prDraftMarkdown = contentService.formatPullRequestDraftMarkdown(prDraft);

    const contributionPullRequest = await ui.task(
      {
        title: 'Evaluating draft PR creation',
        doneMessage: 'Draft PR evaluation complete',
        failedMessage: 'Draft PR evaluation failed',
        tone: 'info',
        step: { index: 7, total: totalSteps },
      },
      async () =>
        this.submitContributionPullRequestIfPossible({
          config,
          allowRealPr:
            feasibilityPolicy.allowRealPr &&
            patchDraftResult.status === 'success' &&
            prDraftResult.status === 'success',
          headless,
          issue: selectedIssue,
          prDraft,
          workspace: workspaceForArtifacts,
          changedFiles: implementation.changedFiles,
          validationResults: implementation.validationResults,
        }),
    );

    const artifacts = this.prepareLocalArtifactPaths(selectedIssue);
    const reviewRequired =
      patchDraftResult.status !== 'success' || implementation.reviewRequired || prDraftResult.status !== 'success';
    const skipReasons = [
      ...(draftOnly ? ['draft_only'] : []),
      ...feasibilityPolicy.skipReasons,
      ...(feasibilityPolicy.effectiveLocalArtifactsOnly ? ['publish_skipped_local_artifacts_only'] : []),
      ...(patchDraftResult.status !== 'success' ? ['patch_draft_requires_review'] : []),
      ...(implementation.reviewRequired ? ['implementation_requires_review'] : []),
      ...(prDraftResult.status !== 'success' ? ['pr_draft_requires_review'] : []),
      ...(contributionPullRequest.url
        ? []
        : implementation.changedFiles.length > 0
          ? ['pr_not_created']
          : ['no_changes_applied']),
    ];

    if (!dryRun) {
      const inboxItem = {
        id: `${selectedIssue.repoFullName}#${selectedIssue.number}`,
        repoFullName: selectedIssue.repoFullName,
        issueNumber: selectedIssue.number,
        issueTitle: selectedIssue.title,
        summary: selectedIssue.opportunity.summary,
        overallScore: selectedIssue.opportunity.overallScore,
        opportunityScore: selectedIssue.opportunity.score,
        status: 'ready' as const,
        artifactDir: artifacts.artifactDir,
        generatedAt: new Date().toISOString(),
      };
      const inboxItems = inboxService.saveItem(inboxItem);
      const proofRecord = {
        id: `${selectedIssue.repoFullName}#${selectedIssue.number}@${Date.now()}`,
        repoFullName: selectedIssue.repoFullName,
        issueNumber: selectedIssue.number,
        issueTitle: selectedIssue.title,
        overallScore: selectedIssue.opportunity.overallScore,
        opportunityScore: selectedIssue.opportunity.score,
        branchName: workspace.branchName,
        artifactDir: artifacts.artifactDir,
        generatedAt: new Date().toISOString(),
        published: false,
        pullRequestUrl: contributionPullRequest.url,
        pullRequestNumber: contributionPullRequest.number,
      };
      const dossier = contentService.formatContributionDossier(
        selectedIssue,
        workspaceForArtifacts,
        memory,
        patchDraft,
        prDraft,
      );
      const proofMarkdown = proofOfWorkService.renderMarkdown(
        [proofRecord, ...proofOfWorkService.load().records].slice(0, 100),
      );

      this.writeLocalArtifacts({
        artifacts,
        dossier,
        patchDraftMarkdown,
        prDraftMarkdown,
        memoryMarkdown: memoryService.renderMarkdown(memory),
        inboxMarkdown: inboxService.renderMarkdown(inboxItems),
        proofMarkdown,
      });

      const publishResult = feasibilityPolicy.effectiveLocalArtifactsOnly
        ? { published: false }
        : await ui.task(
            {
              title: dryRun ? 'Previewing artifact publication' : 'Publishing contribution artifacts',
              doneMessage: dryRun ? 'Artifact publication preview complete' : 'Contribution artifacts published',
              failedMessage: dryRun
                ? 'Artifact publication preview failed'
                : 'Contribution artifact publication failed',
              tone: 'info',
              step: { index: 8, total: totalSteps },
            },
            async () =>
              this.publishArtifactsIfNeeded({
                config,
                headless,
                dryRun: options.dryRun,
                issue: selectedIssue,
                patchDraftMarkdown,
                prDraftMarkdown,
                dossier,
                memoryMarkdown: memoryService.renderMarkdown(memory),
                inboxMarkdown: inboxService.renderMarkdown(inboxItems),
                proofMarkdown,
                changedFiles: implementation.changedFiles,
                validationResults: implementation.validationResults,
                pullRequestUrl: contributionPullRequest.url,
              }),
          );

      const finalProofRecord = {
        ...proofRecord,
        published: publishResult.published,
      };
      const finalMemory = memoryService.recordOutcome({
        issue: selectedIssue,
        workspace: workspaceForArtifacts,
        changedFiles: implementation.changedFiles,
        validationResults: implementation.validationResults,
        published: publishResult.published,
        pullRequestUrl: contributionPullRequest.url,
        reviewRequired,
      });
      proofOfWorkService.record(finalProofRecord);
      const finalProofMarkdown = proofOfWorkService.renderMarkdown(proofOfWorkService.load().records);
      this.writeLocalArtifacts({
        artifacts,
        dossier,
        patchDraftMarkdown,
        prDraftMarkdown,
        memoryMarkdown: memoryService.renderMarkdown(finalMemory),
        inboxMarkdown: inboxService.renderMarkdown(inboxItems),
        proofMarkdown: finalProofMarkdown,
      });
    }

    return {
      issue: selectedIssue,
      workspace: workspaceForArtifacts,
      patchDraft,
      prDraft,
      artifacts,
      changedFiles: implementation.changedFiles,
      validationResults: implementation.validationResults,
      reviewRequired,
      published: false,
      prCreated: Boolean(contributionPullRequest.url),
      repoMutated: implementation.changedFiles.length > 0,
      artifactsWritten: !dryRun,
      executionOutcome: this.resolveMachineExecutionOutcome({
        draftOnly,
        localArtifactsOnly: feasibilityPolicy.effectiveLocalArtifactsOnly,
        changedFiles: implementation.changedFiles,
        prCreated: Boolean(contributionPullRequest.url),
        reviewRequired,
      }),
      executionPolicy: {
        headless,
        draftOnly: feasibilityPolicy.effectiveDraftOnly,
        localArtifactsOnly: feasibilityPolicy.effectiveLocalArtifactsOnly,
        runChecks,
        dryRun,
        refresh,
        minStars: starRange?.minStars,
        maxStars: starRange?.maxStars,
      },
      skipReasons: [...new Set(skipReasons)],
      nextActions: dryRun
        ? ['inspect_artifact_paths']
        : contributionPullRequest.url
          ? ['review_pull_request']
          : ['inspect_artifact_paths'],
      pullRequestUrl: contributionPullRequest.url,
      pullRequestNumber: contributionPullRequest.number,
      implementationAttempts: implementation.implementationAttempts,
      implementationStopReason: implementation.implementationStopReason,
      implementationContextFilesAdded: implementation.implementationContextFilesAdded,
    };
  }

  async run(options: AgentRunOptions = {}): Promise<void> {
    const config = await configService.get();
    const headless = Boolean(options.headless);
    const schedulerRun = Boolean(options.schedulerRun);
    const runChecks = typeof options.runChecks === 'boolean' ? options.runChecks : !headless;
    const draftOnly = Boolean(options.draftOnly);
    const localArtifactsOnly = Boolean(options.localArtifactsOnly);
    const refresh = Boolean(options.refresh);
    const repoPath = options.repoPath?.trim() || undefined;
    const issueTarget = options.issue ? resolveGitHubIssueTarget(options.issue, options.repo) : undefined;
    const starRange = issueTarget
      ? undefined
      : githubService.resolveRepositoryStarRange(options.minStars, options.maxStars);
    const scope = issueTarget
      ? undefined
      : repositoryTargetingService.resolveScope(config, {
          repo: options.repo,
          preset: options.preset,
          allRepos: options.allRepos,
        });
    const repoFullName = issueTarget?.repoFullName ?? scope?.repo;
    const completedStages = new Set<AgentStageId>();

    ui.hero({
      label: 'OpenMeta Agent',
      title: headless
        ? 'Let the contribution loop move with quiet precision'
        : 'Pull a clean contribution arc out of the noise',
      subtitle: headless
        ? 'OpenMeta will read the field, enter the repository, draft the patch path, and carry the run through to publication without another stop for review.'
        : 'OpenMeta will read the field, enter the repository, shape a patch direction, and leave behind artifacts that feel deliberate instead of improvised.',
      lines: [
        runChecks
          ? 'Baseline checks will fire wherever the repository exposes a safe command path.'
          : 'This pass will stay light and skip baseline checks.',
        draftOnly
          ? 'Draft-only mode will preserve artifacts without applying generated file edits or opening a PR.'
          : 'Generated patches can be applied after repository safety checks pass.',
        localArtifactsOnly
          ? 'Local artifact mode will write dossier files to disk but skip publish, commit, and push steps.'
          : 'Artifact publication can update the OpenMeta ledger after local files are written.',
        issueTarget
          ? `Target issue is locked to ${issueTarget.repoFullName}#${issueTarget.issueNumber}.`
          : refresh
            ? 'Issue discovery will bypass the local search cache for this run.'
            : 'Issue discovery may reuse the short local search cache.',
        ...(starRange
          ? [
              `Repository stars: ${starRange.minStars} to ${starRange.maxStars === undefined ? 'unbounded' : starRange.maxStars}.`,
            ]
          : []),
        issueTarget
          ? 'Issue discovery and interactive selection are skipped for this run.'
          : scope?.mode === 'preset'
            ? `Issue discovery is limited to preset ${scope.presetName} (${scope.repos.length} repositories).`
            : repoFullName
              ? `Issue discovery is limited to ${repoFullName}.`
              : 'Issue discovery will scan the broader GitHub issue stream.',
        repoPath
          ? `Local repository reuse is enabled via ${repoPath}. OpenMeta will create an isolated worktree and a fresh branch before opening a PR.`
          : 'If the repository already exists locally, pass --repo-path <local-path> so OpenMeta can reuse it via an isolated worktree and open the PR from a fresh branch.',
        headless
          ? `Unattended selection honors the saved threshold at ${config.automation.minMatchScore}/100.`
          : 'You stay in control at each decision gate before anything is published.',
      ],
    });

    await this.validateConfig(config);

    // Kick off background environment detection early; do not block the main flow
    issueRankingService.warmEnvironmentCache();

    if (headless && !schedulerRun && !localArtifactsOnly) {
      await this.confirmManualHeadlessRun(config);
    }

    this.renderAgentStage(
      'scout',
      completedStages,
      issueTarget
        ? `Verifying provider access and loading ${issueTarget.repoFullName}#${issueTarget.issueNumber}.`
        : 'Verifying provider access and loading ranked opportunities.',
    );
    await this.initializeClients(config);
    this.showLocalRepositoryHint(repoPath);

    const rankedIssues = await ui.task(
      {
        title: issueTarget ? 'Loading target issue' : 'Ranking contribution opportunities',
        doneMessage: 'Opportunity ranking complete',
        failedMessage: 'Opportunity ranking failed',
        tone: 'info',
      },
      async (task) =>
        issueTarget
          ? issueRankingService.loadTargetIssue(config, issueTarget)
          : scope?.mode === 'preset'
            ? this.loadPresetRankedIssues(config, scope.repos, {
                refresh,
                minStars: starRange?.minStars,
                maxStars: starRange?.maxStars,
                onStatus: (message) => task.setMessage(message),
              })
            : issueRankingService.loadRankedIssues(config, {
                refresh,
                repoFullName,
                minStars: starRange?.minStars,
                maxStars: starRange?.maxStars,
                onStatus: (message) => task.setMessage(message),
              }),
    );
    if (rankedIssues.length === 0) {
      ui.emptyState(
        'OpenMeta Agent',
        issueTarget ? 'Target issue could not be ranked' : 'No viable issues found',
        issueTarget
          ? 'OpenMeta could not build a contribution target from the specified issue.'
          : 'No issues met the current technical match threshold. Broaden your profile or try again later.',
      );
      return;
    }
    completedStages.add('scout');

    this.renderAgentStage(
      'select',
      completedStages,
      issueTarget
        ? 'Using the explicitly targeted issue as the contribution target.'
        : 'Review the top ranked issues and choose the next contribution target.',
    );
    if (!issueTarget) {
      const displayIssues = issueRankingService.diversifyScoutIssues(rankedIssues, 5);
      this.renderOpportunityList('Top ranked opportunities', displayIssues);
    }
    const presetIssueFlowAllowed =
      !issueTarget &&
      scope?.mode === 'preset' &&
      issueRankingService.getAdjustedOverallScore(rankedIssues[0]) >= config.automation.minMatchScore;
    const presetQualifiedIssue = presetIssueFlowAllowed
      ? issueRankingService.selectIssueForAutomation(rankedIssues, config.automation.minMatchScore)
      : undefined;
    const selectedIssue = issueTarget
      ? rankedIssues[0]
      : scope?.mode === 'preset'
        ? presetQualifiedIssue
          ? headless
            ? presetQualifiedIssue
            : await this.promptForIssue(issueRankingService.diversifyScoutIssues(rankedIssues, 5))
          : undefined
        : headless
          ? issueRankingService.selectIssueForAutomation(rankedIssues, config.automation.minMatchScore)
          : await this.promptForIssue(issueRankingService.diversifyScoutIssues(rankedIssues, 5));

    if (!selectedIssue) {
      if (!issueTarget && scope?.mode === 'preset') {
        await this.runPresetAnalysisFallback({
          config,
          repos: scope.repos,
          headless,
          runChecks,
          draftOnly,
          refresh,
          options,
          completedStages,
        });
        return;
      }

      ui.emptyState(
        'OpenMeta Agent',
        issueTarget ? 'Target issue could not be selected' : 'No issue met the automation threshold',
        issueTarget
          ? 'OpenMeta could not select the specified target issue after scoring.'
          : `Top opportunities were below ${config.automation.minMatchScore}/100. Lower the threshold or widen your profile.`,
      );
      return;
    }
    completedStages.add('select');
    this.showSelectedOpportunity(selectedIssue, headless);

    this.renderAgentStage('prepare', completedStages, `Cloning and inspecting ${selectedIssue.repoFullName}.`);
    const memoryBeforeRun = memoryService.load(selectedIssue.repoFullName);
    const workspace = await ui.task(
      {
        title: `Preparing workspace for ${selectedIssue.repoFullName}`,
        doneMessage: 'Workspace prepared',
        failedMessage: 'Workspace preparation failed',
        tone: 'info',
      },
      async () =>
        workspaceService.prepareWorkspace(
          selectedIssue,
          memoryBeforeRun,
          runChecks,
          headless ? 'headless' : 'interactive',
          repoPath,
        ),
    );
    const memory = memoryService.update(selectedIssue, workspace);
    completedStages.add('prepare');
    this.showWorkspaceSummary(workspace, memory);
    const feasibilityPolicy = await this.assessExecutionFeasibility({
      issue: selectedIssue,
      workspace,
      headless,
      draftOnly,
      localArtifactsOnly,
    });
    if (feasibilityPolicy.shouldStop) {
      completedStages.add('draft');
      this.renderAgentStage(
        'draft',
        completedStages,
        `Execution stopped before patch generation: ${feasibilityPolicy.assessment.summary}`,
        true,
      );
      return;
    }

    this.renderAgentStage(
      'draft',
      completedStages,
      'Drafting patch strategy and turning it into concrete file changes.',
    );
    const patchDraftResult = await ui.task(
      {
        title: 'Generating patch strategy',
        doneMessage: 'Patch strategy generated',
        failedMessage: 'Patch strategy generation failed',
        tone: 'info',
      },
      async () => llmService.generatePatchDraft(selectedIssue, workspace, memory),
    );
    const patchDraft = patchDraftResult.data;
    if (patchDraftResult.status !== 'success') {
      this.showStructuredReviewNotice({
        title: 'Patch strategy requires review',
        subtitle:
          'OpenMeta marked the generated patch plan as review-required, so this run will preserve artifacts but skip concrete code edits.',
        lines: [`Goal: ${patchDraft.goal}`],
      });
    }
    const implementationWorkspace = this.buildImplementationWorkspace(workspace, patchDraft);
    const implementation =
      patchDraftResult.status === 'success'
        ? await this.generateConcretePatch(
            selectedIssue,
            implementationWorkspace,
            patchDraft,
            runChecks,
            feasibilityPolicy.effectiveDraftOnly,
          )
        : {
            changedFiles: [],
            validationResults: implementationWorkspace.testResults,
            reviewRequired: true,
          };
    completedStages.add('draft');
    const workspaceForArtifacts: RepoWorkspaceContext = {
      ...implementationWorkspace,
      testResults: implementation.validationResults,
    };

    this.renderAgentStage(
      'validate',
      completedStages,
      'Reviewing validation outcomes before opening or publishing anything.',
    );
    this.showValidationSummary(workspaceForArtifacts, implementation.changedFiles);
    completedStages.add('validate');

    this.renderAgentStage('pr', completedStages, 'Drafting PR narrative and deciding whether to open a real draft PR.');
    const prDraftResult = await ui.task(
      {
        title: 'Generating PR narrative',
        doneMessage: 'PR narrative generated',
        failedMessage: 'PR narrative generation failed',
        tone: 'info',
      },
      async () => llmService.generatePrDraft(selectedIssue, patchDraft, workspaceForArtifacts),
    );
    const prDraft = prDraftResult.data;
    if (prDraftResult.status !== 'success') {
      this.showStructuredReviewNotice({
        title: 'PR narrative requires review',
        subtitle:
          'OpenMeta marked the generated PR draft as review-required, so this run will stay in draft-only mode and skip opening a real PR.',
        lines: [`Title: ${prDraft.title}`],
      });
    }
    const patchDraftMarkdown = contentService.formatPatchDraftMarkdown(patchDraft);
    const prDraftMarkdown = contentService.formatPullRequestDraftMarkdown(prDraft);

    const contributionPullRequest = await this.submitContributionPullRequestIfPossible({
      config,
      allowRealPr:
        feasibilityPolicy.allowRealPr && patchDraftResult.status === 'success' && prDraftResult.status === 'success',
      headless,
      issue: selectedIssue,
      prDraft,
      workspace: workspaceForArtifacts,
      changedFiles: implementation.changedFiles,
      validationResults: implementation.validationResults,
    });
    completedStages.add('pr');

    const artifacts = this.prepareLocalArtifactPaths(selectedIssue);

    const inboxItem = {
      id: `${selectedIssue.repoFullName}#${selectedIssue.number}`,
      repoFullName: selectedIssue.repoFullName,
      issueNumber: selectedIssue.number,
      issueTitle: selectedIssue.title,
      summary: selectedIssue.opportunity.summary,
      overallScore: selectedIssue.opportunity.overallScore,
      opportunityScore: selectedIssue.opportunity.score,
      status: 'ready' as const,
      artifactDir: artifacts.artifactDir,
      generatedAt: new Date().toISOString(),
    };
    const inboxItems = inboxService.saveItem(inboxItem);

    const proofRecord = {
      id: `${selectedIssue.repoFullName}#${selectedIssue.number}@${Date.now()}`,
      repoFullName: selectedIssue.repoFullName,
      issueNumber: selectedIssue.number,
      issueTitle: selectedIssue.title,
      overallScore: selectedIssue.opportunity.overallScore,
      opportunityScore: selectedIssue.opportunity.score,
      branchName: workspace.branchName,
      artifactDir: artifacts.artifactDir,
      generatedAt: new Date().toISOString(),
      published: false,
      pullRequestUrl: contributionPullRequest.url,
      pullRequestNumber: contributionPullRequest.number,
    };

    const dossier = contentService.formatContributionDossier(
      selectedIssue,
      workspaceForArtifacts,
      memory,
      patchDraft,
      prDraft,
    );
    const proofMarkdown = proofOfWorkService.renderMarkdown(
      [proofRecord, ...proofOfWorkService.load().records].slice(0, 100),
    );

    this.renderAgentStage(
      'publish',
      completedStages,
      'Saving dossier assets, updating long-term memory, and deciding whether to publish them.',
    );
    this.showArtifactPreview({
      issue: selectedIssue,
      artifactRelativeDir: join(
        'contributions',
        getLocalDateStamp(),
        `${selectedIssue.repoFullName.replace(/\//g, '__')}__${selectedIssue.number}`,
      ),
      draftTitle: prDraft.title,
      changedFiles: implementation.changedFiles,
      validationResults: implementation.validationResults,
      pullRequestUrl: contributionPullRequest.url,
    });

    await ui.task(
      {
        title: 'Writing local artifacts',
        doneMessage: 'Local artifacts written',
        failedMessage: 'Local artifact write failed',
        tone: 'info',
      },
      async () => {
        this.writeLocalArtifacts({
          artifacts,
          dossier,
          patchDraftMarkdown,
          prDraftMarkdown,
          memoryMarkdown: memoryService.renderMarkdown(memory),
          inboxMarkdown: inboxService.renderMarkdown(inboxItems),
          proofMarkdown,
        });
      },
    );

    const publishResult = feasibilityPolicy.effectiveLocalArtifactsOnly
      ? { published: false }
      : await this.publishArtifactsIfNeeded({
          config,
          headless,
          dryRun: options.dryRun,
          issue: selectedIssue,
          patchDraftMarkdown,
          prDraftMarkdown,
          dossier,
          memoryMarkdown: memoryService.renderMarkdown(memory),
          inboxMarkdown: inboxService.renderMarkdown(inboxItems),
          proofMarkdown,
          changedFiles: implementation.changedFiles,
          validationResults: implementation.validationResults,
          pullRequestUrl: contributionPullRequest.url,
        });

    const reviewRequired =
      patchDraftResult.status !== 'success' || implementation.reviewRequired || prDraftResult.status !== 'success';
    const finalProofRecord = {
      ...proofRecord,
      published: publishResult.published,
    };
    const finalMemory = memoryService.recordOutcome({
      issue: selectedIssue,
      workspace: workspaceForArtifacts,
      changedFiles: implementation.changedFiles,
      validationResults: implementation.validationResults,
      published: publishResult.published,
      pullRequestUrl: contributionPullRequest.url,
      reviewRequired,
    });
    proofOfWorkService.record(finalProofRecord);
    const finalProofMarkdown = proofOfWorkService.renderMarkdown(proofOfWorkService.load().records);
    this.writeLocalArtifacts({
      artifacts,
      dossier,
      patchDraftMarkdown,
      prDraftMarkdown,
      memoryMarkdown: memoryService.renderMarkdown(finalMemory),
      inboxMarkdown: inboxService.renderMarkdown(inboxItems),
      proofMarkdown: finalProofMarkdown,
    });
    completedStages.add('publish');

    this.showResult({
      issue: selectedIssue,
      workspace: workspaceForArtifacts,
      memory: finalMemory,
      patchDraft,
      prDraft,
      dossier,
      artifacts,
      inboxItem,
      proofRecord: finalProofRecord,
      changedFiles: implementation.changedFiles,
      pullRequestUrl: contributionPullRequest.url,
    });
  }

  async scout(options: ScoutRunOptions | number = {}): Promise<void> {
    const limit = typeof options === 'number' ? options : (options.limit ?? 10);
    const refresh = typeof options === 'number' ? false : Boolean(options.refresh);
    const minStars = typeof options === 'number' ? undefined : options.minStars;
    const maxStars = typeof options === 'number' ? undefined : options.maxStars;
    const starRange = githubService.resolveRepositoryStarRange(minStars, maxStars);
    const explicitRepo =
      typeof options === 'number' || !options.repo ? undefined : parseGitHubRepoFullName(options.repo);
    const config = await configService.get();
    const scope =
      typeof options === 'number'
        ? repositoryTargetingService.resolveScope(config)
        : repositoryTargetingService.resolveScope(config, {
            repo: options.repo,
            preset: options.preset,
            allRepos: options.allRepos,
          });
    const repoFullName = explicitRepo ?? scope.repo;
    await this.validateConfig(config);
    await this.initializeClients(config, { validateGithub: true, validateLlm: true });

    ui.hero({
      label: 'OpenMeta Scout',
      title: 'Read the field before you spend your focus',
      subtitle:
        'OpenMeta turns a noisy issue stream into a shortlist shaped by technical fit, timing, and real opening momentum.',
      lines: [
        `Saved threshold reference: ${config.automation.minMatchScore}/100.`,
        refresh
          ? 'This scout run will ignore the local GitHub issue cache.'
          : 'This scout run may reuse the short local GitHub issue cache.',
        scope.mode === 'preset'
          ? `Issue discovery is limited to preset ${scope.presetName} (${scope.repos.length} repositories).`
          : repoFullName
            ? `Issue discovery is limited to ${repoFullName}.`
            : 'Issue discovery will scan the broader GitHub issue stream.',
        'LLM scoring will refine the local candidate shortlist.',
        `Repository stars: ${starRange.minStars} to ${starRange.maxStars === undefined ? 'unbounded' : starRange.maxStars}.`,
      ],
    });

    const rankedIssues = await ui.task(
      {
        title: 'Scoring contribution opportunities',
        doneMessage: 'Contribution opportunities scored',
        failedMessage: 'Contribution opportunity scoring failed',
        tone: 'info',
      },
      async (task) => {
        if (scope.mode === 'preset') {
          return this.loadPresetRankedIssues(config, scope.repos, {
            refresh,
            minStars: starRange.minStars,
            maxStars: starRange.maxStars,
            onStatus: (message) => task.setMessage(message),
          });
        }

        return issueRankingService.loadRankedIssues(config, {
          refresh,
          repoFullName,
          minStars: starRange.minStars,
          maxStars: starRange.maxStars,
          onStatus: (message) => task.setMessage(message),
        });
      },
    );
    if (rankedIssues.length === 0) {
      const emptyExplanation = this.buildScoutEmptyExplanation(config, { repoFullName, refresh });
      ui.emptyState(
        'OpenMeta Scout',
        emptyExplanation.title,
        `${emptyExplanation.detail} Next: ${emptyExplanation.suggestions.join(' ')}`,
      );
      return;
    }

    ui.stats('Scout snapshot', [
      { label: 'Ranked issues', value: String(rankedIssues.length), tone: 'success' },
      { label: 'Showing', value: String(Math.min(limit, rankedIssues.length)), tone: 'info' },
      { label: 'Top score', value: String(rankedIssues[0]?.opportunity.overallScore || 0), tone: 'accent' },
      { label: 'Profile threshold', value: `${config.automation.minMatchScore}`, tone: 'info' },
    ]);
    this.renderOpportunityList('Ranked opportunities', issueRankingService.diversifyScoutIssues(rankedIssues, limit));
  }

  async scoutMachine(options: ScoutRunOptions = {}): Promise<MachineScoutResult> {
    const totalSteps = 3;
    const limit = options.limit ?? 10;
    const refresh = Boolean(options.refresh);
    const starRange = githubService.resolveRepositoryStarRange(options.minStars, options.maxStars);
    const config = await configService.get();
    const scope = repositoryTargetingService.resolveScope(config, {
      repo: options.repo,
      preset: options.preset,
      allRepos: options.allRepos,
    });
    const repoFullName = scope.mode === 'single' ? scope.repo : undefined;

    await this.validateConfig(config);
    await this.initializeClients(config, {
      validateGithub: true,
      validateLlm: true,
      taskSteps: {
        github: { index: 1, total: totalSteps },
        llm: { index: 2, total: totalSteps },
      },
    });

    const rankedIssues = await ui.task(
      {
        title: 'Scoring contribution opportunities',
        doneMessage: 'Contribution opportunities scored',
        failedMessage: 'Contribution opportunity scoring failed',
        tone: 'info',
        step: { index: 3, total: totalSteps },
        heartbeat: {
          message: 'Still scoring contribution opportunities',
        },
      },
      async (task) => {
        if (scope.mode === 'preset') {
          return this.loadPresetRankedIssues(config, scope.repos, {
            refresh,
            minStars: starRange.minStars,
            maxStars: starRange.maxStars,
            onStatus: (message) => task.setMessage(message),
          });
        }

        return issueRankingService.loadRankedIssues(config, {
          refresh,
          repoFullName,
          minStars: starRange.minStars,
          maxStars: starRange.maxStars,
          onStatus: (message) => task.setMessage(message),
        });
      },
    );
    const emptyExplanation =
      rankedIssues.length === 0 ? this.buildScoutEmptyExplanation(config, { repoFullName, refresh }) : undefined;

    return {
      opportunities: issueRankingService.diversifyScoutIssues(rankedIssues, limit),
      mode: {
        limit,
        refresh,
        repo: repoFullName,
        minStars: starRange.minStars,
        maxStars: starRange.maxStars,
      },
      ...(emptyExplanation ? { emptyExplanation } : {}),
      nextActions: rankedIssues.length === 0 ? ['broaden_profile_filters'] : ['inspect_ranked_opportunities'],
    };
  }

  async showInbox(): Promise<void> {
    const result = await this.getInboxMachineResult();
    const { items } = result;

    ui.hero({
      label: 'OpenMeta Inbox',
      title: items.length > 0 ? "Keep the right opportunities within arm's reach" : 'The shortlist is quiet for now',
      subtitle: 'This is the retained shortlist: drafted, scored, and kept close for the next sharp move.',
      tone: items.length > 0 ? 'accent' : 'warning',
    });

    if (items.length === 0) {
      ui.emptyState(
        'OpenMeta Inbox',
        'No drafted opportunities yet',
        'Run "openmeta scout" or "openmeta agent" to populate the inbox.',
      );
      return;
    }

    ui.stats('Inbox snapshot', [
      { label: 'Items', value: String(items.length), tone: 'success' },
      { label: 'Ready', value: String(items.filter((item) => item.status === 'ready').length), tone: 'accent' },
      { label: 'Top score', value: String(items[0]?.overallScore || 0), tone: 'info' },
      { label: 'Latest', value: this.formatDate(items[0]?.generatedAt), tone: 'info' },
    ]);

    ui.recordList(
      'Drafted opportunities',
      items.slice(0, 10).map((item) => ({
        title: `${item.repoFullName}#${item.issueNumber}`,
        subtitle: item.issueTitle,
        meta: [
          `overall ${item.overallScore}`,
          `opportunity ${item.opportunityScore}`,
          `status ${item.status}`,
          `generated ${this.formatDate(item.generatedAt)}`,
        ],
        lines: [`Summary: ${item.summary}`, `Artifacts: ${item.artifactDir}`],
        tone: item.status === 'ready' ? 'success' : 'info',
      })),
    );
  }

  async showProofOfWork(): Promise<void> {
    const result = await this.getProofOfWorkMachineResult();
    const { records } = result;

    ui.hero({
      label: 'OpenMeta PoW',
      title:
        records.length > 0 ? 'Keep a readable trail of work that actually landed' : 'No trail has been written yet',
      subtitle: 'Every run leaves a ledger of what was chosen, what changed, and what reached publication.',
      tone: records.length > 0 ? 'accent' : 'warning',
    });

    if (records.length === 0) {
      ui.emptyState('OpenMeta PoW', 'No proof of work yet', 'Run "openmeta agent" to generate contribution evidence.');
      return;
    }

    ui.stats('Proof of work snapshot', [
      { label: 'Records', value: String(records.length), tone: 'success' },
      { label: 'Published', value: String(records.filter((record) => record.published).length), tone: 'accent' },
      { label: 'Top score', value: String(records[0]?.overallScore || 0), tone: 'info' },
      { label: 'Latest', value: this.formatDate(records[0]?.generatedAt), tone: 'info' },
    ]);

    ui.recordList(
      'Recorded runs',
      records.slice(0, 10).map((record) => ({
        title: `${record.repoFullName}#${record.issueNumber}`,
        subtitle: record.issueTitle,
        meta: [
          `overall ${record.overallScore}`,
          `opportunity ${record.opportunityScore}`,
          `published ${record.published ? 'yes' : 'no'}`,
          `generated ${this.formatDate(record.generatedAt)}`,
        ],
        lines: [
          `Artifacts: ${record.artifactDir}`,
          `Branch: ${record.branchName || 'n/a'}`,
          `Pull Request: ${record.pullRequestUrl || 'not created'}`,
        ],
        tone: record.published ? 'success' : 'info',
      })),
    );
  }

  async getInboxMachineResult(): Promise<{
    items: ReturnType<typeof inboxService.load>['items'];
    inboxPath: string;
    nextActions: string[];
  }> {
    const items = [...inboxService.load().items].sort((left, right) => right.overallScore - left.overallScore);

    return {
      items,
      inboxPath: inboxService.getPath(),
      nextActions: items.length === 0 ? ['run_machine_scout'] : ['inspect_artifact_paths'],
    };
  }

  async getProofOfWorkMachineResult(): Promise<{
    records: ReturnType<typeof proofOfWorkService.load>['records'];
    proofOfWorkPath: string;
    nextActions: string[];
  }> {
    const records = [...proofOfWorkService.load().records].sort((left, right) =>
      right.generatedAt.localeCompare(left.generatedAt),
    );

    return {
      records,
      proofOfWorkPath: proofOfWorkService.getPath(),
      nextActions: records.length === 0 ? ['run_machine_agent'] : ['inspect_recent_publications'],
    };
  }

  private renderAgentStage(
    currentStage: AgentStageId,
    completedStages: Set<AgentStageId>,
    subtitle: string,
    failed: boolean = false,
  ): void {
    const currentIndex = AGENT_STAGES.findIndex((stage) => stage.id === currentStage);
    const currentLabel = AGENT_STAGES[currentIndex]?.label || currentStage;

    ui.stepper(
      'Agent flow',
      AGENT_STAGES.map((stage, index) => ({
        label: stage.label,
        description: stage.description,
        state: completedStages.has(stage.id)
          ? 'done'
          : stage.id === currentStage
            ? failed
              ? 'error'
              : 'active'
            : index < currentIndex
              ? 'done'
              : 'pending',
      })),
    );

    ui.section(`${currentLabel} stage`, subtitle);
  }

  private renderOpportunityList(title: string, issues: RankedIssue[]): void {
    ui.recordList(
      title,
      issues.map((issue, index) => {
        const bodyExcerpt = issue.body.replace(/\s+/g, ' ').trim().slice(0, 180);
        const hint = issue.scoutFeasibility;

        return {
          title: `${index + 1}. ${issue.repoFullName}#${issue.number}`,
          subtitle: issue.title,
          meta: [
            ...(hint ? [`adjusted ${hint.adjustedOverallScore}`] : []),
            `overall ${issue.opportunity.overallScore}`,
            `match ${issue.matchScore}`,
            `opportunity ${issue.opportunity.score}`,
            ...(issue.claimAssessment?.status && issue.claimAssessment.status !== 'none'
              ? [`claim ${issue.claimAssessment.status}`]
              : []),
            ...(hint ? [`feasibility ${hint.level}`] : []),
            `stars ${issue.repoStars}`,
          ],
          lines: [
            `Labels: ${issue.labels.join(', ') || 'none'}`,
            `Tech: ${issue.analysis.techRequirements.join(', ') || 'n/a'}`,
            `Workload: ${issue.analysis.estimatedWorkload || 'n/a'}`,
            ...(issue.claimAssessment?.evidence[0] ? [`Claim evidence: ${issue.claimAssessment.evidence[0]}`] : []),
            ...(hint
              ? [
                  `Feasibility: ${hint.level} (${hint.issueScope}, ${hint.scoreAdjustment >= 0 ? '+' : ''}${hint.scoreAdjustment})`,
                  `Feasibility note: ${hint.explanation}`,
                ]
              : []),
            `Updated: ${this.formatDate(issue.updatedAt)} | Created: ${this.formatDate(issue.createdAt)}`,
            `Summary: ${issue.opportunity.summary}`,
            ...(bodyExcerpt ? [`Issue: ${bodyExcerpt}`] : []),
            `Link: ${issue.htmlUrl}`,
          ],
          tone: index === 0 ? 'accent' : 'info',
        };
      }),
    );
  }

  private showSelectedOpportunity(issue: RankedIssue, headless: boolean): void {
    ui.card({
      label: 'OpenMeta Agent',
      title: headless ? 'Automation selected this opportunity' : 'Selected opportunity',
      subtitle: issue.title,
      lines: [
        `Repository: ${issue.repoFullName}`,
        `Summary: ${issue.opportunity.summary}`,
        ...(issue.claimAssessment
          ? [
              `Claim risk: ${issue.claimAssessment.status}`,
              ...(issue.claimAssessment.evidence[0] ? [`Claim evidence: ${issue.claimAssessment.evidence[0]}`] : []),
            ]
          : []),
        ...(issue.scoutFeasibility
          ? [
              `Scout feasibility: ${issue.scoutFeasibility.level} (${issue.scoutFeasibility.issueScope}, adjusted ${issue.scoutFeasibility.adjustedOverallScore})`,
            ]
          : []),
        `Demand: ${issue.analysis.coreDemand || 'n/a'}`,
        `Link: ${issue.htmlUrl}`,
      ],
      tone: 'accent',
    });

    ui.stats('Selected issue metrics', [
      { label: 'Overall', value: String(issue.opportunity.overallScore), tone: 'success' },
      ...(issue.scoutFeasibility
        ? [{ label: 'Adjusted', value: String(issue.scoutFeasibility.adjustedOverallScore), tone: 'warning' as const }]
        : []),
      { label: 'Match', value: String(issue.matchScore), tone: 'info' },
      { label: 'Opportunity', value: String(issue.opportunity.score), tone: 'accent' },
      { label: 'Stars', value: String(issue.repoStars), tone: 'info' },
    ]);

    ui.keyValues('Selected issue context', [
      { label: 'Labels', value: issue.labels.join(', ') || 'none', tone: 'info' },
      { label: 'Tech requirements', value: issue.analysis.techRequirements.join(', ') || 'n/a', tone: 'info' },
      { label: 'Workload', value: issue.analysis.estimatedWorkload || 'n/a', tone: 'info' },
      { label: 'Updated', value: this.formatDate(issue.updatedAt), tone: 'info' },
    ]);
  }

  private showWorkspaceSummary(workspace: RepoWorkspaceContext, memory: ContributionAgentResult['memory']): void {
    ui.stats('Workspace snapshot', [
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
      { label: 'Memory dossiers', value: String(memory.generatedDossiers), tone: 'info' },
    ]);

    ui.keyValues('Workspace details', [
      { label: 'Path', value: workspace.workspacePath, tone: 'info' },
      { label: 'Default branch', value: workspace.defaultBranch, tone: 'info' },
      { label: 'Working branch', value: workspace.branchName || 'workspace already dirty', tone: 'info' },
      { label: 'Top-level files', value: workspace.topLevelFiles.slice(0, 8).join(', ') || 'n/a', tone: 'info' },
    ]);

    ui.recordList('Repository context', [
      {
        title: 'Candidate files',
        meta: [`${workspace.candidateFiles.length} file(s)`],
        lines: workspace.candidateFiles.slice(0, 8).map((file) => file),
        tone: 'info',
      },
      {
        title: 'Detected validation commands',
        meta: [`${workspace.testCommands.length} command(s)`],
        lines:
          workspace.testCommands.length > 0
            ? workspace.testCommands
                .slice(0, 5)
                .map((command) => `${command.command} (${command.reason}; ${command.source})`)
            : ['No baseline validation command detected.'],
        tone: workspace.testCommands.length > 0 ? 'accent' : 'warning',
      },
      {
        title: 'Runnable validation commands',
        meta: [`${workspace.validationCommands.length} command(s)`],
        lines:
          workspace.validationCommands.length > 0
            ? workspace.validationCommands.slice(0, 5).map((command) => `${command.command} (${command.source})`)
            : ['No validation command is eligible to run in this mode.'],
        tone: workspace.validationCommands.length > 0 ? 'success' : 'warning',
      },
    ]);

    if (workspace.validationWarnings.length > 0) {
      ui.recordList(
        'Validation safety notes',
        workspace.validationWarnings.map((warning) => ({
          title: 'Skipped command',
          lines: [warning],
          tone: 'warning',
        })),
      );
    }
  }

  private showValidationSummary(workspace: RepoWorkspaceContext, changedFiles: string[]): void {
    const counts = this.countValidationStates(workspace.testResults);

    ui.stats('Validation snapshot', [
      {
        label: 'Changed files',
        value: String(changedFiles.length),
        tone: changedFiles.length > 0 ? 'accent' : 'muted',
      },
      { label: 'Passed', value: String(counts.passed), tone: counts.passed > 0 ? 'success' : 'muted' },
      { label: 'Failed', value: String(counts.failed), tone: counts.failed > 0 ? 'warning' : 'muted' },
      { label: 'Unavailable', value: String(counts.unavailable), tone: counts.unavailable > 0 ? 'warning' : 'muted' },
    ]);

    if (workspace.testResults.length === 0) {
      ui.callout({
        label: 'OpenMeta Agent',
        title: 'Validation was not executed',
        subtitle:
          workspace.validationCommands.length === 0
            ? 'No validation command was eligible to run in the current mode.'
            : workspace.testCommands.length === 0
              ? 'No baseline validation command was detected in the repository.'
              : 'This run skipped baseline validation commands.',
        tone: 'warning',
      });
      return;
    }

    ui.recordList(
      'Validation commands',
      workspace.testResults.map((result) => ({
        title: result.command,
        subtitle: result.passed
          ? 'passed'
          : this.isInfrastructureValidationFailure(result)
            ? 'unavailable in this environment'
            : 'failed',
        meta: [`exit ${result.exitCode ?? 'n/a'}`],
        lines: [result.output.trim().slice(0, 220) || 'No output captured.'],
        tone: result.passed ? 'success' : this.isInfrastructureValidationFailure(result) ? 'warning' : 'error',
      })),
    );
  }

  private showArtifactPreview(input: {
    issue: RankedIssue;
    artifactRelativeDir: string;
    draftTitle: string;
    changedFiles: string[];
    validationResults: TestResult[];
    pullRequestUrl?: string;
  }): void {
    ui.card({
      label: 'OpenMeta Agent',
      title: 'Artifact preview',
      subtitle: 'OpenMeta generated a dossier, patch draft, PR draft, inbox update, and proof-of-work update.',
      lines: [
        `Target directory: ${input.artifactRelativeDir}`,
        `PR draft title: ${input.draftTitle}`,
        `Contribution PR: ${input.pullRequestUrl || 'not created'}`,
      ],
      tone: 'info',
    });

    ui.keyValues('Artifact details', [
      { label: 'Issue', value: `${input.issue.repoFullName}#${input.issue.number}`, tone: 'info' },
      { label: 'Overall score', value: String(input.issue.opportunity.overallScore), tone: 'success' },
      {
        label: 'Changed files',
        value: input.changedFiles.length > 0 ? input.changedFiles.join(', ') : 'none',
        tone: 'info',
      },
      { label: 'Validation', value: this.formatValidationSummary(input.validationResults), tone: 'info' },
      { label: 'Artifact branch', value: ARTIFACT_PUBLISH_BRANCH, tone: 'info' },
    ]);
  }

  private async validateConfig(
    config: AppConfig,
    options: { requireGithub?: boolean; requireLlm?: boolean } = {},
  ): Promise<void> {
    const requireGithub = options.requireGithub ?? true;
    const requireLlm = options.requireLlm ?? true;

    if (requireGithub && (!config.github.pat || !config.github.username)) {
      throw new Error('GitHub configuration is incomplete. Please run "openmeta init" first.');
    }

    if (requireLlm && !config.llm.apiKey) {
      throw new Error('LLM API configuration is incomplete. Please run "openmeta init" first.');
    }
  }

  private async initializeClients(
    config: AppConfig,
    options: {
      validateGithub?: boolean;
      validateLlm?: boolean;
      taskSteps?: {
        github?: { index: number; total: number };
        llm?: { index: number; total: number };
      };
    } = {},
  ): Promise<void> {
    const validateGithub = options.validateGithub ?? true;
    const validateLlm = options.validateLlm ?? true;
    githubService.initialize(config.github.pat, config.github.username);

    if (validateGithub) {
      const ghValid = await ui.task(
        {
          title: 'Validating GitHub access',
          doneMessage: 'GitHub access verified',
          failedMessage: 'GitHub access failed',
          tone: 'info',
          step: options.taskSteps?.github,
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
    }

    this.octokit = new Octokit({ auth: config.github.pat });
    contributionPrService.initialize(this.octokit);
    if (!validateLlm) {
      return;
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
        step: options.taskSteps?.llm,
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

  private async promptForIssue(issues: RankedIssue[]): Promise<RankedIssue> {
    const topIssues = issues.slice(0, 5);

    try {
      return await selectPrompt<RankedIssue>({
        message: 'Select an opportunity to draft:',
        pageSize: Math.min(10, topIssues.length),
        choices: topIssues.map((issue) => ({
          name: `${issue.repoFullName}#${issue.number}`,
          description: `overall ${issue.opportunity.overallScore} | ${issue.title.slice(0, 72)}`,
          value: issue,
        })),
      });
    } catch (error) {
      if (isUserCancelledError(error)) {
        throw error;
      }

      logger.warn('Interactive select UI is unavailable. Falling back to numeric input.');
    }

    while (true) {
      const { selectedIndex } = await prompt<{ selectedIndex: string }>([
        {
          type: 'input',
          name: 'selectedIndex',
          message: `Type the opportunity number to draft (1-${topIssues.length}):`,
          validate: (input: string) => {
            const parsed = Number.parseInt(input.trim(), 10);
            if (Number.isNaN(parsed) || parsed < 1 || parsed > topIssues.length) {
              return `Enter a number between 1 and ${topIssues.length}.`;
            }

            return true;
          },
        },
      ]);

      const index = Number.parseInt(selectedIndex.trim(), 10) - 1;
      const selectedIssue = topIssues[index];
      if (selectedIssue) {
        return selectedIssue;
      }

      ui.banner({
        label: 'OpenMeta Agent',
        title: 'Invalid selection',
        subtitle: `OpenMeta could not match "${selectedIndex}" to one of the displayed opportunities. Try again.`,
        tone: 'warning',
      });
    }
  }

  private async loadPresetRankedIssues(
    config: AppConfig,
    repos: string[],
    options: {
      refresh?: boolean;
      minStars?: number;
      maxStars?: number;
      onStatus?: (message: string) => void;
    } = {},
  ): Promise<RankedIssue[]> {
    const issueMap = new Map<string, RankedIssue>();

    for (const repoFullName of repos) {
      options.onStatus?.(`Scouting ${repoFullName}`);
      const issues = await issueRankingService.loadRankedIssues(config, {
        refresh: options.refresh,
        repoFullName,
        minStars: options.minStars,
        maxStars: options.maxStars,
      });

      for (const issue of issues) {
        const key = `${issue.repoFullName}#${issue.number}`;
        const existing = issueMap.get(key);
        if (
          !existing ||
          issueRankingService.getAdjustedOverallScore(issue) > issueRankingService.getAdjustedOverallScore(existing)
        ) {
          issueMap.set(key, issue);
        }
      }
    }

    return [...issueMap.values()].sort(
      (left, right) =>
        issueRankingService.getAdjustedOverallScore(right) - issueRankingService.getAdjustedOverallScore(left) ||
        right.opportunity.overallScore - left.opportunity.overallScore ||
        right.matchScore - left.matchScore ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private async runPresetAnalysisFallback(input: {
    config: AppConfig;
    repos: string[];
    headless: boolean;
    runChecks: boolean;
    draftOnly: boolean;
    refresh: boolean;
    options: AgentRunOptions;
    completedStages: Set<AgentStageId>;
  }): Promise<void> {
    ui.callout({
      label: 'OpenMeta Agent',
      title: 'Preset issue scout did not clear the automation threshold',
      subtitle: 'OpenMeta will switch from issue-first scouting to repository analysis across the active preset.',
      lines: [`Repositories: ${input.repos.join(', ')}`, `Threshold: ${input.config.automation.minMatchScore}/100`],
      tone: 'info',
    });

    const selectedCandidate = await this.selectPresetAnalysisCandidate(input.repos, {
      headless: input.headless,
      runChecks: input.runChecks,
    });
    const selectedIssue = this.buildSyntheticIssueFromSuggestion(
      selectedCandidate.repoFullName,
      selectedCandidate.suggestion,
    );
    const memory = selectedCandidate.memory;
    const completedStages = input.completedStages;
    completedStages.add('select');
    this.showSelectedOpportunity(selectedIssue, input.headless);

    this.renderAgentStage('prepare', completedStages, `Cloning and inspecting ${selectedIssue.repoFullName}.`);
    completedStages.add('prepare');
    this.showWorkspaceSummary(selectedCandidate.workspace, memory);
    const feasibilityPolicy = await this.assessExecutionFeasibility({
      issue: selectedIssue,
      workspace: selectedCandidate.workspace,
      headless: input.headless,
      draftOnly: input.draftOnly,
      localArtifactsOnly: Boolean(input.options.localArtifactsOnly),
    });
    if (feasibilityPolicy.shouldStop) {
      completedStages.add('draft');
      this.renderAgentStage(
        'draft',
        completedStages,
        `Execution stopped before patch generation: ${feasibilityPolicy.assessment.summary}`,
        true,
      );
      return;
    }

    this.renderAgentStage(
      'draft',
      completedStages,
      'Drafting patch strategy and turning it into concrete file changes.',
    );
    const patchDraftResult = await ui.task(
      {
        title: 'Generating patch strategy',
        doneMessage: 'Patch strategy generated',
        failedMessage: 'Patch strategy generation failed',
        tone: 'info',
      },
      async () => llmService.generatePatchDraft(selectedIssue, selectedCandidate.workspace, memory),
    );
    const patchDraft = patchDraftResult.data;
    if (patchDraftResult.status !== 'success') {
      this.showStructuredReviewNotice({
        title: 'Patch strategy requires review',
        subtitle:
          'OpenMeta marked the generated patch plan as review-required, so this run will preserve artifacts but skip concrete code edits.',
        lines: [`Goal: ${patchDraft.goal}`],
      });
    }
    const implementationWorkspace = this.buildImplementationWorkspace(selectedCandidate.workspace, patchDraft);
    const implementation =
      patchDraftResult.status === 'success'
        ? await this.generateConcretePatch(
            selectedIssue,
            implementationWorkspace,
            patchDraft,
            input.runChecks,
            feasibilityPolicy.effectiveDraftOnly,
          )
        : {
            changedFiles: [],
            validationResults: implementationWorkspace.testResults,
            reviewRequired: true,
          };
    completedStages.add('draft');
    const workspaceForArtifacts: RepoWorkspaceContext = {
      ...implementationWorkspace,
      testResults: implementation.validationResults,
    };

    this.renderAgentStage(
      'validate',
      completedStages,
      'Reviewing validation outcomes before opening or publishing anything.',
    );
    this.showValidationSummary(workspaceForArtifacts, implementation.changedFiles);
    completedStages.add('validate');

    this.renderAgentStage('pr', completedStages, 'Drafting PR narrative and deciding whether to open a real draft PR.');
    const prDraftResult = await ui.task(
      {
        title: 'Generating PR narrative',
        doneMessage: 'PR narrative generated',
        failedMessage: 'PR narrative generation failed',
        tone: 'info',
      },
      async () => llmService.generatePrDraft(selectedIssue, patchDraft, workspaceForArtifacts),
    );
    const prDraft = prDraftResult.data;
    if (prDraftResult.status !== 'success') {
      this.showStructuredReviewNotice({
        title: 'PR narrative requires review',
        subtitle:
          'OpenMeta marked the generated PR draft as review-required, so this run will stay in draft-only mode and skip opening a real PR.',
        lines: [`Title: ${prDraft.title}`],
      });
    }
    const patchDraftMarkdown = contentService.formatPatchDraftMarkdown(patchDraft);
    const prDraftMarkdown = contentService.formatPullRequestDraftMarkdown(prDraft);

    const contributionPullRequest = await this.submitContributionPullRequestIfPossible({
      config: input.config,
      allowRealPr:
        feasibilityPolicy.allowRealPr && patchDraftResult.status === 'success' && prDraftResult.status === 'success',
      headless: input.headless,
      issue: selectedIssue,
      prDraft,
      workspace: workspaceForArtifacts,
      changedFiles: implementation.changedFiles,
      validationResults: implementation.validationResults,
    });
    completedStages.add('pr');

    const artifacts = this.prepareLocalArtifactPaths(selectedIssue);

    const inboxItem = {
      id: `${selectedIssue.repoFullName}#${selectedIssue.number}`,
      repoFullName: selectedIssue.repoFullName,
      issueNumber: selectedIssue.number,
      issueTitle: selectedIssue.title,
      summary: selectedIssue.opportunity.summary,
      overallScore: selectedIssue.opportunity.overallScore,
      opportunityScore: selectedIssue.opportunity.score,
      status: 'ready' as const,
      artifactDir: artifacts.artifactDir,
      generatedAt: new Date().toISOString(),
    };
    const inboxItems = inboxService.saveItem(inboxItem);

    const proofRecord = {
      id: `${selectedIssue.repoFullName}#${selectedIssue.number}@${Date.now()}`,
      repoFullName: selectedIssue.repoFullName,
      issueNumber: selectedIssue.number,
      issueTitle: selectedIssue.title,
      overallScore: selectedIssue.opportunity.overallScore,
      opportunityScore: selectedIssue.opportunity.score,
      branchName: workspaceForArtifacts.branchName,
      artifactDir: artifacts.artifactDir,
      generatedAt: new Date().toISOString(),
      published: false,
      pullRequestUrl: contributionPullRequest.url,
      pullRequestNumber: contributionPullRequest.number,
    };

    const dossier = contentService.formatContributionDossier(
      selectedIssue,
      workspaceForArtifacts,
      memory,
      patchDraft,
      prDraft,
    );
    const proofMarkdown = proofOfWorkService.renderMarkdown(
      [proofRecord, ...proofOfWorkService.load().records].slice(0, 100),
    );

    this.renderAgentStage(
      'publish',
      completedStages,
      'Saving dossier assets, updating long-term memory, and deciding whether to publish them.',
    );
    this.showArtifactPreview({
      issue: selectedIssue,
      artifactRelativeDir: join(
        'contributions',
        getLocalDateStamp(),
        `${selectedIssue.repoFullName.replace(/\//g, '__')}__${selectedIssue.number}`,
      ),
      draftTitle: prDraft.title,
      changedFiles: implementation.changedFiles,
      validationResults: implementation.validationResults,
      pullRequestUrl: contributionPullRequest.url,
    });

    await ui.task(
      {
        title: 'Writing local artifacts',
        doneMessage: 'Local artifacts written',
        failedMessage: 'Local artifact write failed',
        tone: 'info',
      },
      async () => {
        this.writeLocalArtifacts({
          artifacts,
          dossier,
          patchDraftMarkdown,
          prDraftMarkdown,
          memoryMarkdown: memoryService.renderMarkdown(memory),
          inboxMarkdown: inboxService.renderMarkdown(inboxItems),
          proofMarkdown,
        });
      },
    );

    const publishResult = feasibilityPolicy.effectiveLocalArtifactsOnly
      ? { published: false }
      : await this.publishArtifactsIfNeeded({
          config: input.config,
          headless: input.headless,
          dryRun: input.options.dryRun,
          issue: selectedIssue,
          patchDraftMarkdown,
          prDraftMarkdown,
          dossier,
          memoryMarkdown: memoryService.renderMarkdown(memory),
          inboxMarkdown: inboxService.renderMarkdown(inboxItems),
          proofMarkdown,
          changedFiles: implementation.changedFiles,
          validationResults: implementation.validationResults,
          pullRequestUrl: contributionPullRequest.url,
        });

    const reviewRequired =
      patchDraftResult.status !== 'success' || implementation.reviewRequired || prDraftResult.status !== 'success';
    const finalProofRecord = {
      ...proofRecord,
      published: publishResult.published,
    };
    const finalMemory = memoryService.recordOutcome({
      issue: selectedIssue,
      workspace: workspaceForArtifacts,
      changedFiles: implementation.changedFiles,
      validationResults: implementation.validationResults,
      published: publishResult.published,
      pullRequestUrl: contributionPullRequest.url,
      reviewRequired,
    });
    proofOfWorkService.record(finalProofRecord);
    const finalProofMarkdown = proofOfWorkService.renderMarkdown(proofOfWorkService.load().records);
    this.writeLocalArtifacts({
      artifacts,
      dossier,
      patchDraftMarkdown,
      prDraftMarkdown,
      memoryMarkdown: memoryService.renderMarkdown(finalMemory),
      inboxMarkdown: inboxService.renderMarkdown(inboxItems),
      proofMarkdown: finalProofMarkdown,
    });
    completedStages.add('publish');

    this.showResult({
      issue: selectedIssue,
      workspace: workspaceForArtifacts,
      memory: finalMemory,
      patchDraft,
      prDraft,
      dossier,
      artifacts,
      inboxItem,
      proofRecord: finalProofRecord,
      changedFiles: implementation.changedFiles,
      pullRequestUrl: contributionPullRequest.url,
    });
  }

  private async selectPresetAnalysisCandidate(
    repos: string[],
    options: {
      headless: boolean;
      runChecks: boolean;
    },
  ): Promise<PresetAnalyzeCandidate> {
    const candidates: PresetAnalyzeCandidate[] = [];

    for (const repoFullName of repos) {
      const memory = memoryService.load(repoFullName);
      const workspace = await ui.task(
        {
          title: `Preparing repository workspace for ${repoFullName}`,
          doneMessage: 'Repository workspace prepared',
          failedMessage: 'Repository workspace preparation failed',
          tone: 'info',
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
        },
        async () => llmService.analyzeRepository(repoFullName, workspace, memory),
      );

      candidates.push(
        ...suggestionsResult.data.map((suggestion) => ({
          repoFullName,
          workspace,
          memory,
          suggestion,
        })),
      );
    }

    if (candidates.length === 0) {
      throw new Error('No repository suggestions were generated from the active preset.');
    }

    ui.recordList(
      'Preset repository analysis candidates',
      candidates.slice(0, 5).map((candidate) => ({
        title: `${candidate.repoFullName} - ${candidate.suggestion.title}`,
        subtitle: candidate.suggestion.summary,
        meta: [`score ${candidate.suggestion.prPotentialScore}`, `workload ${candidate.suggestion.estimatedWorkload}`],
        lines: [`Files: ${candidate.suggestion.targetFiles.map((file) => file.path).join(', ')}`],
        tone: candidate.suggestion.prPotentialScore >= 80 ? 'success' : 'info',
      })),
    );

    return this.selectTopPresetAnalysisCandidate(candidates);
  }

  private selectTopPresetAnalysisCandidate(candidates: PresetAnalyzeCandidate[]): PresetAnalyzeCandidate {
    const [selected] = [...candidates].sort(
      (left, right) => right.suggestion.prPotentialScore - left.suggestion.prPotentialScore,
    );
    if (!selected) {
      throw new Error('No repository suggestions are available to select.');
    }

    return selected;
  }

  private buildSyntheticIssueFromSuggestion(
    repoFullName: string,
    suggestion: RepositoryImprovementSuggestion,
  ): RankedIssue {
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

  private prepareLocalArtifactPaths(issue: RankedIssue) {
    const dirName = `${issue.repoFullName.replace(/\//g, '__')}__${issue.number}`;
    const artifactDir = ensureDirectory(join(getOpenMetaArtifactRoot(), getLocalDateStamp(), dirName));
    const dossierPath = join(artifactDir, 'dossier.md');
    const patchDraftPath = join(artifactDir, 'patch-draft.md');
    const prDraftPath = join(artifactDir, 'pr-draft.md');
    const memoryPath = join(artifactDir, 'repo-memory.md');
    const inboxPath = join(artifactDir, 'inbox.md');
    const proofOfWorkPath = join(artifactDir, 'proof-of-work.md');

    return {
      artifactDir,
      dossierPath,
      patchDraftPath,
      prDraftPath,
      memoryPath,
      inboxPath,
      proofOfWorkPath,
    };
  }

  private writeLocalArtifacts(input: {
    artifacts: ReturnType<AgentOrchestrator['prepareLocalArtifactPaths']>;
    dossier: string;
    patchDraftMarkdown: string;
    prDraftMarkdown: string;
    memoryMarkdown: string;
    inboxMarkdown: string;
    proofMarkdown: string;
  }): void {
    writeFileSync(input.artifacts.dossierPath, input.dossier, 'utf-8');
    writeFileSync(input.artifacts.patchDraftPath, input.patchDraftMarkdown, 'utf-8');
    writeFileSync(input.artifacts.prDraftPath, input.prDraftMarkdown, 'utf-8');
    writeFileSync(input.artifacts.memoryPath, input.memoryMarkdown, 'utf-8');
    writeFileSync(input.artifacts.inboxPath, input.inboxMarkdown, 'utf-8');
    writeFileSync(input.artifacts.proofOfWorkPath, input.proofMarkdown, 'utf-8');
  }

  private buildImplementationWorkspace(workspace: RepoWorkspaceContext, patchDraft: PatchDraft): RepoWorkspaceContext {
    const patchPaths = this.collectPatchDraftPaths(patchDraft);
    const existingSnippetPaths = new Set(workspace.snippets.map((snippet) => snippet.path));
    const missingSnippetPaths = patchPaths.filter((path) => !existingSnippetPaths.has(path));
    const extraSnippets = workspaceService
      .readWorkspaceFiles(workspace.workspacePath, missingSnippetPaths)
      .filter((snippet) => snippet.content.trim().length > 0);

    if (extraSnippets.length === 0 && patchPaths.every((path) => workspace.candidateFiles.includes(path))) {
      return workspace;
    }

    if (extraSnippets.length > 0) {
      logger.info(`Loaded ${extraSnippets.length} patch target file(s) into implementation context.`);
    }

    return {
      ...workspace,
      candidateFiles: this.uniqueStrings([...workspace.candidateFiles, ...patchPaths]),
      snippets: this.mergeSnippets(workspace.snippets, extraSnippets),
    };
  }

  private collectPatchDraftPaths(patchDraft: PatchDraft): string[] {
    return this.uniqueStrings(
      [
        ...patchDraft.targetFiles.map((file) => file.path),
        ...patchDraft.proposedChanges.flatMap((change) => change.files),
      ].flatMap((path) => {
        const normalized = this.normalizePatchPath(path);
        return normalized ? [normalized] : [];
      }),
    );
  }

  private normalizePatchPath(path: string): string | null {
    const normalized = path.replace(/^\/+/, '').trim();
    if (!normalized || normalized.split(/[\\/]/).includes('..')) {
      return null;
    }

    return normalized;
  }

  private mergeSnippets(current: RepoFileSnippet[], next: RepoFileSnippet[]): RepoFileSnippet[] {
    const snippets = new Map<string, RepoFileSnippet>();

    for (const snippet of [...current, ...next]) {
      if (!snippets.has(snippet.path)) {
        snippets.set(snippet.path, snippet);
      }
    }

    return [...snippets.values()];
  }

  private uniqueStrings(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private async assessExecutionFeasibility(input: {
    issue: RankedIssue;
    workspace: RepoWorkspaceContext;
    headless: boolean;
    draftOnly: boolean;
    localArtifactsOnly: boolean;
  }): Promise<FeasibilityPolicy> {
    const environment = await issueRankingService.ensureEnvironment();
    const assessmentResult = await ui.task(
      {
        title: 'Assessing local execution feasibility',
        doneMessage: 'Execution feasibility assessed',
        failedMessage: 'Execution feasibility assessment failed',
        tone: 'info',
      },
      async () => llmService.assessIssueFeasibility(input.issue, input.workspace, environment),
    );
    const assessment = assessmentResult.data;
    const shouldStop =
      assessment.decision === 'stop_hard_blocked' || assessment.decision === 'stop_user_action_required';
    const constrainedExecution =
      assessmentResult.status !== 'success' ||
      assessment.decision === 'repair_then_proceed' ||
      assessment.decision === 'proceed_static_only' ||
      assessment.decision === 'proceed_partial_validation';
    const effectiveDraftOnly = input.draftOnly || constrainedExecution;
    const effectiveLocalArtifactsOnly = input.localArtifactsOnly || constrainedExecution || shouldStop;
    const allowRealPr = !shouldStop && !constrainedExecution;
    const skipReasons = [
      ...(assessmentResult.status !== 'success' ? ['feasibility_requires_review'] : []),
      ...(assessment.decision === 'repair_then_proceed' ? ['feasibility_repair_required'] : []),
      ...(assessment.decision === 'proceed_static_only' ? ['feasibility_static_only'] : []),
      ...(assessment.decision === 'proceed_partial_validation' ? ['feasibility_partial_validation'] : []),
      ...(assessment.decision === 'stop_hard_blocked' ? ['feasibility_hard_blocked'] : []),
      ...(assessment.decision === 'stop_user_action_required' ? ['feasibility_user_action_required'] : []),
    ];

    this.showFeasibilityAssessment(assessment, {
      constrainedExecution,
      shouldStop,
      headless: input.headless,
    });

    return {
      assessment,
      shouldStop,
      effectiveDraftOnly,
      effectiveLocalArtifactsOnly,
      allowRealPr,
      skipReasons,
    };
  }

  private showFeasibilityAssessment(
    assessment: IssueFeasibilityAssessment,
    options: { constrainedExecution: boolean; shouldStop: boolean; headless: boolean },
  ): void {
    const blockingGaps = assessment.gaps
      .filter((gap) => gap.severity === 'blocking')
      .map((gap) => `${gap.description}${gap.suggestedAction ? ` (${gap.suggestedAction})` : ''}`);
    const warningGaps = assessment.gaps
      .filter((gap) => gap.severity !== 'blocking')
      .slice(0, 3)
      .map((gap) => `${gap.description}${gap.suggestedAction ? ` (${gap.suggestedAction})` : ''}`);
    const lines = [
      `Decision: ${assessment.decision}`,
      `Execution mode: ${assessment.executionMode}`,
      `Confidence: ${assessment.confidence}`,
      ...(blockingGaps.length > 0 ? blockingGaps : warningGaps),
    ];

    if (options.shouldStop) {
      ui.callout({
        label: 'OpenMeta Agent',
        title: 'Issue is not executable on this machine yet',
        subtitle: assessment.summary,
        lines,
        tone: 'warning',
      });
      return;
    }

    if (options.constrainedExecution) {
      ui.callout({
        label: 'OpenMeta Agent',
        title: options.headless ? 'Execution constrained for unattended safety' : 'Execution will be constrained',
        subtitle: 'OpenMeta will keep this run in review-oriented artifact mode until the feasibility gap is resolved.',
        lines,
        tone: 'warning',
      });
    }
  }

  private async generateConcretePatch(
    issue: RankedIssue,
    workspace: RepoWorkspaceContext,
    patchDraft: PatchDraft,
    runChecks: boolean,
    draftOnly: boolean = false,
  ): Promise<ConcretePatchResult> {
    if (draftOnly) {
      ui.callout({
        label: 'OpenMeta Agent',
        title: 'Draft-only mode is active',
        subtitle:
          'OpenMeta will keep the patch strategy and PR narrative as artifacts without modifying repository files or opening a real PR.',
        tone: 'info',
      });
      logger.info('Skipping generated file edits because draft-only mode is active.');
      return {
        changedFiles: [],
        validationResults: workspace.testResults,
        reviewRequired: false,
        implementationAttempts: 0,
        implementationStopReason: 'draft_only',
        implementationContextFilesAdded: 0,
      };
    }

    if (workspace.workspaceDirty) {
      ui.callout({
        label: 'OpenMeta Agent',
        title: 'Workspace has existing local changes',
        subtitle:
          'OpenMeta will not apply generated file edits into a dirty workspace. Commit, stash, or review the existing changes before asking for an automatic patch.',
        lines: [`Workspace: ${workspace.workspacePath}`],
        tone: 'warning',
      });
      logger.warn(`Skipping generated file edits because the workspace is dirty: ${workspace.workspacePath}`);
      return {
        changedFiles: [],
        validationResults: workspace.testResults,
        reviewRequired: true,
        implementationAttempts: 0,
        implementationStopReason: 'dirty_workspace',
        implementationContextFilesAdded: 0,
      };
    }

    try {
      let implementationWorkspace = workspace;
      let implementationContextFilesAdded = 0;
      let implementationStopReason: ConcretePatchResult['implementationStopReason'] = 'max_attempts';
      let implementation = await ui.task(
        {
          title: 'Generating concrete patch',
          doneMessage: 'Concrete patch generated',
          failedMessage: 'Concrete patch generation failed',
          tone: 'info',
        },
        async () => llmService.generateImplementationDraft(issue, implementationWorkspace, patchDraft),
      );
      let implementationAttempts = 1;

      while (
        implementationAttempts < MAX_IMPLEMENTATION_ATTEMPTS &&
        (implementation.status !== 'success' || implementation.data.fileChanges.length === 0)
      ) {
        const expansion = workspaceService.expandImplementationContext(implementationWorkspace, {
          maxFiles: MAX_IMPLEMENTATION_EXPANSION_FILES,
        });

        if (expansion.addedFiles.length === 0) {
          implementationStopReason = 'no_new_context';
          break;
        }

        implementationContextFilesAdded += expansion.addedFiles.length;
        logger.info(
          `Implementation context expansion round ${implementationAttempts} loaded ${expansion.addedFiles.length} additional file(s).`,
        );
        implementationWorkspace = expansion.workspace;
        implementationAttempts += 1;
        implementation = await ui.task(
          {
            title: `Retrying concrete patch with expanded context (${implementationAttempts}/${MAX_IMPLEMENTATION_ATTEMPTS})`,
            doneMessage: 'Concrete patch retry generated',
            failedMessage: 'Concrete patch retry failed',
            tone: 'info',
          },
          async () => llmService.generateImplementationDraft(issue, implementationWorkspace, patchDraft),
        );
      }

      if (implementation.status !== 'success') {
        implementationStopReason =
          implementationStopReason === 'max_attempts' ? 'implementation_requires_review' : implementationStopReason;
        this.showStructuredReviewNotice({
          title: 'Concrete patch requires review',
          subtitle:
            'OpenMeta marked the implementation draft as review-required, so no repository files will be modified automatically.',
          lines: [
            implementation.data.summary ||
              'The generated implementation needs manual review before any file edits are applied.',
          ],
        });
        logger.warn('Skipping automatic file edits because the implementation draft requires review.');
        return {
          changedFiles: [],
          validationResults: implementationWorkspace.testResults,
          reviewRequired: true,
          implementationAttempts,
          implementationStopReason,
          implementationContextFilesAdded,
        };
      }

      if (implementation.data.fileChanges.length === 0) {
        implementationStopReason =
          implementationStopReason === 'max_attempts' ? 'no_changes' : implementationStopReason;
        ui.callout({
          label: 'OpenMeta Agent',
          title: 'Concrete patch not produced',
          subtitle:
            'OpenMeta could not translate the draft strategy into safe file edits from the available repository context.',
          lines: ['Draft artifacts will still be generated so you can continue from the research output.'],
          tone: 'warning',
        });
        logger.warn(
          'OpenMeta could not produce a safe concrete patch from the available repo context. Continuing with draft artifacts only.',
        );
        return {
          changedFiles: [],
          validationResults: implementationWorkspace.testResults,
          reviewRequired: false,
          implementationAttempts,
          implementationStopReason,
          implementationContextFilesAdded,
        };
      }

      ui.timeline(
        'Generated patch plan',
        implementation.data.fileChanges.slice(0, 6).map((change) => ({
          title: change.path,
          subtitle: change.reason,
          state: 'done',
        })),
      );

      const changedFiles = await ui.task(
        {
          title: `Applying ${implementation.data.fileChanges.length} generated file edit(s)`,
          doneMessage: 'Generated file edits applied',
          failedMessage: 'Generated file edits failed to apply',
          tone: 'info',
        },
        async () =>
          workspaceService.applyGeneratedChanges(workspace.workspacePath, implementation.data.fileChanges, {
            allowedPaths: implementationWorkspace.snippets.map((snippet) => snippet.path),
          }),
      );
      if (changedFiles.reviewRequired) {
        this.showStructuredReviewNotice({
          title: 'Generated patch needs manual review',
          subtitle:
            'OpenMeta refused to apply one or more generated edits because they reached outside the selected implementation context.',
          lines: [changedFiles.reviewReason || 'Review the generated patch before applying it manually.'],
        });
        logger.warn(`Generated patch requires review: ${changedFiles.reviewReason || 'unspecified reason'}`);
        return {
          changedFiles: changedFiles.appliedFiles,
          validationResults: implementationWorkspace.testResults,
          reviewRequired: true,
          implementationAttempts,
          implementationStopReason: 'apply_review_required',
          implementationContextFilesAdded,
        };
      }
      if (changedFiles.appliedFiles.length === 0) {
        ui.callout({
          label: 'OpenMeta Agent',
          title: 'Generated edits produced no file changes',
          subtitle: 'The proposed patch matched the current workspace or resolved to no effective write.',
          lines: [
            'Draft artifacts will still be preserved for manual follow-up.',
            ...changedFiles.skippedFiles.slice(0, 3).map((file) => `${file.path}: ${file.reason}`),
          ],
          tone: 'warning',
        });
        logger.warn(
          'The generated patch did not change any files in the workspace. Continuing with draft artifacts only.',
        );
        return {
          changedFiles: [],
          validationResults: implementationWorkspace.testResults,
          reviewRequired: false,
          implementationAttempts,
          implementationStopReason: 'no_effective_change',
          implementationContextFilesAdded,
        };
      }

      logger.success(`Applied ${changedFiles.appliedFiles.length} workspace file updates`);

      const validationResults =
        runChecks && implementationWorkspace.validationCommands.length > 0
          ? await ui.task(
              {
                title: 'Running baseline validation commands',
                doneMessage: 'Baseline validation complete',
                failedMessage: 'Baseline validation finished with issues',
                tone: 'info',
              },
              async () =>
                workspaceService.runValidationCommands(
                  implementationWorkspace.workspacePath,
                  implementationWorkspace.validationCommands.slice(0, 3),
                ),
            )
          : implementationWorkspace.testResults;

      if (runChecks && changedFiles.appliedFiles.length > 0 && this.hasBlockingValidationFailures(validationResults)) {
        const repaired = await this.attemptValidationRepair({
          issue,
          workspace,
          patchDraft,
          changedFiles: changedFiles.appliedFiles,
          validationResults,
        });

        if (repaired) {
          return repaired;
        }
      }

      return {
        changedFiles: changedFiles.appliedFiles,
        validationResults,
        reviewRequired: false,
        implementationAttempts,
        implementationStopReason: 'applied',
        implementationContextFilesAdded,
      };
    } catch (error) {
      logger.warn(
        'OpenMeta could not generate or apply a safe concrete patch. Continuing with research artifacts only.',
        error,
      );
      return {
        changedFiles: [],
        validationResults: workspace.testResults,
        reviewRequired: false,
        implementationAttempts: 0,
        implementationStopReason: 'generation_failed',
        implementationContextFilesAdded: 0,
      };
    }
  }

  private async publishArtifactsIfNeeded(input: {
    config: AppConfig;
    allowRealPr?: boolean;
    headless: boolean;
    dryRun?: boolean;
    issue: RankedIssue;
    patchDraftMarkdown: string;
    prDraftMarkdown: string;
    dossier: string;
    memoryMarkdown: string;
    inboxMarkdown: string;
    proofMarkdown: string;
    changedFiles: string[];
    validationResults: TestResult[];
    pullRequestUrl?: string;
  }): Promise<{ published: boolean }> {
    const publishDecision = permissionPolicyService.evaluateArtifactPublish({
      dryRun: input.dryRun,
      headless: input.headless,
    });
    logger.debug(`Artifact publish policy: ${publishDecision.outcome} - ${publishDecision.reason}`);

    const artifactRelativeDir = join(
      'contributions',
      getLocalDateStamp(),
      `${input.issue.repoFullName.replace(/\//g, '__')}__${input.issue.number}`,
    );

    if (input.dryRun) {
      ui.callout({
        label: 'Dry-run Mode',
        title: 'Artifact preview (no git changes)',
        subtitle: 'The following artifacts would be published:',
        lines: [
          `${artifactRelativeDir}/dossier.md`,
          `${artifactRelativeDir}/patch-draft.md`,
          `${artifactRelativeDir}/pr-draft.md`,
          `memory/${input.issue.repoFullName.replace(/\//g, '__')}.md`,
          'INBOX.md',
          'PROOF_OF_WORK.md',
        ],
        tone: 'info',
      });

      ui.keyValues('Dry-run preview', [
        { label: 'Issue', value: `${input.issue.repoFullName}#${input.issue.number}` },
        { label: 'Dossier', value: input.dossier.slice(0, 100) + '...' },
        { label: 'Changed files', value: input.changedFiles.length > 0 ? input.changedFiles.join(', ') : '(none)' },
      ]);

      return { published: false };
    }

    const shouldCommit = input.headless ? true : await this.promptForCommitConfirmation();
    if (!shouldCommit) {
      return { published: false };
    }

    const targetRepo = await this.ensureTargetRepo(input.config);
    const gitInitialized = await gitService.initialize(targetRepo.path);
    if (!gitInitialized) {
      throw new Error(`Failed to initialize the target repository at ${targetRepo.path}.`);
    }

    const commitMessage = `feat(agent): draft contribution for ${input.issue.repoFullName}#${input.issue.number}`;
    const finalConfirm = input.headless ? true : await this.promptForFinalCommitConfirmation(commitMessage);
    if (!finalConfirm) {
      return { published: false };
    }

    const publishResult = await gitService.writeAndPublish(
      [
        { path: join(artifactRelativeDir, 'dossier.md'), content: input.dossier },
        { path: join(artifactRelativeDir, 'patch-draft.md'), content: input.patchDraftMarkdown },
        { path: join(artifactRelativeDir, 'pr-draft.md'), content: input.prDraftMarkdown },
        { path: join('memory', `${input.issue.repoFullName.replace(/\//g, '__')}.md`), content: input.memoryMarkdown },
        { path: 'INBOX.md', content: input.inboxMarkdown },
        { path: 'PROOF_OF_WORK.md', content: input.proofMarkdown },
      ],
      commitMessage,
      {
        branchName: ARTIFACT_PUBLISH_BRANCH,
        baseBranch: targetRepo.defaultBranch,
      },
    );

    if (!publishResult) {
      throw new Error('OpenMeta could not publish the generated contribution artifacts.');
    }

    ui.card({
      label: 'OpenMeta Agent',
      title: input.pullRequestUrl
        ? 'Artifacts sealed into the ledger and linked to a live PR'
        : 'Artifacts sealed into the ledger',
      subtitle: input.pullRequestUrl
        ? 'The dossier, drafts, inbox, and proof-of-work are now committed, and the live draft PR sits in the same trail.'
        : 'The dossier, drafts, inbox, and proof-of-work now sit in a stable published trail.',
      lines: [
        `Issue: ${input.issue.repoFullName}#${input.issue.number}`,
        `Branch: ${publishResult.branch}`,
        `Files: ${publishResult.fileNames.join(', ')}`,
        ...(input.pullRequestUrl ? [`Pull Request: ${input.pullRequestUrl}`] : []),
      ],
      tone: 'success',
    });

    return { published: true };
  }

  private async submitContributionPullRequestIfPossible(input: {
    config: AppConfig;
    allowRealPr: boolean;
    headless: boolean;
    issue: RankedIssue;
    prDraft: PullRequestDraft;
    workspace: RepoWorkspaceContext;
    changedFiles: string[];
    validationResults: TestResult[];
  }): Promise<ContributionPullRequestResult> {
    if (input.changedFiles.length === 0) {
      return {
        changedFiles: [],
        validationResults: input.validationResults,
      };
    }

    const hasValidationFailures = input.validationResults.some((result) => !result.passed);
    const hasBlockingValidationFailures = this.hasBlockingValidationFailures(input.validationResults);
    const prDecision = permissionPolicyService.evaluatePullRequest({
      allowRealPr: input.allowRealPr,
      headless: input.headless,
      hasBlockingValidationFailures,
    });
    logger.debug(`Draft PR policy: ${prDecision.outcome} - ${prDecision.reason}`);

    if (prDecision.outcome !== 'allow') {
      logger.warn(`Skipping real draft PR creation: ${prDecision.reason}`);
      return {
        changedFiles: input.changedFiles,
        validationResults: input.validationResults,
      };
    }

    if (!input.headless) {
      ui.callout({
        label: 'OpenMeta Agent',
        title: 'Create a real draft PR',
        subtitle:
          'OpenMeta can push the generated patch to your fork and open a real draft PR against the upstream repository.',
        lines: [
          `Repository: ${input.issue.repoFullName}`,
          `Changed files: ${input.changedFiles.join(', ')}`,
          `Validation: ${this.formatValidationSummary(input.validationResults)}`,
        ],
        tone: 'info',
      });

      const shouldCreatePr = await this.promptForContributionPrConfirmation(input.issue);
      if (!shouldCreatePr) {
        return {
          changedFiles: input.changedFiles,
          validationResults: input.validationResults,
        };
      }

      if (hasValidationFailures) {
        const continueWithFailures = await this.promptForFailedValidationConfirmation();
        if (!continueWithFailures) {
          return {
            changedFiles: input.changedFiles,
            validationResults: input.validationResults,
          };
        }
      }
    }

    try {
      const contributionPullRequest = await contributionPrService.submitDraftPullRequest({
        issue: input.issue,
        prDraft: input.prDraft,
        workspacePath: input.workspace.workspacePath,
        changedFiles: input.changedFiles,
      });

      ui.card({
        label: 'OpenMeta Agent',
        title: 'Draft PR opened without drift',
        subtitle: 'The generated patch has been pushed to your fork and turned into a real upstream draft PR.',
        lines: [
          `Repository: ${input.issue.repoFullName}`,
          `Branch: ${contributionPullRequest.branchName}`,
          `Changed Files: ${input.changedFiles.join(', ')}`,
          `Pull Request: ${contributionPullRequest.url}`,
        ],
        tone: 'success',
      });

      return {
        branchName: contributionPullRequest.branchName,
        url: contributionPullRequest.url,
        number: contributionPullRequest.number,
        changedFiles: input.changedFiles,
        validationResults: input.validationResults,
      };
    } catch (error) {
      logger.warn(
        'Real PR submission failed. Keeping the generated patch in the local workspace and continuing with artifact publication.',
        error,
      );
      return {
        changedFiles: input.changedFiles,
        validationResults: input.validationResults,
      };
    }
  }

  private async confirmManualHeadlessRun(config: AppConfig): Promise<void> {
    ui.callout({
      label: 'OpenMeta Agent',
      title: 'Headless agent mode runs without prompts',
      subtitle:
        'This mode scouts, drafts patch and PR artifacts, can open a real upstream draft PR, updates inbox and proof-of-work, and can commit to your target repository without interactive review.',
      lines: [
        `Automation enabled: ${config.automation.enabled ? 'yes' : 'no'}`,
        `Scheduled time: ${config.automation.scheduleTime} (${config.automation.timezone})`,
        'Disable command: openmeta automation disable',
      ],
      tone: 'warning',
    });

    ui.keyValues('Headless run impact', [
      { label: 'Interactive review', value: 'skipped after this confirmation', tone: 'warning' },
      { label: 'Artifact publication', value: 'may commit and push automatically', tone: 'warning' },
      { label: 'Draft PR creation', value: 'may open a real upstream draft PR', tone: 'warning' },
      { label: 'Disable automation', value: 'openmeta automation disable', tone: 'info' },
    ]);

    const { acknowledgeRisk } = await prompt<{ acknowledgeRisk: boolean }>([
      {
        type: 'confirm',
        name: 'acknowledgeRisk',
        message:
          'Do you understand that headless agent mode can publish generated artifacts and may open a real draft PR without another review step?',
        default: false,
      },
    ]);

    if (!acknowledgeRisk) {
      throw new Error('Headless agent run cancelled because the warning was not acknowledged.');
    }

    const { finalConsent } = await prompt<{ finalConsent: boolean }>([
      {
        type: 'confirm',
        name: 'finalConsent',
        message: 'Run headless agent mode now?',
        default: false,
      },
    ]);

    if (!finalConsent) {
      throw new Error('Headless agent run cancelled at final confirmation.');
    }
  }

  private async promptForCommitConfirmation(): Promise<boolean> {
    const { confirmCommit } = await prompt<{ confirmCommit: boolean }>([
      {
        type: 'confirm',
        name: 'confirmCommit',
        message: 'Commit generated artifacts to the target repository?',
        default: true,
      },
    ]);

    return confirmCommit;
  }

  private async promptForFinalCommitConfirmation(commitMessage: string): Promise<boolean> {
    const { finalConfirm } = await prompt<{ finalConfirm: boolean }>([
      {
        type: 'confirm',
        name: 'finalConfirm',
        message: `Confirm commit message:\n"${commitMessage}"\n\nProceed with commit?`,
        default: true,
      },
    ]);

    return finalConfirm;
  }

  private async promptForContributionPrConfirmation(issue: RankedIssue): Promise<boolean> {
    const { confirmPr } = await prompt<{ confirmPr: boolean }>([
      {
        type: 'confirm',
        name: 'confirmPr',
        message: `Create a real draft PR against ${issue.repoFullName}?`,
        default: true,
      },
    ]);

    return confirmPr;
  }

  private async promptForFailedValidationConfirmation(): Promise<boolean> {
    const { continueWithFailures } = await prompt<{ continueWithFailures: boolean }>([
      {
        type: 'confirm',
        name: 'continueWithFailures',
        message: 'Some validation commands failed. Continue and open a draft PR anyway?',
        default: false,
      },
    ]);

    return continueWithFailures;
  }

  private formatValidationSummary(results: TestResult[]): string {
    if (results.length === 0) {
      return 'not executed';
    }

    return results
      .map((result) => {
        if (result.passed) {
          return `${result.command}=passed`;
        }

        if (this.isInfrastructureValidationFailure(result)) {
          return `${result.command}=unavailable (${result.exitCode ?? 'n/a'})`;
        }

        return `${result.command}=failed (${result.exitCode ?? 'n/a'})`;
      })
      .join('; ');
  }

  private hasBlockingValidationFailures(results: TestResult[]): boolean {
    return results.some((result) => !result.passed && !this.isInfrastructureValidationFailure(result));
  }

  private resolveMachineExecutionOutcome(input: {
    draftOnly: boolean;
    localArtifactsOnly: boolean;
    changedFiles: string[];
    prCreated: boolean;
    reviewRequired: boolean;
  }): MachineAgentResult['executionOutcome'] {
    if (input.reviewRequired && input.changedFiles.length === 0 && !input.prCreated) {
      return 'blocked';
    }

    if (input.localArtifactsOnly) {
      return 'local_artifacts_written';
    }

    if (input.draftOnly) {
      return 'draft_only';
    }

    if (input.prCreated) {
      return 'pr_opened';
    }

    if (input.changedFiles.length > 0) {
      return 'changes_applied';
    }

    return 'local_artifacts_written';
  }

  private isInfrastructureValidationFailure(result: TestResult): boolean {
    const output = result.output.toLowerCase();
    return (
      result.exitCode === 127 ||
      output.includes('command not found') ||
      output.includes('not recognized as an internal or external command')
    );
  }

  private async attemptValidationRepair(input: {
    issue: RankedIssue;
    workspace: RepoWorkspaceContext;
    patchDraft: PatchDraft;
    changedFiles: string[];
    validationResults: TestResult[];
  }): Promise<ConcretePatchResult | null> {
    if (input.workspace.validationCommands.length === 0) {
      return null;
    }

    ui.callout({
      label: 'OpenMeta Agent',
      title: 'Validation repair pass triggered',
      subtitle:
        'Blocking validation failures were found, so OpenMeta will attempt one constrained repair pass before continuing.',
      lines: [`Failures: ${this.formatValidationSummary(input.validationResults)}`],
      tone: 'warning',
    });

    const currentFiles = workspaceService.readWorkspaceFiles(input.workspace.workspacePath, input.changedFiles);
    const repairDraft = await ui.task(
      {
        title: 'Generating validation repair patch',
        doneMessage: 'Validation repair patch generated',
        failedMessage: 'Validation repair patch failed',
        tone: 'info',
      },
      async () =>
        llmService.generateImplementationRepairDraft(
          input.issue,
          input.patchDraft,
          input.validationResults,
          currentFiles,
        ),
    );

    if (repairDraft.status !== 'success') {
      this.showStructuredReviewNotice({
        title: 'Validation repair requires review',
        subtitle: 'OpenMeta marked the repair patch as review-required, so it will not be applied automatically.',
        lines: [
          repairDraft.data.summary ||
            'The generated repair needs manual review before any additional file edits are applied.',
        ],
      });
      logger.warn('Skipping validation repair because the generated patch requires review.');
      return {
        changedFiles: input.changedFiles,
        validationResults: input.validationResults,
        reviewRequired: true,
      };
    }

    if (repairDraft.data.fileChanges.length === 0) {
      logger.warn('Validation repair pass did not produce any additional safe file edits.');
      return null;
    }

    const repairedFiles = await ui.task(
      {
        title: `Applying ${repairDraft.data.fileChanges.length} repair edit(s)`,
        doneMessage: 'Validation repair edits applied',
        failedMessage: 'Validation repair edits failed to apply',
        tone: 'info',
      },
      async () =>
        workspaceService.applyGeneratedChanges(input.workspace.workspacePath, repairDraft.data.fileChanges, {
          allowedPaths: input.changedFiles,
        }),
    );

    if (repairedFiles.reviewRequired) {
      this.showStructuredReviewNotice({
        title: 'Validation repair needs manual review',
        subtitle:
          'OpenMeta refused to apply one or more repair edits because they reached outside the changed file set.',
        lines: [repairedFiles.reviewReason || 'Review the generated repair before applying it manually.'],
      });
      logger.warn(`Validation repair requires review: ${repairedFiles.reviewReason || 'unspecified reason'}`);
      return {
        changedFiles: input.changedFiles,
        validationResults: input.validationResults,
        reviewRequired: true,
      };
    }

    if (repairedFiles.appliedFiles.length === 0) {
      logger.warn('Validation repair pass produced no effective file changes.');
      return null;
    }

    const validationResults = await ui.task(
      {
        title: 'Re-running validation after repair',
        doneMessage: 'Repair validation complete',
        failedMessage: 'Repair validation finished with issues',
        tone: 'info',
      },
      async () =>
        workspaceService.runValidationCommands(
          input.workspace.workspacePath,
          input.workspace.validationCommands.slice(0, 3),
        ),
    );

    return {
      changedFiles: [...new Set([...input.changedFiles, ...repairedFiles.appliedFiles])],
      validationResults,
      reviewRequired: false,
    };
  }

  private countValidationStates(results: TestResult[]): { passed: number; failed: number; unavailable: number } {
    return results.reduce(
      (summary, result) => {
        if (result.passed) {
          summary.passed += 1;
          return summary;
        }

        if (this.isInfrastructureValidationFailure(result)) {
          summary.unavailable += 1;
          return summary;
        }

        summary.failed += 1;
        return summary;
      },
      { passed: 0, failed: 0, unavailable: 0 },
    );
  }

  private formatDate(value?: string): string {
    return value ? value.slice(0, 10) : 'n/a';
  }

  private showResult(result: ContributionAgentResult): void {
    ui.hero({
      label: 'OpenMeta Agent',
      title: 'The contribution arc landed cleanly',
      subtitle: 'OpenMeta moved from issue signal to working artifacts and left the full trail in a readable state.',
      lines: [
        `Artifacts: ${result.artifacts.artifactDir}`,
        ...(result.pullRequestUrl ? [`Pull Request: ${result.pullRequestUrl}`] : []),
      ],
      tone: 'success',
    });

    ui.stats('Run summary', [
      { label: 'Overall score', value: String(result.issue.opportunity.overallScore), tone: 'success' },
      { label: 'Match score', value: String(result.issue.matchScore), tone: 'info' },
      {
        label: 'Changed files',
        value: String(result.changedFiles?.length || 0),
        tone: result.changedFiles && result.changedFiles.length > 0 ? 'accent' : 'muted',
      },
      {
        label: 'Published',
        value: result.proofRecord.published ? 'YES' : 'NO',
        tone: result.proofRecord.published ? 'success' : 'muted',
      },
    ]);
    ui.keyValues('Run details', [
      { label: 'Issue', value: `${result.issue.repoFullName}#${result.issue.number}`, tone: 'info' },
      { label: 'Workspace', value: result.workspace.workspacePath, tone: 'info' },
      { label: 'Branch', value: result.workspace.branchName || 'workspace already dirty', tone: 'info' },
      {
        label: 'Changed files',
        value: result.changedFiles && result.changedFiles.length > 0 ? result.changedFiles.join(', ') : 'none',
        tone: 'info',
      },
      { label: 'Artifacts', value: result.artifacts.artifactDir, tone: 'info' },
      {
        label: 'Pull Request',
        value: result.pullRequestUrl || 'not created',
        tone: result.pullRequestUrl ? 'success' : 'muted',
      },
    ]);
  }

  private async ensureTargetRepo(config: AppConfig): Promise<TargetRepoContext> {
    if (config.github.targetRepoPath) {
      if (!existsSync(config.github.targetRepoPath)) {
        throw new Error(`Configured target repository path does not exist: ${config.github.targetRepoPath}`);
      }

      const git = simpleGit(config.github.targetRepoPath);
      const remoteUrl = await this.getOriginRemoteUrl(git);
      const parsedRepo = this.parseGitHubRepository(remoteUrl);
      const defaultBranch = await this.resolveConfiguredTargetDefaultBranch(git, parsedRepo.owner, parsedRepo.repo);

      return {
        path: config.github.targetRepoPath,
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        defaultBranch,
      };
    }

    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const repoName = 'openmeta-daily';
    const repoPath = join(homedir(), '.openmeta', repoName);

    if (!existsSync(repoPath)) {
      mkdirSync(repoPath, { recursive: true });
    }

    const git = simpleGit(repoPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      await git.init();
    }

    const remoteRepo = await this.ensureManagedRemoteRepo(config.github.username, repoName);
    await this.ensureOriginRemote(git, remoteRepo.cloneUrl);
    await this.prepareLocalRepository(git, remoteRepo.defaultBranch, remoteRepo.hasCommits);

    return {
      path: repoPath,
      owner: config.github.username,
      repo: repoName,
      defaultBranch: remoteRepo.defaultBranch,
    };
  }

  private async ensureManagedRemoteRepo(
    username: string,
    repoName: string,
  ): Promise<{ cloneUrl: string; defaultBranch: string; hasCommits: boolean }> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    try {
      const { data } = await this.octokit.rest.repos.get({
        owner: username,
        repo: repoName,
      });

      logger.success(`Connected to existing repository: ${data.html_url}`);
      return {
        cloneUrl: data.clone_url,
        defaultBranch: data.default_branch || 'main',
        hasCommits: Boolean(data.pushed_at),
      };
    } catch (error) {
      const err = error as { status?: number };
      if (err.status && err.status !== 404) {
        throw error;
      }

      const { data } = await this.octokit.rest.repos.createForAuthenticatedUser({
        name: repoName,
        private: true,
        auto_init: true,
        description: 'OpenMeta contribution dossiers and proof of work',
      });

      logger.success(`Created repository: ${data.clone_url}`);
      return {
        cloneUrl: data.clone_url,
        defaultBranch: data.default_branch || 'main',
        hasCommits: false,
      };
    }
  }

  private async ensureOriginRemote(git: SimpleGit, remoteUrl: string): Promise<void> {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((remote) => remote.name === 'origin');

    if (!origin) {
      await git.addRemote('origin', remoteUrl);
      return;
    }

    const existingUrl = origin.refs.fetch || origin.refs.push;
    if (existingUrl && existingUrl !== remoteUrl) {
      logger.warn(`Origin remote already points to ${existingUrl}. Leaving the existing remote untouched.`);
    }
  }

  private async getOriginRemoteUrl(git: SimpleGit): Promise<string> {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((remote) => remote.name === 'origin');
    const remoteUrl = origin?.refs.push || origin?.refs.fetch;

    if (!remoteUrl) {
      throw new Error('Target repository does not have an origin remote configured.');
    }

    return remoteUrl;
  }

  private parseGitHubRepository(remoteUrl: string): { owner: string; repo: string } {
    const sshMatch = remoteUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
    const owner = sshMatch?.[1];
    const repo = sshMatch?.[2];

    if (!owner || !repo) {
      throw new Error(`Unable to parse GitHub repository from remote URL: ${remoteUrl}`);
    }

    return {
      owner,
      repo,
    };
  }

  private async getGitHubRepositoryInfo(owner: string, repo: string) {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const { data } = await this.octokit.rest.repos.get({ owner, repo });
    return data;
  }

  private async resolveConfiguredTargetDefaultBranch(git: SimpleGit, owner: string, repo: string): Promise<string> {
    try {
      const repoInfo = await this.getGitHubRepositoryInfo(owner, repo);
      return repoInfo.default_branch || 'main';
    } catch (error) {
      logger.warn(
        `Unable to read GitHub metadata for ${owner}/${repo}. Falling back to the local target repository branch.`,
        error,
      );
      return this.detectLocalDefaultBranch(git);
    }
  }

  private async detectLocalDefaultBranch(git: SimpleGit): Promise<string> {
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

  private showStructuredReviewNotice(input: { title: string; subtitle: string; lines?: string[] }): void {
    ui.callout({
      label: 'OpenMeta Agent',
      title: input.title,
      subtitle: input.subtitle,
      lines: input.lines,
      tone: 'warning',
    });
  }

  private showLocalRepositoryHint(repoPath?: string): void {
    if (repoPath) {
      logger.info(`Using local repository path via isolated worktree: ${repoPath}`);
      ui.callout({
        label: 'OpenMeta Agent',
        title: 'Local repository reuse enabled',
        subtitle:
          'OpenMeta will reuse the provided local repository through an isolated worktree, create a fresh branch, and keep PR work off your existing checkout.',
        lines: [`Path: ${repoPath}`],
        tone: 'info',
      });
      return;
    }

    logger.info(
      'Tip: if this repository already exists locally, pass --repo-path <local-path>. OpenMeta will reuse it via an isolated worktree, create a fresh branch, and open the PR from that branch.',
    );
    ui.callout({
      label: 'OpenMeta Agent',
      title: 'Faster local reuse available',
      subtitle:
        'If the repository is already on disk, pass --repo-path <local-path>. OpenMeta will reuse it via an isolated worktree, create a fresh branch, and avoid another full local checkout.',
      tone: 'info',
    });
  }

  private async prepareLocalRepository(
    git: SimpleGit,
    defaultBranch: string,
    hasRemoteCommits: boolean,
  ): Promise<void> {
    if (hasRemoteCommits) {
      try {
        await git.fetch('origin', defaultBranch);
        await git.checkout(['-B', defaultBranch, `origin/${defaultBranch}`]);
        return;
      } catch (error) {
        logger.warn(
          `Unable to sync local repository with origin/${defaultBranch}. Continuing with the local branch.`,
          error,
        );
      }
    }

    const branches = await git.branchLocal();
    if (branches.all.includes(defaultBranch)) {
      await git.checkout(defaultBranch);
      return;
    }

    try {
      await git.checkoutLocalBranch(defaultBranch);
    } catch {
      await git.checkout(['-B', defaultBranch]);
    }

    // If the remote has no commits yet (newly created empty repo), push an initial commit
    // so that subsequent branch pushes have a valid base ref on the remote.
    const status = await git.status();
    if (!status.tracking) {
      await git.commit('chore: initialize repository', { '--allow-empty': null });
      await git.raw(['push', '--set-upstream', 'origin', defaultBranch]);
    }
  }
}

export const agentOrchestrator = new AgentOrchestrator();

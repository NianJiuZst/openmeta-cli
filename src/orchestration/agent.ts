import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Octokit } from '@octokit/rest';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { PatchDraft, PullRequestDraft } from '../contracts/index.js';
import type {
  AppConfig,
  ContributionAgentResult,
  GitHubIssue,
  MatchedIssue,
  RankedIssue,
  RepoFileSnippet,
  RepoWorkspaceContext,
  TestResult,
} from '../types/index.js';
import {
  configService,
  ensureDirectory,
  getLocalDateStamp,
  getOpenMetaArtifactRoot,
  isUserCancelledError,
  logger,
  prompt,
  selectPrompt,
  ui,
} from '../infra/index.js';
import {
  contentService,
  gitService,
  githubService,
  inboxService,
  llmService,
  memoryService,
  opportunityService,
  proofOfWorkService,
  workspaceService,
} from '../services/index.js';

export interface AgentRunOptions {
  headless?: boolean;
  force?: boolean;
  schedulerRun?: boolean;
  runChecks?: boolean;
  draftOnly?: boolean;
  refresh?: boolean;
  dryRun?: boolean;
}

export interface ScoutRunOptions {
  limit?: number;
  refresh?: boolean;
  localOnly?: boolean;
}

interface TargetRepoContext {
  path: string;
  owner: string;
  repo: string;
  defaultBranch: string;
}

interface DraftPullRequest {
  title: string;
  body: string;
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
}

type AgentStageId = 'scout' | 'select' | 'prepare' | 'draft' | 'validate' | 'pr' | 'publish';
const ARTIFACT_PUBLISH_BRANCH = 'openmeta-artifacts';
const ISSUE_SCORING_BATCH_SIZE = 20;
const MAX_ISSUES_FOR_LLM_SCORING = 80;

const PROFILE_TERM_ALIASES: Record<string, string[]> = {
  'typescript': ['ts', 'tsx'],
  'javascript': ['js', 'jsx'],
  'node js': ['node', 'nodejs', 'npm'],
  'react': ['jsx', 'tsx', 'component', 'hooks'],
  'vue': ['vuejs', 'component'],
  'python': ['py', 'pytest'],
  'django': ['python', 'orm'],
  'fastapi': ['python', 'api'],
  'go': ['golang'],
  'rust': ['cargo'],
  'docker': ['container', 'compose'],
  'c plus plus': ['cpp'],
};

const FOCUS_AREA_TERMS: Record<string, string[]> = {
  'web-dev': ['web', 'frontend', 'browser', 'react', 'vue', 'css', 'accessibility'],
  'backend': ['backend', 'api', 'server', 'database', 'auth'],
  'devops': ['ci', 'deploy', 'docker', 'kubernetes', 'workflow'],
  'ai-ml': ['ai', 'ml', 'model', 'prompt', 'embedding', 'inference'],
  'mobile': ['mobile', 'ios', 'android', 'swift', 'kotlin', 'react native'],
  'security': ['security', 'auth', 'permission', 'vulnerability', 'encryption'],
  'data': ['data', 'sql', 'pipeline', 'analytics', 'warehouse'],
  'open-source': ['docs', 'contributor', 'cli', 'good first issue', 'help wanted'],
};

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

  async run(options: AgentRunOptions = {}): Promise<void> {
    const config = await configService.get();
    const headless = Boolean(options.headless);
    const schedulerRun = Boolean(options.schedulerRun);
    const runChecks = typeof options.runChecks === 'boolean' ? options.runChecks : !headless;
    const draftOnly = Boolean(options.draftOnly);
    const refresh = Boolean(options.refresh);
    const completedStages = new Set<AgentStageId>();

    ui.hero({
      label: 'OpenMeta Agent',
      title: headless ? 'Let the contribution loop move with quiet precision' : 'Pull a clean contribution arc out of the noise',
      subtitle: headless
        ? 'OpenMeta will read the field, enter the repository, draft the patch path, and carry the run through to publication without another stop for review.'
        : 'OpenMeta will read the field, enter the repository, shape a patch direction, and leave behind artifacts that feel deliberate instead of improvised.',
      lines: [
        runChecks ? 'Baseline checks will fire wherever the repository exposes a safe command path.' : 'This pass will stay light and skip baseline checks.',
        draftOnly ? 'Draft-only mode will preserve artifacts without applying generated file edits or opening a PR.' : 'Generated patches can be applied after repository safety checks pass.',
        refresh ? 'Issue discovery will bypass the local search cache for this run.' : 'Issue discovery may reuse the short local search cache.',
        headless ? `Unattended selection honors the saved threshold at ${config.automation.minMatchScore}/100.` : 'You stay in control at each decision gate before anything is published.',
      ],
    });

    await this.validateConfig(config);

    if (headless && !schedulerRun) {
      await this.confirmManualHeadlessRun(config);
    }

    this.renderAgentStage('scout', completedStages, 'Verifying provider access and loading ranked opportunities.');
    await this.initializeClients(config);

    const rankedIssues = await ui.task({
      title: 'Ranking contribution opportunities',
      doneMessage: 'Opportunity ranking complete',
      failedMessage: 'Opportunity ranking failed',
      tone: 'info',
    }, async () => this.loadRankedIssues(config, { refresh }));
    if (rankedIssues.length === 0) {
      ui.emptyState(
        'OpenMeta Agent',
        'No viable issues found',
        'No issues met the current technical match threshold. Broaden your profile or try again later.',
      );
      return;
    }
    completedStages.add('scout');

    this.renderAgentStage('select', completedStages, 'Review the top ranked issues and choose the next contribution target.');
    this.renderOpportunityList('Top ranked opportunities', rankedIssues.slice(0, 5));
    const selectedIssue = headless
      ? this.selectIssueForAutomation(rankedIssues, config.automation.minMatchScore)
      : await this.promptForIssue(rankedIssues);

    if (!selectedIssue) {
      ui.emptyState(
        'OpenMeta Agent',
        'No issue met the automation threshold',
        `Top opportunities were below ${config.automation.minMatchScore}/100. Lower the threshold or widen your profile.`,
      );
      return;
    }
    completedStages.add('select');
    this.showSelectedOpportunity(selectedIssue, headless);

    this.renderAgentStage('prepare', completedStages, `Cloning and inspecting ${selectedIssue.repoFullName}.`);
    const memoryBeforeRun = memoryService.load(selectedIssue.repoFullName);
    const workspace = await ui.task({
      title: `Preparing workspace for ${selectedIssue.repoFullName}`,
      doneMessage: 'Workspace prepared',
      failedMessage: 'Workspace preparation failed',
      tone: 'info',
    }, async () => workspaceService.prepareWorkspace(
      selectedIssue,
      memoryBeforeRun,
      runChecks,
      headless ? 'headless' : 'interactive',
    ));
    const memory = memoryService.update(selectedIssue, workspace);
    completedStages.add('prepare');
    this.showWorkspaceSummary(workspace, memory);

    this.renderAgentStage('draft', completedStages, 'Drafting patch strategy and turning it into concrete file changes.');
    const patchDraftResult = await ui.task({
      title: 'Generating patch strategy',
      doneMessage: 'Patch strategy generated',
      failedMessage: 'Patch strategy generation failed',
      tone: 'info',
    }, async () => llmService.generatePatchDraft(selectedIssue, workspace, memory));
    const patchDraft = patchDraftResult.data;
    if (patchDraftResult.status !== 'success') {
      this.showStructuredReviewNotice({
        title: 'Patch strategy requires review',
        subtitle: 'OpenMeta marked the generated patch plan as review-required, so this run will preserve artifacts but skip concrete code edits.',
        lines: [
          `Goal: ${patchDraft.goal}`,
        ],
      });
    }
    const implementationWorkspace = this.buildImplementationWorkspace(workspace, patchDraft);
    const implementation = patchDraftResult.status === 'success'
      ? await this.generateConcretePatch(selectedIssue, implementationWorkspace, patchDraft, runChecks, draftOnly)
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

    this.renderAgentStage('validate', completedStages, 'Reviewing validation outcomes before opening or publishing anything.');
    this.showValidationSummary(workspaceForArtifacts, implementation.changedFiles);
    completedStages.add('validate');

    this.renderAgentStage('pr', completedStages, 'Drafting PR narrative and deciding whether to open a real draft PR.');
    const prDraftResult = await ui.task({
      title: 'Generating PR narrative',
      doneMessage: 'PR narrative generated',
      failedMessage: 'PR narrative generation failed',
      tone: 'info',
    }, async () => llmService.generatePrDraft(selectedIssue, patchDraft, workspaceForArtifacts));
    const prDraft = prDraftResult.data;
    if (prDraftResult.status !== 'success') {
      this.showStructuredReviewNotice({
        title: 'PR narrative requires review',
        subtitle: 'OpenMeta marked the generated PR draft as review-required, so this run will stay in draft-only mode and skip opening a real PR.',
        lines: [
          `Title: ${prDraft.title}`,
        ],
      });
    }
    const patchDraftMarkdown = contentService.formatPatchDraftMarkdown(patchDraft);
    const prDraftMarkdown = contentService.formatPullRequestDraftMarkdown(prDraft);

    const contributionPullRequest = await this.submitContributionPullRequestIfPossible({
      config,
      allowRealPr: patchDraftResult.status === 'success' && prDraftResult.status === 'success',
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

    const dossier = contentService.formatContributionDossier(selectedIssue, workspaceForArtifacts, memory, patchDraft, prDraft);
    const proofMarkdown = proofOfWorkService.renderMarkdown([
      proofRecord,
      ...proofOfWorkService.load().records,
    ].slice(0, 100));

    this.renderAgentStage('publish', completedStages, 'Saving dossier assets, updating long-term memory, and deciding whether to publish them.');
    this.showArtifactPreview({
      issue: selectedIssue,
      artifactRelativeDir: join('contributions', getLocalDateStamp(), `${selectedIssue.repoFullName.replace(/\//g, '__')}__${selectedIssue.number}`),
      draftTitle: prDraft.title,
      changedFiles: implementation.changedFiles,
      validationResults: implementation.validationResults,
      pullRequestUrl: contributionPullRequest.url,
    });

    await ui.task({
      title: 'Writing local artifacts',
      doneMessage: 'Local artifacts written',
      failedMessage: 'Local artifact write failed',
      tone: 'info',
    }, async () => {
      this.writeLocalArtifacts({
        artifacts,
        dossier,
        patchDraftMarkdown,
        prDraftMarkdown,
        memoryMarkdown: memoryService.renderMarkdown(memory),
        inboxMarkdown: inboxService.renderMarkdown(inboxItems),
        proofMarkdown,
      });
    });

    const publishResult = await this.publishArtifactsIfNeeded({
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
      patchDraftResult.status !== 'success'
      || implementation.reviewRequired
      || prDraftResult.status !== 'success';
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
    const limit = typeof options === 'number' ? options : options.limit ?? 10;
    const refresh = typeof options === 'number' ? false : Boolean(options.refresh);
    const localOnly = typeof options === 'number' ? false : Boolean(options.localOnly);
    const config = await configService.get();
    await this.validateConfig(config, { requireLlm: !localOnly });
    await this.initializeClients(config, { validateLlm: !localOnly });

    ui.hero({
      label: 'OpenMeta Scout',
      title: localOnly ? 'Read the field while the model stays offline' : 'Read the field before you spend your focus',
      subtitle: localOnly
        ? 'OpenMeta will use local profile heuristics to keep scouting useful even when the LLM provider is unavailable.'
        : 'OpenMeta turns a noisy issue stream into a shortlist shaped by technical fit, timing, and real opening momentum.',
      lines: [
        `Saved threshold reference: ${config.automation.minMatchScore}/100.`,
        refresh ? 'This scout run will ignore the local GitHub issue cache.' : 'This scout run may reuse the short local GitHub issue cache.',
        localOnly ? 'LLM validation and model scoring are skipped for this run.' : 'LLM scoring will refine the local candidate shortlist.',
      ],
    });

    const rankedIssues = await ui.task({
      title: 'Scoring contribution opportunities',
      doneMessage: 'Contribution opportunities scored',
      failedMessage: 'Contribution opportunity scoring failed',
      tone: 'info',
    }, async () => this.loadRankedIssues(config, { refresh, localOnly }));
    if (rankedIssues.length === 0) {
      ui.emptyState('OpenMeta Scout', 'No issues found', 'No issues met the current scoring thresholds.');
      return;
    }

    ui.stats('Scout snapshot', [
      { label: 'Ranked issues', value: String(rankedIssues.length), tone: 'success' },
      { label: 'Showing', value: String(Math.min(limit, rankedIssues.length)), tone: 'info' },
      { label: 'Top score', value: String(rankedIssues[0]?.opportunity.overallScore || 0), tone: 'accent' },
      { label: 'Profile threshold', value: `${config.automation.minMatchScore}`, tone: 'info' },
    ]);
    this.renderOpportunityList('Ranked opportunities', this.diversifyScoutIssues(rankedIssues, limit));
  }

  async showInbox(): Promise<void> {
    const items = [...inboxService.load().items]
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));

    ui.hero({
      label: 'OpenMeta Inbox',
      title: items.length > 0 ? 'Keep the right opportunities within arm\'s reach' : 'The shortlist is quiet for now',
      subtitle: 'This is the retained shortlist: drafted, scored, and kept close for the next sharp move.',
      tone: items.length > 0 ? 'accent' : 'warning',
    });

    if (items.length === 0) {
      ui.emptyState('OpenMeta Inbox', 'No drafted opportunities yet', 'Run "openmeta scout" or "openmeta agent" to populate the inbox.');
      return;
    }

    ui.stats('Inbox snapshot', [
      { label: 'Items', value: String(items.length), tone: 'success' },
      { label: 'Ready', value: String(items.filter((item) => item.status === 'ready').length), tone: 'accent' },
      { label: 'Top score', value: String(items[0]?.overallScore || 0), tone: 'info' },
      { label: 'Latest', value: this.formatDate(items[0]?.generatedAt), tone: 'info' },
    ]);

    ui.recordList('Drafted opportunities', items.slice(0, 10).map((item) => ({
      title: `${item.repoFullName}#${item.issueNumber}`,
      subtitle: item.issueTitle,
      meta: [
        `overall ${item.overallScore}`,
        `opportunity ${item.opportunityScore}`,
        `status ${item.status}`,
        `generated ${this.formatDate(item.generatedAt)}`,
      ],
      lines: [
        `Summary: ${item.summary}`,
        `Artifacts: ${item.artifactDir}`,
      ],
      tone: item.status === 'ready' ? 'success' : 'info',
    })));
  }

  async showProofOfWork(): Promise<void> {
    const records = [...proofOfWorkService.load().records]
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));

    ui.hero({
      label: 'OpenMeta PoW',
      title: records.length > 0 ? 'Keep a readable trail of work that actually landed' : 'No trail has been written yet',
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

    ui.recordList('Recorded runs', records.slice(0, 10).map((record) => ({
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
    })));
  }

  private renderAgentStage(
    currentStage: AgentStageId,
    completedStages: Set<AgentStageId>,
    subtitle: string,
    failed: boolean = false,
  ): void {
    const currentIndex = AGENT_STAGES.findIndex((stage) => stage.id === currentStage);
    const currentLabel = AGENT_STAGES[currentIndex]?.label || currentStage;

    ui.stepper('Agent flow', AGENT_STAGES.map((stage, index) => ({
      label: stage.label,
      description: stage.description,
      state: completedStages.has(stage.id)
        ? 'done'
        : stage.id === currentStage
          ? (failed ? 'error' : 'active')
          : index < currentIndex
            ? 'done'
            : 'pending',
    })));

    ui.section(
      `${currentLabel} stage`,
      subtitle,
    );
  }

  private renderOpportunityList(title: string, issues: RankedIssue[]): void {
    ui.recordList(title, issues.map((issue, index) => {
      const bodyExcerpt = issue.body.replace(/\s+/g, ' ').trim().slice(0, 180);

      return {
        title: `${index + 1}. ${issue.repoFullName}#${issue.number}`,
        subtitle: issue.title,
        meta: [
          `overall ${issue.opportunity.overallScore}`,
          `match ${issue.matchScore}`,
          `opportunity ${issue.opportunity.score}`,
          `stars ${issue.repoStars}`,
        ],
        lines: [
          `Labels: ${issue.labels.join(', ') || 'none'}`,
          `Tech: ${issue.analysis.techRequirements.join(', ') || 'n/a'}`,
          `Workload: ${issue.analysis.estimatedWorkload || 'n/a'}`,
          `Updated: ${this.formatDate(issue.updatedAt)} | Created: ${this.formatDate(issue.createdAt)}`,
          `Summary: ${issue.opportunity.summary}`,
          ...(bodyExcerpt ? [`Issue: ${bodyExcerpt}`] : []),
          `Link: ${issue.htmlUrl}`,
        ],
        tone: index === 0 ? 'accent' : 'info',
      };
    }));
  }

  private showSelectedOpportunity(issue: RankedIssue, headless: boolean): void {
    ui.card({
      label: 'OpenMeta Agent',
      title: headless ? 'Automation selected this opportunity' : 'Selected opportunity',
      subtitle: issue.title,
      lines: [
        `Repository: ${issue.repoFullName}`,
        `Summary: ${issue.opportunity.summary}`,
        `Demand: ${issue.analysis.coreDemand || 'n/a'}`,
        `Link: ${issue.htmlUrl}`,
      ],
      tone: 'accent',
    });

    ui.stats('Selected issue metrics', [
      { label: 'Overall', value: String(issue.opportunity.overallScore), tone: 'success' },
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
      { label: 'Detected checks', value: String(workspace.testCommands.length), tone: workspace.testCommands.length > 0 ? 'info' : 'muted' },
      { label: 'Runnable checks', value: String(workspace.validationCommands.length), tone: workspace.validationCommands.length > 0 ? 'accent' : 'muted' },
      { label: 'Dirty workspace', value: workspace.workspaceDirty ? 'YES' : 'NO', tone: workspace.workspaceDirty ? 'warning' : 'success' },
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
        lines: workspace.testCommands.length > 0
          ? workspace.testCommands.slice(0, 5).map((command) => `${command.command} (${command.reason}; ${command.source})`)
          : ['No baseline validation command detected.'],
        tone: workspace.testCommands.length > 0 ? 'accent' : 'warning',
      },
      {
        title: 'Runnable validation commands',
        meta: [`${workspace.validationCommands.length} command(s)`],
        lines: workspace.validationCommands.length > 0
          ? workspace.validationCommands.slice(0, 5).map((command) => `${command.command} (${command.source})`)
          : ['No validation command is eligible to run in this mode.'],
        tone: workspace.validationCommands.length > 0 ? 'success' : 'warning',
      },
    ]);

    if (workspace.validationWarnings.length > 0) {
      ui.recordList('Validation safety notes', workspace.validationWarnings.map((warning) => ({
        title: 'Skipped command',
        lines: [warning],
        tone: 'warning',
      })));
    }
  }

  private showValidationSummary(workspace: RepoWorkspaceContext, changedFiles: string[]): void {
    const counts = this.countValidationStates(workspace.testResults);

    ui.stats('Validation snapshot', [
      { label: 'Changed files', value: String(changedFiles.length), tone: changedFiles.length > 0 ? 'accent' : 'muted' },
      { label: 'Passed', value: String(counts.passed), tone: counts.passed > 0 ? 'success' : 'muted' },
      { label: 'Failed', value: String(counts.failed), tone: counts.failed > 0 ? 'warning' : 'muted' },
      { label: 'Unavailable', value: String(counts.unavailable), tone: counts.unavailable > 0 ? 'warning' : 'muted' },
    ]);

    if (workspace.testResults.length === 0) {
      ui.callout({
        label: 'OpenMeta Agent',
        title: 'Validation was not executed',
        subtitle: workspace.validationCommands.length === 0
          ? 'No validation command was eligible to run in the current mode.'
          : workspace.testCommands.length === 0
            ? 'No baseline validation command was detected in the repository.'
          : 'This run skipped baseline validation commands.',
        tone: 'warning',
      });
      return;
    }

    ui.recordList('Validation commands', workspace.testResults.map((result) => ({
      title: result.command,
      subtitle: result.passed
        ? 'passed'
        : this.isInfrastructureValidationFailure(result)
          ? 'unavailable in this environment'
          : 'failed',
      meta: [
        `exit ${result.exitCode ?? 'n/a'}`,
      ],
      lines: [
        result.output.trim().slice(0, 220) || 'No output captured.',
      ],
      tone: result.passed ? 'success' : this.isInfrastructureValidationFailure(result) ? 'warning' : 'error',
    })));
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
      { label: 'Changed files', value: input.changedFiles.length > 0 ? input.changedFiles.join(', ') : 'none', tone: 'info' },
      { label: 'Validation', value: this.formatValidationSummary(input.validationResults), tone: 'info' },
      { label: 'Artifact branch', value: ARTIFACT_PUBLISH_BRANCH, tone: 'info' },
    ]);
  }

  private async validateConfig(
    config: AppConfig,
    options: { requireLlm?: boolean } = {},
  ): Promise<void> {
    const requireLlm = options.requireLlm ?? true;

    if (!config.github.pat || !config.github.username) {
      throw new Error('GitHub configuration is incomplete. Please run "openmeta init" first.');
    }

    if (requireLlm && !config.llm.apiKey) {
      throw new Error('LLM API configuration is incomplete. Please run "openmeta init" first.');
    }
  }

  private async initializeClients(
    config: AppConfig,
    options: { validateLlm?: boolean } = {},
  ): Promise<void> {
    const validateLlm = options.validateLlm ?? true;
    githubService.initialize(config.github.pat, config.github.username);
    const ghValid = await ui.task({
      title: 'Validating GitHub access',
      doneMessage: 'GitHub access verified',
      failedMessage: 'GitHub access failed',
      tone: 'info',
    }, async () => {
      const valid = await githubService.validateCredentials();
      if (!valid) {
        throw new Error('GitHub validation failed');
      }
      return true;
    });
    if (!ghValid) {
      throw new Error('GitHub credentials validation failed. Run "openmeta init" to refresh your token.');
    }

    this.octokit = new Octokit({ auth: config.github.pat });
    if (!validateLlm) {
      return;
    }

    llmService.initialize(config.llm.apiKey, config.llm.apiBaseUrl, config.llm.modelName, config.llm.apiHeaders, config.llm.provider);
    const llmValid = await ui.task({
      title: 'Validating LLM provider',
      doneMessage: 'LLM provider verified',
      failedMessage: 'LLM provider failed',
      tone: 'info',
    }, async () => {
      const valid = await llmService.validateConnection();
      if (!valid) {
        const detail = llmService.getLastValidationError();
        throw new Error(`LLM validation failed${detail ? `: ${detail}` : ''}`);
      }
      return true;
    });
    if (!llmValid) {
      throw new Error('LLM API connection failed. Run "openmeta init" to update your provider settings.');
    }
  }

  private async loadRankedIssues(config: AppConfig, options: { refresh?: boolean; localOnly?: boolean } = {}): Promise<RankedIssue[]> {
    const issues = await githubService.fetchTrendingIssues({ refresh: options.refresh });
    const rankedCandidates = this.rankIssuesForProfile(issues, config.userProfile);
    if (options.localOnly) {
      return opportunityService.rankIssues(this.buildLocalIssueMatches(rankedCandidates, config.userProfile));
    }

    const matched = await this.scoreIssuesInBatches(config.userProfile, rankedCandidates);
    return opportunityService.rankIssues(matched);
  }

  private buildLocalIssueMatches(
    issues: GitHubIssue[],
    userProfile: AppConfig['userProfile'],
  ): MatchedIssue[] {
    return issues.slice(0, MAX_ISSUES_FOR_LLM_SCORING).map((issue) => {
      const matchScore = this.clampScore(this.scoreIssueForProfile(issue, userProfile));
      const techRequirements = this.inferLocalTechRequirements(issue, userProfile);

      return {
        ...issue,
        matchScore,
        analysis: {
          coreDemand: issue.title,
          techRequirements,
          solutionSuggestion: 'Local scout mode can shortlist this issue, then run "openmeta agent" when the LLM provider is healthy to draft a concrete patch plan.',
          estimatedWorkload: this.estimateLocalWorkload(issue),
        },
      };
    });
  }

  private async scoreIssuesInBatches(
    userProfile: AppConfig['userProfile'],
    issues: Awaited<ReturnType<typeof githubService.fetchTrendingIssues>>,
  ) {
    const matches = [];
    const issuesToScore = issues.slice(0, MAX_ISSUES_FOR_LLM_SCORING);

    for (let start = 0; start < issuesToScore.length; start += ISSUE_SCORING_BATCH_SIZE) {
      const batch = issuesToScore.slice(start, start + ISSUE_SCORING_BATCH_SIZE);
      const scoredBatch = await llmService.scoreIssues(userProfile, batch);
      if (scoredBatch.status !== 'success') {
        logger.warn('Issue scoring returned advisory results that require review. Continuing with the parsed matches only.');
      }
      matches.push(...scoredBatch.data);
    }

    return matches;
  }

  private rankIssuesForProfile(
    issues: GitHubIssue[],
    userProfile: AppConfig['userProfile'],
  ): GitHubIssue[] {
    return [...issues].sort((left, right) => {
      const scoreDelta = this.scoreIssueForProfile(right, userProfile) - this.scoreIssueForProfile(left, userProfile);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    });
  }

  private scoreIssueForProfile(issue: GitHubIssue, userProfile: AppConfig['userProfile']): number {
    const profileTerms = this.getProfileTerms(userProfile);
    const title = this.normalizeSearchText(issue.title);
    const body = this.normalizeSearchText(issue.body);
    const repoDescription = this.normalizeSearchText(issue.repoDescription);
    const repoName = this.normalizeSearchText(`${issue.repoFullName} ${issue.repoName}`);
    const labels = this.normalizeSearchText(issue.labels.join(' '));
    let score = 0;

    for (const term of profileTerms) {
      if (title.includes(term)) {
        score += 18;
      }
      if (labels.includes(term)) {
        score += 12;
      }
      if (repoDescription.includes(term)) {
        score += 8;
      }
      if (repoName.includes(term)) {
        score += 5;
      }
      if (body.includes(term)) {
        score += 4;
      }
    }

    if (labels.includes('good first issue')) {
      score += 14;
    }
    if (labels.includes('help wanted')) {
      score += 9;
    }
    if (this.hasActionableBodySignals(issue)) {
      score += 10;
    }
    if (issue.body.trim().length >= 120) {
      score += 6;
    }
    if (/\b(blocked|needs info|needs information|duplicate|invalid|question|wontfix)\b/.test(labels)) {
      score -= 28;
    }

    score += this.computeDiscoveryFreshnessBoost(issue.updatedAt);
    score += Math.min(12, Math.log10(issue.repoStars + 10) * 5);

    return score;
  }

  private getProfileTerms(userProfile: AppConfig['userProfile']): string[] {
    const terms = new Set<string>();

    for (const item of [...userProfile.techStack, ...userProfile.focusAreas]) {
      const normalized = this.normalizeSearchText(item);
      if (normalized) {
        terms.add(normalized);
      }

      for (const alias of PROFILE_TERM_ALIASES[normalized] ?? []) {
        const normalizedAlias = this.normalizeSearchText(alias);
        if (normalizedAlias) {
          terms.add(normalizedAlias);
        }
      }
    }

    for (const focusArea of userProfile.focusAreas) {
      for (const term of FOCUS_AREA_TERMS[focusArea] ?? []) {
        const normalized = this.normalizeSearchText(term);
        if (normalized) {
          terms.add(normalized);
        }
      }
    }

    return [...terms].filter((term) => term.length >= 2);
  }

  private normalizeSearchText(value: string): string {
    return value
      .toLowerCase()
      .replace(/\+\+/g, ' plus plus')
      .replace(/[#.]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private hasActionableBodySignals(issue: GitHubIssue): boolean {
    const content = `${issue.title}\n${issue.body}`;
    return /(?:^|[\s`'"])(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|md|css|scss)/m.test(content) ||
      /\b(repro|steps? to reproduce|expected|actual|acceptance criteria|stack trace)\b/i.test(content);
  }

  private computeDiscoveryFreshnessBoost(updatedAt: string): number {
    const ageHours = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60);

    if (ageHours <= 24) return 12;
    if (ageHours <= 72) return 10;
    if (ageHours <= 7 * 24) return 7;
    if (ageHours <= 14 * 24) return 4;
    return 0;
  }

  private inferLocalTechRequirements(issue: GitHubIssue, userProfile: AppConfig['userProfile']): string[] {
    const searchable = this.normalizeSearchText([
      issue.repoFullName,
      issue.repoDescription,
      issue.title,
      issue.body,
      issue.labels.join(' '),
    ].join(' '));
    const inferred = new Set<string>();

    for (const item of userProfile.techStack) {
      const normalized = this.normalizeSearchText(item);
      const aliases = [normalized, ...(PROFILE_TERM_ALIASES[normalized] ?? []).map(alias => this.normalizeSearchText(alias))];
      if (aliases.some(alias => alias && searchable.includes(alias))) {
        inferred.add(item);
      }
    }

    if (/\btsx?|typescript\b/.test(searchable)) inferred.add('TypeScript');
    if (/\bjsx?|javascript\b/.test(searchable)) inferred.add('JavaScript');
    if (/\breact|hooks?|component\b/.test(searchable)) inferred.add('React');
    if (/\bnode|npm|bun\b/.test(searchable)) inferred.add('Node.js');
    if (/\bcss|scss|accessibility|a11y|browser\b/.test(searchable)) inferred.add('Web');
    if (/\bpython|pytest|django|fastapi\b/.test(searchable)) inferred.add('Python');
    if (/\bgo|golang\b/.test(searchable)) inferred.add('Go');
    if (/\brust|cargo\b/.test(searchable)) inferred.add('Rust');

    return [...inferred].slice(0, 6);
  }

  private estimateLocalWorkload(issue: GitHubIssue): string {
    const bodyLength = issue.body.trim().length;
    const searchable = `${issue.title}\n${issue.body}`;

    if (/\b(rewrite|migration|architecture|breaking change|refactor all|entire)\b/i.test(searchable)) {
      return 'multi-session';
    }

    if (this.hasActionableBodySignals(issue) || bodyLength >= 500) {
      return '1-3 hours';
    }

    if (bodyLength >= 120) {
      return 'under 2 hours';
    }

    return 'needs triage';
  }

  private clampScore(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  private selectIssueForAutomation(issues: RankedIssue[], minOverallScore: number): RankedIssue | undefined {
    return issues.find((issue) => issue.opportunity.overallScore >= minOverallScore);
  }

  private diversifyScoutIssues(issues: RankedIssue[], limit: number): RankedIssue[] {
    if (limit <= 0 || issues.length <= limit) {
      return issues.slice(0, Math.max(0, limit));
    }

    const selected: RankedIssue[] = [];
    const selectedIds = new Set<string>();
    const seenRepos = new Set<string>();

    for (const issue of issues) {
      if (selected.length >= limit) {
        break;
      }

      if (seenRepos.has(issue.repoFullName)) {
        continue;
      }

      selected.push(issue);
      selectedIds.add(`${issue.repoFullName}#${issue.number}`);
      seenRepos.add(issue.repoFullName);
    }

    for (const issue of issues) {
      if (selected.length >= limit) {
        break;
      }

      const id = `${issue.repoFullName}#${issue.number}`;
      if (!selectedIds.has(id)) {
        selected.push(issue);
      }
    }

    return selected;
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

  private buildImplementationWorkspace(
    workspace: RepoWorkspaceContext,
    patchDraft: PatchDraft,
  ): RepoWorkspaceContext {
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
      candidateFiles: this.uniqueStrings([
        ...workspace.candidateFiles,
        ...patchPaths,
      ]),
      snippets: this.mergeSnippets(workspace.snippets, extraSnippets),
    };
  }

  private collectPatchDraftPaths(patchDraft: PatchDraft): string[] {
    return this.uniqueStrings([
      ...patchDraft.targetFiles.map((file) => file.path),
      ...patchDraft.proposedChanges.flatMap((change) => change.files),
    ].flatMap((path) => {
      const normalized = this.normalizePatchPath(path);
      return normalized ? [normalized] : [];
    }));
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
        subtitle: 'OpenMeta will keep the patch strategy and PR narrative as artifacts without modifying repository files or opening a real PR.',
        tone: 'info',
      });
      logger.info('Skipping generated file edits because draft-only mode is active.');
      return {
        changedFiles: [],
        validationResults: workspace.testResults,
        reviewRequired: false,
      };
    }

    if (workspace.workspaceDirty) {
      ui.callout({
        label: 'OpenMeta Agent',
        title: 'Workspace has existing local changes',
        subtitle: 'OpenMeta will not apply generated file edits into a dirty workspace. Commit, stash, or review the existing changes before asking for an automatic patch.',
        lines: [
          `Workspace: ${workspace.workspacePath}`,
        ],
        tone: 'warning',
      });
      logger.warn(`Skipping generated file edits because the workspace is dirty: ${workspace.workspacePath}`);
      return {
        changedFiles: [],
        validationResults: workspace.testResults,
        reviewRequired: true,
      };
    }

    try {
      const implementation = await ui.task({
        title: 'Generating concrete patch',
        doneMessage: 'Concrete patch generated',
        failedMessage: 'Concrete patch generation failed',
        tone: 'info',
      }, async () => llmService.generateImplementationDraft(issue, workspace, patchDraft));
      if (implementation.status !== 'success') {
        this.showStructuredReviewNotice({
          title: 'Concrete patch requires review',
          subtitle: 'OpenMeta marked the implementation draft as review-required, so no repository files will be modified automatically.',
          lines: [
            implementation.data.summary || 'The generated implementation needs manual review before any file edits are applied.',
          ],
        });
        logger.warn('Skipping automatic file edits because the implementation draft requires review.');
        return {
          changedFiles: [],
          validationResults: workspace.testResults,
          reviewRequired: true,
        };
      }

      if (implementation.data.fileChanges.length === 0) {
        ui.callout({
          label: 'OpenMeta Agent',
          title: 'Concrete patch not produced',
          subtitle: 'OpenMeta could not translate the draft strategy into safe file edits from the available repository context.',
          lines: ['Draft artifacts will still be generated so you can continue from the research output.'],
          tone: 'warning',
        });
        logger.warn('OpenMeta could not produce a safe concrete patch from the available repo context. Continuing with draft artifacts only.');
        return {
          changedFiles: [],
          validationResults: workspace.testResults,
          reviewRequired: false,
        };
      }

      ui.timeline('Generated patch plan', implementation.data.fileChanges.slice(0, 6).map((change) => ({
        title: change.path,
        subtitle: change.reason,
        state: 'done',
      })));

      const changedFiles = await ui.task({
        title: `Applying ${implementation.data.fileChanges.length} generated file edit(s)`,
        doneMessage: 'Generated file edits applied',
        failedMessage: 'Generated file edits failed to apply',
        tone: 'info',
      }, async () => workspaceService.applyGeneratedChanges(workspace.workspacePath, implementation.data.fileChanges, {
        allowedPaths: workspace.snippets.map((snippet) => snippet.path),
      }));
      if (changedFiles.reviewRequired) {
        this.showStructuredReviewNotice({
          title: 'Generated patch needs manual review',
          subtitle: 'OpenMeta refused to apply one or more generated edits because they reached outside the selected implementation context.',
          lines: [
            changedFiles.reviewReason || 'Review the generated patch before applying it manually.',
          ],
        });
        logger.warn(`Generated patch requires review: ${changedFiles.reviewReason || 'unspecified reason'}`);
        return {
          changedFiles: changedFiles.appliedFiles,
          validationResults: workspace.testResults,
          reviewRequired: true,
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
        logger.warn('The generated patch did not change any files in the workspace. Continuing with draft artifacts only.');
        return {
          changedFiles: [],
          validationResults: workspace.testResults,
          reviewRequired: false,
        };
      }

      logger.success(`Applied ${changedFiles.appliedFiles.length} workspace file updates`);

      const validationResults = runChecks && workspace.validationCommands.length > 0
        ? await ui.task({
          title: 'Running baseline validation commands',
          doneMessage: 'Baseline validation complete',
          failedMessage: 'Baseline validation finished with issues',
          tone: 'info',
        }, async () => workspaceService.runValidationCommands(workspace.workspacePath, workspace.validationCommands.slice(0, 3)))
        : workspace.testResults;

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
      };
    } catch (error) {
      logger.warn('OpenMeta could not generate or apply a safe concrete patch. Continuing with research artifacts only.', error);
      return {
        changedFiles: [],
        validationResults: workspace.testResults,
        reviewRequired: false,
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
    const artifactRelativeDir = join('contributions', getLocalDateStamp(), `${input.issue.repoFullName.replace(/\//g, '__')}__${input.issue.number}`);

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

    const publishResult = await gitService.writeAndPublish([
      { path: join(artifactRelativeDir, 'dossier.md'), content: input.dossier },
      { path: join(artifactRelativeDir, 'patch-draft.md'), content: input.patchDraftMarkdown },
      { path: join(artifactRelativeDir, 'pr-draft.md'), content: input.prDraftMarkdown },
      { path: join('memory', `${input.issue.repoFullName.replace(/\//g, '__')}.md`), content: input.memoryMarkdown },
      { path: 'INBOX.md', content: input.inboxMarkdown },
      { path: 'PROOF_OF_WORK.md', content: input.proofMarkdown },
    ], commitMessage, {
      branchName: ARTIFACT_PUBLISH_BRANCH,
      baseBranch: targetRepo.defaultBranch,
    });

    if (!publishResult) {
      throw new Error('OpenMeta could not publish the generated contribution artifacts.');
    }

    ui.card({
      label: 'OpenMeta Agent',
      title: input.pullRequestUrl ? 'Artifacts sealed into the ledger and linked to a live PR' : 'Artifacts sealed into the ledger',
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

    if (!input.allowRealPr) {
      logger.warn('Skipping real draft PR creation because one or more structured drafts require review.');
      return {
        changedFiles: input.changedFiles,
        validationResults: input.validationResults,
      };
    }

    const hasValidationFailures = input.validationResults.some((result) => !result.passed);
    const hasBlockingValidationFailures = this.hasBlockingValidationFailures(input.validationResults);
    if (input.headless && hasBlockingValidationFailures) {
      logger.warn('Skipping real draft PR creation because validation failed in headless mode.');
      return {
        changedFiles: input.changedFiles,
        validationResults: input.validationResults,
      };
    }

    if (!input.headless) {
      ui.callout({
        label: 'OpenMeta Agent',
        title: 'Create a real draft PR',
        subtitle: 'OpenMeta can push the generated patch to your fork and open a real draft PR against the upstream repository.',
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
      const upstreamRepo = await this.getUpstreamRepositoryContext(input.issue);
      const forkRepo = await this.ensureForkRepository(upstreamRepo);
      const branchName = this.buildPublishBranchName(input.issue);
      const draftPullRequest = this.buildDraftPullRequest(input.prDraft);
      const commitMessage = this.buildContributionCommitMessage(input.issue);

      await this.createCommitOnFork({
        forkRepo,
        branchName,
        workspacePath: input.workspace.workspacePath,
        changedFiles: input.changedFiles,
        commitMessage,
      });

      const contributionPullRequest = await this.createContributionPullRequest(upstreamRepo, forkRepo.owner, branchName, draftPullRequest);

      ui.card({
        label: 'OpenMeta Agent',
        title: 'Draft PR opened without drift',
        subtitle: 'The generated patch has been pushed to your fork and turned into a real upstream draft PR.',
        lines: [
          `Repository: ${input.issue.repoFullName}`,
          `Branch: ${branchName}`,
          `Changed Files: ${input.changedFiles.join(', ')}`,
          `Pull Request: ${contributionPullRequest.url}`,
        ],
        tone: 'success',
      });

      return {
        branchName,
        url: contributionPullRequest.url,
        number: contributionPullRequest.number,
        changedFiles: input.changedFiles,
        validationResults: input.validationResults,
      };
    } catch (error) {
      logger.warn('Real PR submission failed. Keeping the generated patch in the local workspace and continuing with artifact publication.', error);
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
      subtitle: 'This mode scouts, drafts patch and PR artifacts, can open a real upstream draft PR, updates inbox and proof-of-work, and can commit to your target repository without interactive review.',
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
        message: 'Do you understand that headless agent mode can publish generated artifacts and may open a real draft PR without another review step?',
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

    return results.map((result) => {
      if (result.passed) {
        return `${result.command}=passed`;
      }

      if (this.isInfrastructureValidationFailure(result)) {
        return `${result.command}=unavailable (${result.exitCode ?? 'n/a'})`;
      }

      return `${result.command}=failed (${result.exitCode ?? 'n/a'})`;
    }).join('; ');
  }

  private hasBlockingValidationFailures(results: TestResult[]): boolean {
    return results.some((result) => !result.passed && !this.isInfrastructureValidationFailure(result));
  }

  private isInfrastructureValidationFailure(result: TestResult): boolean {
    const output = result.output.toLowerCase();
    return result.exitCode === 127 ||
      output.includes('command not found') ||
      output.includes('not recognized as an internal or external command');
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
      subtitle: 'Blocking validation failures were found, so OpenMeta will attempt one constrained repair pass before continuing.',
      lines: [
        `Failures: ${this.formatValidationSummary(input.validationResults)}`,
      ],
      tone: 'warning',
    });

    const currentFiles = workspaceService.readWorkspaceFiles(input.workspace.workspacePath, input.changedFiles);
    const repairDraft = await ui.task({
      title: 'Generating validation repair patch',
      doneMessage: 'Validation repair patch generated',
      failedMessage: 'Validation repair patch failed',
      tone: 'info',
    }, async () => llmService.generateImplementationRepairDraft(
      input.issue,
      input.patchDraft,
      input.validationResults,
      currentFiles,
    ));

    if (repairDraft.status !== 'success') {
      this.showStructuredReviewNotice({
        title: 'Validation repair requires review',
        subtitle: 'OpenMeta marked the repair patch as review-required, so it will not be applied automatically.',
        lines: [
          repairDraft.data.summary || 'The generated repair needs manual review before any additional file edits are applied.',
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

    const repairedFiles = await ui.task({
      title: `Applying ${repairDraft.data.fileChanges.length} repair edit(s)`,
      doneMessage: 'Validation repair edits applied',
      failedMessage: 'Validation repair edits failed to apply',
      tone: 'info',
    }, async () => workspaceService.applyGeneratedChanges(input.workspace.workspacePath, repairDraft.data.fileChanges, {
      allowedPaths: input.changedFiles,
    }));

    if (repairedFiles.reviewRequired) {
      this.showStructuredReviewNotice({
        title: 'Validation repair needs manual review',
        subtitle: 'OpenMeta refused to apply one or more repair edits because they reached outside the changed file set.',
        lines: [
          repairedFiles.reviewReason || 'Review the generated repair before applying it manually.',
        ],
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

    const validationResults = await ui.task({
      title: 'Re-running validation after repair',
      doneMessage: 'Repair validation complete',
      failedMessage: 'Repair validation finished with issues',
      tone: 'info',
    }, async () => workspaceService.runValidationCommands(
      input.workspace.workspacePath,
      input.workspace.validationCommands.slice(0, 3),
    ));

    return {
      changedFiles: [...new Set([...input.changedFiles, ...repairedFiles.appliedFiles])],
      validationResults,
      reviewRequired: false,
    };
  }

  private countValidationStates(results: TestResult[]): { passed: number; failed: number; unavailable: number } {
    return results.reduce((summary, result) => {
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
    }, { passed: 0, failed: 0, unavailable: 0 });
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
      { label: 'Changed files', value: String(result.changedFiles?.length || 0), tone: result.changedFiles && result.changedFiles.length > 0 ? 'accent' : 'muted' },
      { label: 'Published', value: result.proofRecord.published ? 'YES' : 'NO', tone: result.proofRecord.published ? 'success' : 'muted' },
    ]);
    ui.keyValues('Run details', [
      { label: 'Issue', value: `${result.issue.repoFullName}#${result.issue.number}`, tone: 'info' },
      { label: 'Workspace', value: result.workspace.workspacePath, tone: 'info' },
      { label: 'Branch', value: result.workspace.branchName || 'workspace already dirty', tone: 'info' },
      { label: 'Changed files', value: result.changedFiles && result.changedFiles.length > 0 ? result.changedFiles.join(', ') : 'none', tone: 'info' },
      { label: 'Artifacts', value: result.artifacts.artifactDir, tone: 'info' },
      { label: 'Pull Request', value: result.pullRequestUrl || 'not created', tone: result.pullRequestUrl ? 'success' : 'muted' },
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
      const repoInfo = await this.getGitHubRepositoryInfo(parsedRepo.owner, parsedRepo.repo);

      return {
        path: config.github.targetRepoPath,
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        defaultBranch: repoInfo.default_branch || 'main',
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
        auto_init: false,
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

  private buildPublishBranchName(issue: RankedIssue): string {
    const slug = issue.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);

    return `openmeta/agent-${issue.number}-${slug || 'issue'}-${Date.now()}`;
  }

  private buildDraftPullRequest(prDraft: PullRequestDraft): DraftPullRequest {
    return {
      title: prDraft.title,
      body: contentService.formatPullRequestDraftBody(prDraft),
    };
  }

  private showStructuredReviewNotice(input: {
    title: string;
    subtitle: string;
    lines?: string[];
  }): void {
    ui.callout({
      label: 'OpenMeta Agent',
      title: input.title,
      subtitle: input.subtitle,
      lines: input.lines,
      tone: 'warning',
    });
  }

  private async getUpstreamRepositoryContext(issue: RankedIssue): Promise<TargetRepoContext> {
    const [owner, repo] = issue.repoFullName.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid issue repository reference: ${issue.repoFullName}`);
    }

    const repoInfo = await this.getGitHubRepositoryInfo(owner, repo);
    return {
      path: '',
      owner,
      repo,
      defaultBranch: repoInfo.default_branch || 'main',
    };
  }

  private async ensureForkRepository(upstreamRepo: TargetRepoContext): Promise<TargetRepoContext> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const forkOwner = githubService.getUsername();

    try {
      const { data } = await this.octokit.rest.repos.get({
        owner: forkOwner,
        repo: upstreamRepo.repo,
      });

      if (!data.fork || data.parent?.full_name !== `${upstreamRepo.owner}/${upstreamRepo.repo}`) {
        throw new Error(`Repository ${forkOwner}/${upstreamRepo.repo} exists but is not a fork of ${upstreamRepo.owner}/${upstreamRepo.repo}.`);
      }

      await this.syncForkWithUpstream(forkOwner, upstreamRepo.repo, data.default_branch || upstreamRepo.defaultBranch);
      return {
        path: '',
        owner: forkOwner,
        repo: upstreamRepo.repo,
        defaultBranch: data.default_branch || upstreamRepo.defaultBranch,
      };
    } catch (error) {
      const err = error as { status?: number };
      if (err.status && err.status !== 404) {
        throw error;
      }
    }

    logger.info(`Creating fork for ${upstreamRepo.owner}/${upstreamRepo.repo}`);
    await this.octokit.rest.repos.createFork({
      owner: upstreamRepo.owner,
      repo: upstreamRepo.repo,
    });

    const fork = await this.waitForFork(forkOwner, upstreamRepo.repo, `${upstreamRepo.owner}/${upstreamRepo.repo}`);
    await this.syncForkWithUpstream(forkOwner, upstreamRepo.repo, fork.default_branch || upstreamRepo.defaultBranch);

    return {
      path: '',
      owner: forkOwner,
      repo: upstreamRepo.repo,
      defaultBranch: fork.default_branch || upstreamRepo.defaultBranch,
    };
  }

  private async waitForFork(owner: string, repo: string, expectedParent: string) {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const { data } = await this.octokit.rest.repos.get({ owner, repo });
        if (data.fork && data.parent?.full_name === expectedParent) {
          return data;
        }
      } catch {
        // Continue polling until the fork is visible.
      }

      await this.delay(1500);
    }

    throw new Error(`Fork ${owner}/${repo} was not ready in time.`);
  }

  private async syncForkWithUpstream(owner: string, repo: string, branch: string): Promise<void> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    try {
      await this.octokit.rest.repos.mergeUpstream({
        owner,
        repo,
        branch,
      });
    } catch (error) {
      logger.debug(`Unable to sync fork ${owner}/${repo} with upstream before opening a PR`, error);
    }
  }

  private async createCommitOnFork(input: {
    forkRepo: TargetRepoContext;
    branchName: string;
    workspacePath: string;
    changedFiles: string[];
    commitMessage: string;
  }): Promise<void> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const branch = await this.octokit.rest.repos.getBranch({
      owner: input.forkRepo.owner,
      repo: input.forkRepo.repo,
      branch: input.forkRepo.defaultBranch,
    });

    const baseCommitSha = branch.data.commit.sha;
    const baseTreeSha = branch.data.commit.commit.tree.sha;

    const tree = input.changedFiles.map((filePath) => ({
      path: filePath,
      mode: '100644' as const,
      type: 'blob' as const,
      content: readFileSync(join(input.workspacePath, filePath), 'utf-8'),
    }));

    const createdTree = await this.octokit.rest.git.createTree({
      owner: input.forkRepo.owner,
      repo: input.forkRepo.repo,
      base_tree: baseTreeSha,
      tree,
    });

    const createdCommit = await this.octokit.rest.git.createCommit({
      owner: input.forkRepo.owner,
      repo: input.forkRepo.repo,
      message: input.commitMessage,
      tree: createdTree.data.sha,
      parents: [baseCommitSha],
    });

    try {
      await this.octokit.rest.git.createRef({
        owner: input.forkRepo.owner,
        repo: input.forkRepo.repo,
        ref: `refs/heads/${input.branchName}`,
        sha: createdCommit.data.sha,
      });
    } catch (error) {
      const err = error as { status?: number };
      if (err.status !== 422) {
        throw error;
      }

      await this.octokit.rest.git.updateRef({
        owner: input.forkRepo.owner,
        repo: input.forkRepo.repo,
        ref: `heads/${input.branchName}`,
        sha: createdCommit.data.sha,
        force: true,
      });
    }
  }

  private async createContributionPullRequest(
    upstreamRepo: TargetRepoContext,
    forkOwner: string,
    branchName: string,
    draftPullRequest: DraftPullRequest,
  ): Promise<{ url: string; number: number }> {
    if (!this.octokit) {
      throw new Error('GitHub service not initialized');
    }

    const existing = await this.octokit.rest.pulls.list({
      owner: upstreamRepo.owner,
      repo: upstreamRepo.repo,
      head: `${forkOwner}:${branchName}`,
      base: upstreamRepo.defaultBranch,
      state: 'open',
    });

    const [existingPullRequest] = existing.data;
    if (existingPullRequest) {
      return {
        url: existingPullRequest.html_url,
        number: existingPullRequest.number,
      };
    }

    const { data } = await this.octokit.rest.pulls.create({
      owner: upstreamRepo.owner,
      repo: upstreamRepo.repo,
      title: draftPullRequest.title,
      body: draftPullRequest.body,
      head: `${forkOwner}:${branchName}`,
      base: upstreamRepo.defaultBranch,
      draft: true,
    });

    return {
      url: data.html_url,
      number: data.number,
    };
  }

  private buildContributionCommitMessage(issue: RankedIssue): string {
    return `feat: address ${issue.repoFullName}#${issue.number} ${issue.title}`.slice(0, 120);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async prepareLocalRepository(git: SimpleGit, defaultBranch: string, hasRemoteCommits: boolean): Promise<void> {
    if (hasRemoteCommits) {
      try {
        await git.fetch('origin', defaultBranch);
        await git.checkout(['-B', defaultBranch, `origin/${defaultBranch}`]);
        return;
      } catch (error) {
        logger.warn(`Unable to sync local repository with origin/${defaultBranch}. Continuing with the local branch.`, error);
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
  }
}

export const agentOrchestrator = new AgentOrchestrator();

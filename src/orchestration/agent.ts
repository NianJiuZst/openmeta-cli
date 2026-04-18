import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Octokit } from '@octokit/rest';
import { simpleGit, type SimpleGit } from 'simple-git';
import type {
  AppConfig,
  ContributionAgentResult,
  RankedIssue,
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

export class AgentOrchestrator {
  private octokit: Octokit | null = null;

  async run(options: AgentRunOptions = {}): Promise<void> {
    const config = await configService.get();
    const headless = Boolean(options.headless);
    const schedulerRun = Boolean(options.schedulerRun);
    const runChecks = typeof options.runChecks === 'boolean' ? options.runChecks : !headless;

    ui.banner({
      label: 'OpenMeta Agent',
      title: headless ? 'Run autonomous contribution loop' : 'Start autonomous contribution loop',
      subtitle: headless
        ? 'OpenMeta will scout, prepare repo context, draft patch and PR artifacts, then publish the dossier.'
        : 'OpenMeta will scout opportunities, prepare repo context, and draft contribution artifacts.',
      lines: [
        runChecks ? 'Baseline validation commands will run when they can be detected.' : 'Baseline validation commands are skipped for this run.',
      ],
    });

    await this.validateConfig(config);

    if (headless && !schedulerRun) {
      await this.confirmManualHeadlessRun(config);
    }

    await this.initializeClients(config);

    ui.section('Scout opportunities', 'Loading candidate issues and scoring contribution opportunities.');
    const rankedIssues = await this.loadRankedIssues(config);
    if (rankedIssues.length === 0) {
      ui.emptyState(
        'OpenMeta Agent',
        'No viable issues found',
        'No issues met the current technical match threshold. Broaden your profile or try again later.',
      );
      return;
    }

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

    ui.section('Prepare workspace', `Cloning and inspecting ${selectedIssue.repoFullName}.`);
    const memoryBeforeRun = memoryService.load(selectedIssue.repoFullName);
    const workspace = await workspaceService.prepareWorkspace(selectedIssue, memoryBeforeRun, runChecks);
    const memory = memoryService.update(selectedIssue, workspace);

    ui.section('Generate artifacts', 'Drafting patch strategy, applying a concrete patch, and preparing PR materials.');
    const patchDraft = await llmService.generatePatchDraft(selectedIssue, workspace, memory);
    const implementation = await this.generateConcretePatch(selectedIssue, workspace, patchDraft, runChecks);
    const workspaceForArtifacts: RepoWorkspaceContext = {
      ...workspace,
      testResults: implementation.validationResults,
    };
    const prDraft = await llmService.generatePrDraft(selectedIssue, patchDraft, workspaceForArtifacts);

    const contributionPullRequest = await this.submitContributionPullRequestIfPossible({
      config,
      headless,
      issue: selectedIssue,
      prDraft,
      workspace: workspaceForArtifacts,
      changedFiles: implementation.changedFiles,
      validationResults: implementation.validationResults,
    });

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

    this.writeLocalArtifacts({
      artifacts,
      dossier,
      patchDraft,
      prDraft,
      memoryMarkdown: memoryService.renderMarkdown(memory),
      inboxMarkdown: inboxService.renderMarkdown(inboxItems),
      proofMarkdown,
    });

    const publishResult = await this.publishArtifactsIfNeeded({
      config,
      headless,
      issue: selectedIssue,
      patchDraft,
      prDraft,
      dossier,
      memoryMarkdown: memoryService.renderMarkdown(memory),
      inboxMarkdown: inboxService.renderMarkdown(inboxItems),
      proofMarkdown,
      changedFiles: implementation.changedFiles,
      validationResults: implementation.validationResults,
      pullRequestUrl: contributionPullRequest.url,
    });

    const finalProofRecord = {
      ...proofRecord,
      published: publishResult.published,
    };
    proofOfWorkService.record(finalProofRecord);

    this.showResult({
      issue: selectedIssue,
      workspace: workspaceForArtifacts,
      memory,
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

  async scout(limit: number = 10): Promise<void> {
    const config = await configService.get();
    await this.validateConfig(config);
    await this.initializeClients(config);

    ui.banner({
      label: 'OpenMeta Scout',
      title: 'Top contribution opportunities',
      subtitle: 'Issues are ranked by technical match and opportunity score.',
    });

    const rankedIssues = await this.loadRankedIssues(config);
    if (rankedIssues.length === 0) {
      ui.emptyState('OpenMeta Scout', 'No issues found', 'No issues met the current scoring thresholds.');
      return;
    }

    ui.section('Ranked issues', `Showing the top ${Math.min(limit, rankedIssues.length)} opportunities.`);

    for (const [index, issue] of rankedIssues.slice(0, limit).entries()) {
      this.printIssuePreview(issue, index + 1);
    }
  }

  async showInbox(): Promise<void> {
    const items = inboxService.load().items;
    ui.banner({
      label: 'OpenMeta Inbox',
      title: items.length > 0 ? 'Contribution inbox ready' : 'Contribution inbox is empty',
      subtitle: 'OpenMeta keeps the highest-value drafted opportunities here.',
      lines: items.slice(0, 8).map((item) => `${item.repoFullName}#${item.issueNumber} | overall ${item.overallScore} | ${item.status}`),
      tone: items.length > 0 ? 'info' : 'warning',
    });
  }

  async showProofOfWork(): Promise<void> {
    const records = proofOfWorkService.load().records;
    ui.banner({
      label: 'OpenMeta PoW',
      title: records.length > 0 ? 'Proof of work available' : 'No proof of work yet',
      subtitle: 'Every agent run is recorded as a contribution asset.',
      lines: records.slice(0, 8).map((record) => `${record.repoFullName}#${record.issueNumber} | overall ${record.overallScore} | published=${record.published}`),
      tone: records.length > 0 ? 'info' : 'warning',
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
    const ghValid = await githubService.validateCredentials();
    if (!ghValid) {
      throw new Error('GitHub credentials validation failed. Run "openmeta init" to refresh your token.');
    }

    this.octokit = new Octokit({ auth: config.github.pat });
    llmService.initialize(config.llm.apiKey, config.llm.apiBaseUrl, config.llm.modelName);
    const llmValid = await llmService.validateConnection();
    if (!llmValid) {
      throw new Error('LLM API connection failed. Run "openmeta init" to update your provider settings.');
    }
  }

  private async loadRankedIssues(config: AppConfig): Promise<RankedIssue[]> {
    const issues = await githubService.fetchTrendingIssues();
    const matched = await this.scoreIssuesInBatches(config.userProfile, issues);
    return opportunityService.rankIssues(matched);
  }

  private async scoreIssuesInBatches(
    userProfile: AppConfig['userProfile'],
    issues: Awaited<ReturnType<typeof githubService.fetchTrendingIssues>>,
  ) {
    const batchSize = 20;
    const matches = [];

    for (let start = 0; start < Math.min(issues.length, 80); start += batchSize) {
      const batch = issues.slice(start, start + batchSize);
      const scoredBatch = await llmService.scoreIssues(userProfile, batch);
      matches.push(...scoredBatch);
      if (matches.length >= 20) {
        break;
      }
    }

    return matches;
  }

  private selectIssueForAutomation(issues: RankedIssue[], minOverallScore: number): RankedIssue | undefined {
    return issues.find((issue) => issue.opportunity.overallScore >= minOverallScore);
  }

  private async promptForIssue(issues: RankedIssue[]): Promise<RankedIssue> {
    ui.section('Review opportunities', `Showing the top ${Math.min(5, issues.length)} ranked issues with detailed context.`);
    const topIssues = issues.slice(0, 5);

    for (const [index, issue] of topIssues.entries()) {
      this.printIssuePreview(issue, index + 1);
    }

    try {
      return await selectPrompt<RankedIssue>({
        message: 'Select an opportunity to draft:',
        pageSize: Math.min(10, topIssues.length),
        choices: topIssues.map((issue) => ({
          name: `${issue.repoFullName}#${issue.number} | overall ${issue.opportunity.overallScore}`,
          description: issue.title.slice(0, 72),
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

  private printIssuePreview(issue: RankedIssue, index: number): void {
    const bodyExcerpt = issue.body.replace(/\s+/g, ' ').trim().slice(0, 180);

    console.log(`\n  ${chalk.bold(`${index}.`)} ${chalk.white(issue.repoFullName)}${chalk.gray('#')}${chalk.white(issue.number)}`);
    console.log(`     ${chalk.gray('Title:')} ${chalk.white(issue.title)}`);
    console.log(`     ${chalk.gray('Link:')} ${chalk.cyan(issue.htmlUrl)}`);
    console.log(`     ${chalk.gray('Repo:')} ${chalk.gray(issue.repoDescription || 'n/a')}`);
    console.log(`     ${chalk.gray('Stars:')} ${chalk.white(issue.repoStars.toString())}  ${chalk.gray('Updated:')} ${chalk.white(issue.updatedAt.slice(0, 10))}  ${chalk.gray('Created:')} ${chalk.white(issue.createdAt.slice(0, 10))}`);
    console.log(`     ${chalk.gray('Labels:')} ${chalk.cyan(issue.labels.join(', ') || 'none')}`);
    console.log(`     ${chalk.gray('Demand:')} ${chalk.white(issue.analysis.coreDemand || 'n/a')}`);
    console.log(`     ${chalk.gray('Tech:')} ${chalk.cyan(issue.analysis.techRequirements.join(', ') || 'n/a')}`);
    console.log(`     ${chalk.gray('Workload:')} ${chalk.white(issue.analysis.estimatedWorkload || 'n/a')}`);
    if (bodyExcerpt) {
      console.log(`     ${chalk.gray('Issue:')} ${chalk.gray(bodyExcerpt)}`);
    }
    console.log(`     ${chalk.gray('Overall:')} ${chalk.green(issue.opportunity.overallScore.toString())}  ${chalk.gray('Match:')} ${issue.matchScore}  ${chalk.gray('Opportunity:')} ${issue.opportunity.score}`);
    console.log(`     ${chalk.gray('Breakdown:')} ${chalk.gray(`freshness ${issue.opportunity.breakdown.freshness}, clarity ${issue.opportunity.breakdown.onboardingClarity}, merge ${issue.opportunity.breakdown.mergePotential}, impact ${issue.opportunity.breakdown.impact}`)}`);
    console.log(`     ${chalk.gray('Summary:')} ${chalk.gray(issue.opportunity.summary)}`);
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
    patchDraft: string;
    prDraft: string;
    memoryMarkdown: string;
    inboxMarkdown: string;
    proofMarkdown: string;
  }): void {
    writeFileSync(input.artifacts.dossierPath, input.dossier, 'utf-8');
    writeFileSync(input.artifacts.patchDraftPath, input.patchDraft, 'utf-8');
    writeFileSync(input.artifacts.prDraftPath, input.prDraft, 'utf-8');
    writeFileSync(input.artifacts.memoryPath, input.memoryMarkdown, 'utf-8');
    writeFileSync(input.artifacts.inboxPath, input.inboxMarkdown, 'utf-8');
    writeFileSync(input.artifacts.proofOfWorkPath, input.proofMarkdown, 'utf-8');
  }

  private async generateConcretePatch(
    issue: RankedIssue,
    workspace: RepoWorkspaceContext,
    patchDraft: string,
    runChecks: boolean,
  ): Promise<{ changedFiles: string[]; validationResults: TestResult[] }> {
    try {
      const implementation = await llmService.generateImplementationDraft(issue, workspace, patchDraft);
      if (implementation.fileChanges.length === 0) {
        logger.warn('OpenMeta could not produce a safe concrete patch from the available repo context. Continuing with draft artifacts only.');
        return {
          changedFiles: [],
          validationResults: workspace.testResults,
        };
      }

      ui.section('Apply patch', `Applying ${implementation.fileChanges.length} generated file edits inside the workspace.`);
      const changedFiles = workspaceService.applyGeneratedChanges(workspace.workspacePath, implementation.fileChanges);
      if (changedFiles.length === 0) {
        logger.warn('The generated patch did not change any files in the workspace. Continuing with draft artifacts only.');
        return {
          changedFiles: [],
          validationResults: workspace.testResults,
        };
      }

      logger.success(`Applied ${changedFiles.length} workspace file updates`);

      const validationResults = runChecks && workspace.testCommands.length > 0
        ? workspaceService.runValidationCommands(workspace.workspacePath, workspace.testCommands.slice(0, 3))
        : workspace.testResults;

      return {
        changedFiles,
        validationResults,
      };
    } catch (error) {
      logger.warn('OpenMeta could not generate or apply a safe concrete patch. Continuing with research artifacts only.', error);
      return {
        changedFiles: [],
        validationResults: workspace.testResults,
      };
    }
  }

  private async publishArtifactsIfNeeded(input: {
    config: AppConfig;
    headless: boolean;
    issue: RankedIssue;
    patchDraft: string;
    prDraft: string;
    dossier: string;
    memoryMarkdown: string;
    inboxMarkdown: string;
    proofMarkdown: string;
    changedFiles: string[];
    validationResults: TestResult[];
    pullRequestUrl?: string;
  }): Promise<{ published: boolean }> {
    const artifactRelativeDir = join('contributions', getLocalDateStamp(), `${input.issue.repoFullName.replace(/\//g, '__')}__${input.issue.number}`);
    const draftPullRequest = this.parseDraftPullRequest(input.prDraft, input.issue);

    if (!input.headless) {
      ui.section('Artifact preview', 'OpenMeta generated a dossier, patch draft, PR draft, inbox update, and proof-of-work update.');
      console.log(`\n  ${chalk.gray('Target directory:')} ${artifactRelativeDir}`);
      console.log(`  ${chalk.gray('Overall score:')} ${input.issue.opportunity.overallScore}`);
      console.log(`  ${chalk.gray('PR draft title line:')} ${draftPullRequest.title}`);
      console.log(`  ${chalk.gray('Changed files:')} ${input.changedFiles.length > 0 ? input.changedFiles.join(', ') : 'none'}`);
      console.log(`  ${chalk.gray('Validation:')} ${this.formatValidationSummary(input.validationResults)}`);
      console.log(`  ${chalk.gray('Contribution PR:')} ${input.pullRequestUrl || 'not created'}`);
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
      { path: join(artifactRelativeDir, 'patch-draft.md'), content: input.patchDraft },
      { path: join(artifactRelativeDir, 'pr-draft.md'), content: input.prDraft },
      { path: join('memory', `${input.issue.repoFullName.replace(/\//g, '__')}.md`), content: input.memoryMarkdown },
      { path: 'INBOX.md', content: input.inboxMarkdown },
      { path: 'PROOF_OF_WORK.md', content: input.proofMarkdown },
    ], commitMessage);

    if (!publishResult) {
      throw new Error('OpenMeta could not publish the generated contribution artifacts.');
    }

    ui.banner({
      label: 'OpenMeta Agent',
      title: input.pullRequestUrl ? 'Contribution artifacts published and PR linked' : 'Contribution artifacts published',
      subtitle: input.pullRequestUrl
        ? 'The agent dossier, patch draft, PR draft, inbox, and proof-of-work have been committed, and the real draft PR link is recorded.'
        : 'The agent dossier, patch draft, PR draft, inbox, and proof-of-work have been committed.',
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
    headless: boolean;
    issue: RankedIssue;
    prDraft: string;
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
    if (input.headless && hasValidationFailures) {
      logger.warn('Skipping real draft PR creation because validation failed in headless mode.');
      return {
        changedFiles: input.changedFiles,
        validationResults: input.validationResults,
      };
    }

    if (!input.headless) {
      ui.section('Contribution PR', 'OpenMeta can push the generated patch to your fork and open a real draft PR against the upstream repository.');
      console.log(`\n  ${chalk.gray('Changed files:')} ${input.changedFiles.join(', ')}`);
      console.log(`  ${chalk.gray('Validation:')} ${this.formatValidationSummary(input.validationResults)}`);

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
      const draftPullRequest = this.parseDraftPullRequest(input.prDraft, input.issue);
      const commitMessage = this.buildContributionCommitMessage(input.issue);

      await this.createCommitOnFork({
        forkRepo,
        branchName,
        workspacePath: input.workspace.workspacePath,
        changedFiles: input.changedFiles,
        commitMessage,
      });

      const contributionPullRequest = await this.createContributionPullRequest(upstreamRepo, forkRepo.owner, branchName, draftPullRequest);

      ui.banner({
        label: 'OpenMeta Agent',
        title: 'Draft PR created',
        subtitle: 'The generated patch has been pushed to your fork and opened as a real draft PR against the upstream repository.',
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
    ui.banner({
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

    return results.map((result) => `${result.command}=${result.passed ? 'passed' : `failed (${result.exitCode ?? 'n/a'})`}`).join('; ');
  }

  private showResult(result: ContributionAgentResult): void {
    ui.banner({
      label: 'OpenMeta Agent',
      title: 'Agent run complete',
      subtitle: 'OpenMeta generated contribution artifacts and updated its long-term memory.',
      lines: [
        `Issue: ${result.issue.repoFullName}#${result.issue.number}`,
        `Overall Score: ${result.issue.opportunity.overallScore}`,
        `Workspace: ${result.workspace.workspacePath}`,
        `Changed Files: ${result.changedFiles && result.changedFiles.length > 0 ? result.changedFiles.join(', ') : 'none'}`,
        `Artifacts: ${result.artifacts.artifactDir}`,
        `Published: ${result.proofRecord.published}`,
        ...(result.pullRequestUrl ? [`Pull Request: ${result.pullRequestUrl}`] : []),
      ],
      tone: 'success',
    });
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

  private parseDraftPullRequest(prDraft: string, issue: RankedIssue): DraftPullRequest {
    const lines = prDraft.split('\n');
    const titleLine = lines.find((line) => /^title\s*:/i.test(line.trim()));
    const headingTitle = lines.find((line) => line.trim().startsWith('#'));
    const title = titleLine
      ? titleLine.replace(/^title\s*:/i, '').trim()
      : headingTitle
        ? headingTitle.replace(/^#+\s*/, '').trim()
        : `Draft contribution for ${issue.repoFullName}#${issue.number}`;

    const body = prDraft.trim().length > 0
      ? prDraft.trim()
      : [
        'Summary',
        '',
        `Draft contribution artifacts for ${issue.repoFullName}#${issue.number}.`,
      ].join('\n');

    return { title, body };
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

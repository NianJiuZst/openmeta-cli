import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { Octokit } from '@octokit/rest';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { AppConfig, ContributionAgentResult, RankedIssue } from '../types/index.js';
import {
  configService,
  ensureDirectory,
  getLocalDateStamp,
  getOpenMetaArtifactRoot,
  logger,
  prompt,
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

    ui.section('Generate artifacts', 'Drafting patch strategy, PR draft, inbox entry, and proof-of-work.');
    const patchDraft = await llmService.generatePatchDraft(selectedIssue, workspace, memory);
    const prDraft = await llmService.generatePrDraft(selectedIssue, patchDraft, workspace);
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
    };

    const dossier = contentService.formatContributionDossier(selectedIssue, workspace, memory, patchDraft, prDraft);
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

    const published = await this.publishArtifactsIfNeeded({
      config,
      headless,
      issue: selectedIssue,
      patchDraft,
      prDraft,
      dossier,
      memoryMarkdown: memoryService.renderMarkdown(memory),
      inboxMarkdown: inboxService.renderMarkdown(inboxItems),
      proofMarkdown,
    });

    const finalProofRecord = {
      ...proofRecord,
      published,
    };
    proofOfWorkService.record(finalProofRecord);

    this.showResult({
      issue: selectedIssue,
      workspace,
      memory,
      patchDraft,
      prDraft,
      dossier,
      artifacts,
      inboxItem,
      proofRecord: finalProofRecord,
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
      console.log(`\n  ${chalk.bold(`${index + 1}.`)} ${chalk.white(issue.repoFullName)}${chalk.gray('#')}${chalk.white(issue.number)}`);
      console.log(`     ${chalk.gray('Title:')} ${chalk.white(issue.title)}`);
      console.log(`     ${chalk.gray('Overall:')} ${chalk.green(issue.opportunity.overallScore.toString())}  ${chalk.gray('Match:')} ${issue.matchScore}  ${chalk.gray('Opportunity:')} ${issue.opportunity.score}`);
      console.log(`     ${chalk.gray('Summary:')} ${chalk.gray(issue.opportunity.summary)}`);
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
    ui.section('Review opportunities', `Showing the top ${Math.min(10, issues.length)} ranked issues.`);
    const topIssues = issues.slice(0, 10);

    for (const [index, issue] of topIssues.entries()) {
      console.log(`\n  ${chalk.bold(`${index + 1}.`)} ${chalk.white(issue.repoFullName)}${chalk.gray('#')}${chalk.white(issue.number)}`);
      console.log(`     ${chalk.gray('Title:')} ${chalk.white(issue.title)}`);
      console.log(`     ${chalk.gray('Overall:')} ${chalk.green(issue.opportunity.overallScore.toString())}  ${chalk.gray('Match:')} ${issue.matchScore}  ${chalk.gray('Opportunity:')} ${issue.opportunity.score}`);
      console.log(`     ${chalk.gray('Summary:')} ${chalk.gray(issue.opportunity.summary)}`);
    }

    const { issueId } = await prompt<{ issueId: string }>([
      {
        type: 'list',
        name: 'issueId',
        message: 'Select an opportunity to draft:',
        choices: topIssues.map((issue) => ({
          name: `${issue.repoFullName}#${issue.number} | overall ${issue.opportunity.overallScore} | ${issue.title.slice(0, 50)}`,
          value: issue.id.toString(),
        })),
      },
    ]);

    const selectedIssue = issues.find((issue) => issue.id.toString() === issueId);
    if (!selectedIssue) {
      throw new Error('Selected issue not found.');
    }

    return selectedIssue;
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
  }): Promise<boolean> {
    const artifactRelativeDir = join('contributions', getLocalDateStamp(), `${input.issue.repoFullName.replace(/\//g, '__')}__${input.issue.number}`);

    if (!input.headless) {
      ui.section('Artifact preview', 'OpenMeta generated a dossier, patch draft, PR draft, inbox update, and proof-of-work update.');
      console.log(`\n  ${chalk.gray('Target directory:')} ${artifactRelativeDir}`);
      console.log(`  ${chalk.gray('Overall score:')} ${input.issue.opportunity.overallScore}`);
      console.log(`  ${chalk.gray('PR draft title line:')} ${this.extractTitleLine(input.prDraft)}`);
    }

    const shouldCommit = input.headless ? true : await this.promptForCommitConfirmation();
    if (!shouldCommit) {
      return false;
    }

    const targetRepoPath = await this.ensureTargetRepo(input.config);
    const gitInitialized = await gitService.initialize(targetRepoPath);
    if (!gitInitialized) {
      throw new Error(`Failed to initialize the target repository at ${targetRepoPath}.`);
    }

    const commitMessage = `feat(agent): draft contribution for ${input.issue.repoFullName}#${input.issue.number}`;
    const finalConfirm = input.headless ? true : await this.promptForFinalCommitConfirmation(commitMessage);
    if (!finalConfirm) {
      return false;
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
      title: 'Contribution artifacts published',
      subtitle: 'The agent dossier, patch draft, PR draft, inbox, and proof-of-work have been committed.',
      lines: [
        `Issue: ${input.issue.repoFullName}#${input.issue.number}`,
        `Branch: ${publishResult.branch}`,
        `Files: ${publishResult.fileNames.join(', ')}`,
      ],
      tone: 'success',
    });

    return true;
  }

  private async confirmManualHeadlessRun(config: AppConfig): Promise<void> {
    ui.banner({
      label: 'OpenMeta Agent',
      title: 'Headless agent mode runs without prompts',
      subtitle: 'This mode scouts, drafts patch and PR artifacts, updates inbox and proof-of-work, and can commit to your target repository without interactive review.',
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
        message: 'Do you understand that headless agent mode can publish generated artifacts without another review step?',
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

  private extractTitleLine(prDraft: string): string {
    const line = prDraft.split('\n').find((candidate) => candidate.trim().startsWith('Title'));
    return line ? line.replace(/^Title:\s*/i, '').trim() : 'n/a';
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
        `Artifacts: ${result.artifacts.artifactDir}`,
        `Published: ${result.proofRecord.published}`,
      ],
      tone: 'success',
    });
  }

  private async ensureTargetRepo(config: AppConfig): Promise<string> {
    if (config.github.targetRepoPath) {
      if (!existsSync(config.github.targetRepoPath)) {
        throw new Error(`Configured target repository path does not exist: ${config.github.targetRepoPath}`);
      }

      return config.github.targetRepoPath;
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

    return repoPath;
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

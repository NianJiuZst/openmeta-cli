import inquirer from 'inquirer';
import chalk from 'chalk';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AppConfig, MatchedIssue, GeneratedContent } from '../types/index.js';
import { githubService, llmService, contentService, gitService } from '../services/index.js';
import { logger, configService } from '../infra/index.js';
import type { ContentType } from '../types/content.types.js';
import { Octokit } from '@octokit/rest';
import { simpleGit, type SimpleGit } from 'simple-git';

export class DailyOrchestrator {
  private octokit: Octokit | null = null;

  async execute(): Promise<void> {
    logger.info('Starting daily open source workflow...');

    const config = await configService.get();

    await this.validateConfig(config);

    githubService.initialize(config.github.pat, config.github.username);
    const ghValid = await githubService.validateCredentials();
    if (!ghValid) {
      throw new Error('GitHub credentials validation failed');
    }

    this.octokit = new Octokit({ auth: config.github.pat });

    llmService.initialize(config.llm.apiKey, config.llm.apiBaseUrl, config.llm.modelName);
    const llmValid = await llmService.validateConnection();
    if (!llmValid) {
      throw new Error('LLM API connection failed');
    }

    const targetRepoPath = await this.ensureTargetRepo(config);

    logger.info('Fetching and filtering issues...');
    const issues = await githubService.fetchTrendingIssues();
    if (issues.length === 0) {
      logger.warn('No issues found matching criteria');
      return;
    }

    const issuesWithScores = await this.scoreIssuesInBatches(config.userProfile, issues);

    if (issuesWithScores.length === 0) {
      logger.warn('No issues matched user profile (score >= 60)');
      return;
    }

    // Always show at least top results
    const displayIssues = issuesWithScores.slice(0, 10);

    console.log(chalk.bold(`\n  Found ${issuesWithScores.length} matching issues\n`));
    console.log(chalk.gray('─'.repeat(60)));

    // Show issues with beautiful formatting
    for (const [index, issue] of displayIssues.entries()) {
      const scoreColor = issue.matchScore >= 80 ? chalk.green : issue.matchScore >= 70 ? chalk.cyan : chalk.yellow;

      console.log(`\n  ${chalk.bold(`${index + 1}.`)} ${chalk.white(issue.repoFullName)}${chalk.gray('#')}${chalk.white(issue.number)}`);
      console.log(`     ${chalk.gray('Title:')} ${chalk.white(issue.title)}`);

      if (issue.repoDescription) {
        console.log(`     ${chalk.gray('About:')} ${chalk.gray(issue.repoDescription.slice(0, 60))}...`);
      }

      console.log(`     ${chalk.gray('Stars:')} ${issue.repoStars}  ${chalk.gray('Score:')} ${scoreColor(issue.matchScore)}`);

      if (issue.analysis.coreDemand) {
        console.log(`     ${chalk.gray('Demand:')} ${issue.analysis.coreDemand.slice(0, 80)}...`);
      }
      if (issue.analysis.techRequirements.length > 0) {
        console.log(`     ${chalk.gray('Tech:')} ${chalk.cyan(issue.analysis.techRequirements.join(', '))}`);
      }
    }

    console.log(chalk.gray('\n' + '─'.repeat(60)));

    // Let user select which issue to work on
    const issueChoices = displayIssues.map((issue, idx) => ({
      name: `${idx + 1}. ${issue.repoFullName}#${issue.number} - ${issue.title.slice(0, 40)}...`,
      value: issue.id.toString(),
    }));

    const { selectedIssueId } = await inquirer.prompt<{ selectedIssueId: string }>([
      {
        type: 'list',
        name: 'selectedIssueId',
        message: 'Select an issue to work on:',
        choices: issueChoices,
      },
    ]);

    const selectedIssue = issuesWithScores.find(
      issue => issue.id.toString() === selectedIssueId
    );

    if (!selectedIssue) {
      throw new Error('Selected issue not found');
    }

    const { contentType } = await inquirer.prompt<{ contentType: ContentType }>([
      {
        type: 'list',
        name: 'contentType',
        message: 'Select content type to generate:',
        choices: [
          { name: 'Research Notes', value: 'research_note' },
          { name: 'Development Diary', value: 'development_diary' },
        ],
      },
    ]);

    let generatedContent: GeneratedContent;
    if (contentType === 'research_note') {
      const reportContent = await llmService.generateDailyReport(
        `${selectedIssue.repoFullName}#${selectedIssue.number}: ${selectedIssue.title}\n${selectedIssue.analysis.coreDemand}`
      );
      generatedContent = contentService.generateResearchNote([selectedIssue], reportContent);
    } else {
      const { codeSnippets } = await inquirer.prompt<{ codeSnippets: string }>([
        {
          type: 'editor',
          name: 'codeSnippets',
          message: 'Enter code snippets to include (optional, leave empty to skip):',
          default: '',
        },
      ]);

      const diaryContent = await llmService.generateDailyDiary(
        `${selectedIssue.repoFullName}#${selectedIssue.number}: ${selectedIssue.title}\n${selectedIssue.analysis.coreDemand}`,
        codeSnippets
      );
      generatedContent = contentService.generateDiary([selectedIssue], diaryContent);
    }

    const markdown = contentService.formatAsMarkdown(generatedContent);
    console.log('\n' + markdown);

    const { editContent } = await inquirer.prompt<{ editContent: boolean }>([
      {
        type: 'confirm',
        name: 'editContent',
        message: 'Do you want to edit the content before committing?',
        default: false,
      },
    ]);

    let finalContent = markdown;
    if (editContent) {
      const { editedContent } = await inquirer.prompt<{ editedContent: string }>([
        {
          type: 'editor',
          name: 'editedContent',
          message: 'Edit the content:',
          default: markdown,
        },
      ]);
      finalContent = editedContent;
    }

    const { confirmCommit } = await inquirer.prompt<{ confirmCommit: boolean }>([
      {
        type: 'confirm',
        name: 'confirmCommit',
        message: 'Do you want to commit and push to your target repository?',
        default: false,
      },
    ]);

    if (confirmCommit) {
      const gitInitialized = await gitService.initialize(targetRepoPath);
      if (!gitInitialized) {
        throw new Error('Failed to initialize git repository');
      }

      const commitMessage = contentService.formatCommitMessage(generatedContent, config.commitTemplate);

      const { finalConfirm } = await inquirer.prompt<{ finalConfirm: boolean }>([
        {
          type: 'confirm',
          name: 'finalConfirm',
          message: `Confirm commit message:\n"${commitMessage}"\n\nProceed with commit?`,
          default: false,
        },
      ]);

      if (finalConfirm) {
        const success = await gitService.addCommitPush(finalContent, commitMessage);
        if (success) {
          logger.success('Daily contribution completed!');
        } else {
          logger.error('Failed to complete commit');
        }
      } else {
        logger.info('Commit cancelled by user');
      }
    } else {
      logger.info('Commit skipped by user');
    }
  }

  private async validateConfig(config: AppConfig): Promise<void> {
    if (!config.github.pat || !config.github.username) {
      throw new Error('GitHub configuration is incomplete. Please run "openmeta init" first.');
    }
    if (!config.llm.apiKey) {
      throw new Error('LLM API configuration is incomplete. Please run "openmeta init" first.');
    }
  }

  private async scoreIssuesInBatches(
    userProfile: AppConfig['userProfile'],
    issues: Awaited<ReturnType<typeof githubService.fetchTrendingIssues>>,
  ): Promise<MatchedIssue[]> {
    const batchSize = 20;
    const maxCandidates = Math.min(issues.length, 80);
    const targetMatches = 10;
    const matches = new Map<number, MatchedIssue>();

    for (let start = 0; start < maxCandidates; start += batchSize) {
      const batch = issues.slice(start, start + batchSize);
      const scoredBatch = await llmService.scoreIssues(userProfile, batch);

      for (const issue of scoredBatch) {
        matches.set(issue.id, issue);
      }

      if (matches.size >= targetMatches) {
        break;
      }
    }

    return [...matches.values()].sort((left, right) => right.matchScore - left.matchScore);
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
        description: 'Daily open source contribution tracking',
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
    const origin = remotes.find(remote => remote.name === 'origin');

    if (!origin) {
      await git.addRemote('origin', remoteUrl);
      return;
    }

    const existingUrl = origin.refs.fetch || origin.refs.push;
    if (existingUrl && existingUrl !== remoteUrl) {
      logger.warn(`Origin remote already points to ${existingUrl}. Leaving the existing remote untouched.`);
    }
  }

  private async prepareLocalRepository(
    git: SimpleGit,
    defaultBranch: string,
    hasRemoteCommits: boolean,
  ): Promise<void> {
    if (hasRemoteCommits) {
      try {
        await git.fetch('origin', defaultBranch);

        if (!(await this.hasLocalCommits(git))) {
          await git.checkout(['-B', defaultBranch, `origin/${defaultBranch}`]);
          return;
        }
      } catch (error) {
        logger.warn(`Unable to sync local repository with origin/${defaultBranch}. Continuing with the local branch.`, error);
      }
    }

    await this.ensureLocalBranch(git, defaultBranch);
  }

  private async ensureLocalBranch(git: SimpleGit, branchName: string): Promise<void> {
    const status = await git.status();
    if (status.current === branchName) {
      return;
    }

    const branches = await git.branchLocal();
    if (branches.all.includes(branchName)) {
      await git.checkout(branchName);
      return;
    }

    try {
      await git.checkoutLocalBranch(branchName);
    } catch {
      await git.checkout(['-B', branchName]);
    }
  }

  private async hasLocalCommits(git: SimpleGit): Promise<boolean> {
    try {
      await git.raw(['rev-parse', '--verify', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }
}

export const dailyOrchestrator = new DailyOrchestrator();

import inquirer from 'inquirer';
import chalk from 'chalk';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import type { AppConfig, MatchedIssue, GeneratedContent } from '../types/index.js';
import { githubService, llmService, contentService, gitService } from '../services/index.js';
import { logger, configService } from '../infra/index.js';
import type { ContentType } from '../types/content.types.js';
import { Octokit } from '@octokit/rest';
import { simpleGit } from 'simple-git';

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

    // Limit issues sent to LLM to first 30 to avoid token limits
    const issuesForScoring = issues.slice(0, 30);
    let issuesWithScores = await llmService.scoreIssues(config.userProfile, issuesForScoring);

    // If fewer than 3 results, try with lower threshold
    if (issuesWithScores.length < 3 && issues.length > 30) {
      // Try with more issues
      const moreIssues = issues.slice(30, 60);
      const moreResults = await llmService.scoreIssues(config.userProfile, moreIssues);
      issuesWithScores = [...issuesWithScores, ...moreResults].sort((a, b) => b.matchScore - a.matchScore);
    }

    if (issuesWithScores.length === 0) {
      logger.warn('No issues matched user profile (score >= 60)');
      return;
    }

    // Always show at least top results
    const displayIssues = issuesWithScores.slice(0, 10);

    console.log(chalk.bold(`\n  Found ${issuesWithScores.length} matching issues\n`));
    console.log(chalk.gray('─'.repeat(60)));

    // Show issues with beautiful formatting
    for (let i = 0; i < displayIssues.length; i++) {
      const issue = displayIssues[i];
      const scoreColor = issue.matchScore >= 80 ? chalk.green : issue.matchScore >= 70 ? chalk.cyan : chalk.yellow;

      console.log(`\n  ${chalk.bold(`${i + 1}.`)} ${chalk.white(issue.repoFullName)}${chalk.gray('#')}${chalk.white(issue.number)}`);
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
      value: issue.number.toString(),
    }));

    const { selectedIssueNumber } = await inquirer.prompt<{ selectedIssueNumber: string }>([
      {
        type: 'list',
        name: 'selectedIssueNumber',
        message: 'Select an issue to work on:',
        choices: issueChoices,
      },
    ]);

    const selectedIssue = issuesWithScores.find(
      i => i.number.toString() === selectedIssueNumber
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

  private async ensureTargetRepo(config: AppConfig): Promise<string> {
    if (config.github.targetRepoPath && existsSync(config.github.targetRepoPath)) {
      return config.github.targetRepoPath;
    }

    const repoName = 'openmeta-daily';
    const repoPath = `${homedir}/.openmeta/${repoName}`;

    if (!existsSync(repoPath)) {
      mkdirSync(repoPath, { recursive: true });
    }

    const git = simpleGit(repoPath);

    // Check if already a git repo
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      await git.init();
    }

    // Check if remote already exists
    const remotes = await git.getRemotes();
    let hasOrigin = remotes.some(r => r.name === 'origin');

    if (!hasOrigin) {
      // Check if repo exists on GitHub
      try {
        await this.octokit!.rest.repos.get({
          owner: config.github.username,
          repo: repoName,
        });
        // Repo exists, just add remote
        await git.addRemote('origin', `https://github.com/${config.github.username}/${repoName}.git`);
        logger.success(`Connected to existing repository: https://github.com/${config.github.username}/${repoName}`);
      } catch {
        // Repo doesn't exist, create it
        const { data } = await this.octokit!.rest.repos.createForAuthenticatedUser({
          name: repoName,
          private: true,
          auto_init: true,
          description: 'Daily open source contribution tracking',
        });
        await git.addRemote('origin', data.clone_url);
        logger.success(`Created repository: ${data.clone_url}`);
      }
    }

    return repoPath;
  }
}

export const dailyOrchestrator = new DailyOrchestrator();

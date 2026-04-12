import inquirer from 'inquirer';
import type { AppConfig, ProficiencyLevel, LLMProvider } from '../types/index.js';
import { githubService, llmService } from '../services/index.js';
import { configService, logger } from '../infra/index.js';

const MINIMAX_OPENAI_BASE_URL = 'https://api.minimaxi.com/v1';
const MINIMAX_MODELS = [
  { name: 'MiniMax-M2.7 (Latest, Fast)', value: 'MiniMax-M2.7' },
  { name: 'MiniMax-M2.5', value: 'MiniMax-M2.5' },
  { name: 'MiniMax-M2.1', value: 'MiniMax-M2.1' },
  { name: 'MiniMax-M2', value: 'MiniMax-M2' },
];

const OPENAI_MODELS = [
  { name: 'GPT-4o-mini (Recommended)', value: 'gpt-4o-mini' },
  { name: 'GPT-4o', value: 'gpt-4o' },
  { name: 'GPT-4-turbo', value: 'gpt-4-turbo' },
  { name: 'Custom model name...', value: '__custom__' },
];

export class InitOrchestrator {
  async execute(): Promise<void> {
    logger.info('Starting OpenMeta CLI initialization...');

    const config = await configService.get();

    console.log('\n=== Step 1: GitHub Configuration ===\n');

    const pat = await this.promptGitHubPAT();
    const username = await this.promptUsername();

    githubService.initialize(pat, username);
    const ghValid = await githubService.validateCredentials();
    if (!ghValid) {
      console.log('\n❌ GitHub token validation failed. Please check your PAT and try again.\n');
      console.log('Make sure your PAT has the following permissions:');
      console.log('  - repo (Full repository access)');
      console.log('  - user (Read user profile info)\n');
      const { retry } = await inquirer.prompt<{ retry: boolean }>([
        {
          type: 'confirm',
          name: 'retry',
          message: 'Do you want to try again?',
          default: true,
        },
      ]);
      if (retry) {
        await this.execute();
        return;
      } else {
        logger.info('Initialization cancelled');
        return;
      }
    }

    console.log('\n=== Step 2: LLM API Configuration ===\n');

    const { provider } = await inquirer.prompt<{ provider: LLMProvider }>([
      {
        type: 'list',
        name: 'provider',
        message: 'Select LLM provider:',
        choices: [
          { name: 'OpenAI (or OpenAI-compatible API)', value: 'openai' },
          { name: 'MiniMax (OpenAI-compatible)', value: 'minimax' },
        ],
      },
    ]);

    let apiBaseUrl: string;
    let modelName: string;

    if (provider === 'minimax') {
      apiBaseUrl = MINIMAX_OPENAI_BASE_URL;
      const { selectedModel } = await inquirer.prompt<{ selectedModel: string }>([
        {
          type: 'list',
          name: 'selectedModel',
          message: 'Select MiniMax model:',
          choices: MINIMAX_MODELS,
        },
      ]);
      modelName = selectedModel;
    } else {
      const { selectedModel } = await inquirer.prompt<{ selectedModel: string }>([
        {
          type: 'list',
          name: 'selectedModel',
          message: 'Select OpenAI model:',
          choices: OPENAI_MODELS,
        },
      ]);

      if (selectedModel === '__custom__') {
        const { customModel } = await inquirer.prompt<{ customModel: string }>([
          {
            type: 'input',
            name: 'customModel',
            message: 'Enter custom model name:',
            validate: (input) => input.length > 0 || 'Model name is required',
          },
        ]);
        modelName = customModel;
      } else {
        modelName = selectedModel;
      }

      const { baseUrlInput } = await inquirer.prompt<{ baseUrlInput: string }>([
        {
          type: 'input',
          name: 'baseUrlInput',
          message: 'Enter API Base URL (press Enter for default):',
          default: 'https://api.openai.com/v1',
        },
      ]);
      apiBaseUrl = baseUrlInput || 'https://api.openai.com/v1';
    }

    const apiKey = await this.promptAPIKey();

    llmService.initialize(apiKey, apiBaseUrl, provider, modelName);
    const llmValid = await llmService.validateConnection();
    if (!llmValid) {
      console.log('\n❌ LLM API connection failed. Please check your API key and base URL.\n');
      const { retry } = await inquirer.prompt<{ retry: boolean }>([
        {
          type: 'confirm',
          name: 'retry',
          message: 'Do you want to try again?',
          default: true,
        },
      ]);
      if (retry) {
        await this.execute();
        return;
      } else {
        logger.info('Initialization cancelled');
        return;
      }
    }

    console.log('\n=== Step 3: User Profile ===\n');

    const { techStack } = await inquirer.prompt<{ techStack: string }>([
      {
        type: 'input',
        name: 'techStack',
        message: 'Enter your tech stack (comma-separated, e.g., TypeScript, React, Node.js):',
        default: '',
      },
    ]);

    const { proficiency } = await inquirer.prompt<{ proficiency: ProficiencyLevel }>([
      {
        type: 'list',
        name: 'proficiency',
        message: 'Select your proficiency level:',
        choices: [
          { name: 'Beginner', value: 'beginner' },
          { name: 'Intermediate', value: 'intermediate' },
          { name: 'Advanced', value: 'advanced' },
        ],
      },
    ]);

    const { focusAreas } = await inquirer.prompt<{ focusAreas: string }>([
      {
        type: 'input',
        name: 'focusAreas',
        message: 'Enter your focus areas (comma-separated, e.g., web-dev, devops, ai):',
        default: '',
      },
    ]);

    console.log('\n=== Step 4: Target Repository ===\n');

    const { targetRepoPath } = await inquirer.prompt<{ targetRepoPath: string }>([
      {
        type: 'input',
        name: 'targetRepoPath',
        message: 'Enter the absolute path to your target private repository for commits:',
        validate: async (input) => {
          if (input.length === 0) return 'Path is required';
          const { existsSync } = await import('fs');
          if (!existsSync(input)) return 'Path does not exist';
          return true;
        },
      },
    ]);

    const newConfig: AppConfig = {
      ...config,
      userProfile: {
        techStack: techStack.split(',').map(s => s.trim()).filter(Boolean),
        proficiency,
        focusAreas: focusAreas.split(',').map(s => s.trim()).filter(Boolean),
      },
      github: {
        pat,
        username,
        targetRepoPath,
      },
      llm: {
        provider,
        apiBaseUrl,
        apiKey,
        modelName,
      },
    };

    await configService.save(newConfig);

    logger.success('\nInitialization completed successfully!');
    console.log(`\nConfiguration saved to: ${configService.getConfigPath()}`);
    console.log('\nYou can now run "openmeta daily" to start your daily contribution.');
  }

  private async promptGitHubPAT(): Promise<string> {
    const { pat } = await inquirer.prompt<{ pat: string }>([
      {
        type: 'password',
        name: 'pat',
        message: 'Enter your GitHub Personal Access Token (PAT):',
        mask: '*',
        validate: (input) => input.length > 0 || 'PAT is required',
      },
    ]);
    return pat;
  }

  private async promptAPIKey(): Promise<string> {
    const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your LLM API Key:',
        mask: '*',
        validate: (input) => input.length > 0 || 'API Key is required',
      },
    ]);
    return apiKey;
  }

  private async promptUsername(): Promise<string> {
    const { username } = await inquirer.prompt<{ username: string }>([
      {
        type: 'input',
        name: 'username',
        message: 'Enter your GitHub username:',
        validate: (input) => input.length > 0 || 'Username is required',
      },
    ]);
    return username;
  }
}

export const initOrchestrator = new InitOrchestrator();

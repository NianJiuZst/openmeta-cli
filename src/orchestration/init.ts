import inquirer from 'inquirer';
import type { AppConfig, ProficiencyLevel } from '../types/index.js';
import { githubService, llmService } from '../services/index.js';
import { configService, logger } from '../infra/index.js';

interface LLMProviderOption {
  name: string;
  value: string;
  baseUrl: string;
  models: Array<{ name: string; value: string }>;
}

const LLM_PROVIDERS: LLMProviderOption[] = [
  {
    name: 'OpenAI',
    value: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { name: 'GPT-4o-mini (推荐)', value: 'gpt-4o-mini' },
      { name: 'GPT-4o', value: 'gpt-4o' },
      { name: 'GPT-4-turbo', value: 'gpt-4-turbo' },
    ],
  },
  {
    name: 'MiniMax (OpenAI兼容)',
    value: 'minimax',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: [
      { name: 'MiniMax-M2.7 (最新)', value: 'MiniMax-M2.7' },
      { name: 'MiniMax-M2.5', value: 'MiniMax-M2.5' },
      { name: 'MiniMax-M2.1', value: 'MiniMax-M2.1' },
      { name: 'MiniMax-M2', value: 'MiniMax-M2' },
    ],
  },
  {
    name: 'SiliconFlow (国内可用)',
    value: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      { name: 'Qwen/Qwen2.5-72B-Instruct', value: 'Qwen/Qwen2.5-72B-Instruct' },
      { name: 'deepseek-ai/DeepSeek-V2.5', value: 'deepseek-ai/DeepSeek-V2.5' },
      { name: 'THUDM/glm-4-9b-chat', value: 'THUDM/glm-4-9b-chat' },
    ],
  },
  {
    name: 'Groq (免费额度)',
    value: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      { name: 'llama-3.1-70b-versatile', value: 'llama-3.1-70b-versatile' },
      { name: 'mixtral-8x7b-32768', value: 'mixtral-8x7b-32768' },
      { name: 'llama3-70b-8192', value: 'llama3-70b-8192' },
    ],
  },
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

    // Step 2a: Select provider
    const providerChoices = LLM_PROVIDERS.map(p => ({
      name: p.name,
      value: p.value,
    }));

    const { providerValue } = await inquirer.prompt<{ providerValue: string }>([
      {
        type: 'list',
        name: 'providerValue',
        message: 'Select LLM provider:',
        choices: providerChoices,
      },
    ]);

    // Find the selected provider
    const selectedProvider = LLM_PROVIDERS.find(p => p.value === providerValue);
    if (!selectedProvider) {
      throw new Error(`Provider not found: ${providerValue}`);
    }

    console.log(`Selected provider: ${selectedProvider.name}`);

    // Step 2b: Select model
    const modelChoices = selectedProvider.models.map(m => ({
      name: m.name,
      value: m.value,
    }));

    const { modelValue } = await inquirer.prompt<{ modelValue: string }>([
      {
        type: 'list',
        name: 'modelValue',
        message: 'Select model:',
        choices: modelChoices,
      },
    ]);

    console.log(`Selected model: ${modelValue}`);

    // Step 2c: Enter API key
    const apiKey = await this.promptAPIKey();

    // Step 2d: Validate connection
    llmService.initialize(apiKey, selectedProvider.baseUrl, modelValue);
    const llmValid = await llmService.validateConnection();
    if (!llmValid) {
      console.log('\n❌ LLM API connection failed. Please check your API key.\n');
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
        provider: providerValue as 'openai' | 'minimax',
        apiBaseUrl: selectedProvider.baseUrl,
        apiKey,
        modelName: modelValue,
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

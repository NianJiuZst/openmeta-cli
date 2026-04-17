import chalk from 'chalk';
import { existsSync } from 'fs';
import type { AppConfig } from '../types/index.js';
import type { UserProficiency } from '../types/config.types.js';
import { githubService, llmService } from '../services/index.js';
import { configService, prompt, selectPrompt, ui } from '../infra/index.js';

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
      { name: 'GPT-4o-mini', value: 'gpt-4o-mini' },
      { name: 'GPT-4o', value: 'gpt-4o' },
      { name: 'GPT-4-turbo', value: 'gpt-4-turbo' },
    ],
  },
  {
    name: 'MiniMax',
    value: 'minimax',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: [
      { name: 'MiniMax-M2.7', value: 'MiniMax-M2.7' },
      { name: 'MiniMax-M2.5', value: 'MiniMax-M2.5' },
      { name: 'MiniMax-M2.1', value: 'MiniMax-M2.1' },
      { name: 'MiniMax-M2', value: 'MiniMax-M2' },
    ],
  },
];

const TECH_STACK_CHOICES = [
  'TypeScript',
  'JavaScript',
  'Node.js',
  'React',
  'Vue',
  'Python',
  'Django',
  'FastAPI',
  'Go',
  'Rust',
  'Java',
  'Spring Boot',
  'C++',
  'Swift',
  'Kotlin',
  'Docker',
];

const FOCUS_AREA_CHOICES = [
  { name: 'Web Development', value: 'web-dev' },
  { name: 'Backend / API', value: 'backend' },
  { name: 'DevOps / Infrastructure', value: 'devops' },
  { name: 'AI / Machine Learning', value: 'ai-ml' },
  { name: 'Mobile Development', value: 'mobile' },
  { name: 'Security', value: 'security' },
  { name: 'Data Engineering', value: 'data' },
  { name: 'Open Source', value: 'open-source' },
];

export class InitOrchestrator {
  async execute(): Promise<void> {
    ui.banner({
      label: 'OpenMeta Init',
      title: 'Build your contribution workspace',
      subtitle: 'We will verify GitHub access, connect an LLM provider, and save your matching profile.',
      lines: [
        'Everything stays local except the API calls you explicitly configure.',
        'Press Ctrl+C at any time to leave the setup cleanly.',
      ],
    });

    const config = await configService.get();

    ui.section('Step 1 · GitHub access', 'OpenMeta needs a GitHub token so it can discover and rank contribution issues.');

    let pat = '';
    let username = '';
    let ghValid = false;

    while (!ghValid) {
      pat = await this.promptGitHubPAT();
      username = await this.promptUsername();

      githubService.initialize(pat, username);
      ghValid = await githubService.validateCredentials();

      if (!ghValid) {
        console.log(`\n  ${chalk.red('GitHub validation failed.')}`);
        console.log(`  ${chalk.gray('Suggested scopes:')} ${chalk.white('repo, user')}\n`);

        const { retry } = await prompt<{ retry: boolean }>([
          {
            type: 'confirm',
            name: 'retry',
            message: 'Try another GitHub token?',
            default: true,
          },
        ]);
        if (!retry) {
          ui.banner({
            label: 'OpenMeta Init',
            title: 'Setup paused',
            subtitle: 'GitHub access was not configured. Run "openmeta init" again whenever you are ready.',
            tone: 'warning',
          });
          return;
        }
      }
    }

    ui.section('Step 2 · LLM provider', 'Your model is used to score issues and draft research notes or diaries.');

    let providerValue = '';
    let selectedProvider: LLMProviderOption | undefined;
    let modelValue = '';
    let apiKey = '';
    let llmValid = false;

    while (!llmValid) {
      providerValue = await selectPrompt<string>({
        message: 'Select LLM provider:',
        default: config.llm.provider,
        choices: LLM_PROVIDERS.map(provider => ({
          name: provider.name,
          value: provider.value,
          description: provider.baseUrl,
        })),
      });

      selectedProvider = LLM_PROVIDERS.find(p => p.value === providerValue);
      if (!selectedProvider) {
        throw new Error(`Provider not found: ${providerValue}`);
      }

      modelValue = await selectPrompt<string>({
        message: 'Select model:',
        default: config.llm.modelName,
        choices: selectedProvider.models.map(model => ({
          name: model.name,
          value: model.value,
        })),
      });

      apiKey = await this.promptAPIKey();

      llmService.initialize(apiKey, selectedProvider.baseUrl, modelValue);
      llmValid = await llmService.validateConnection();

      if (!llmValid) {
        console.log(`\n  ${chalk.red('LLM validation failed.')}`);
        console.log(`  ${chalk.gray('Check the provider, model, and API key, then try again.')}\n`);

        const { retry } = await prompt<{ retry: boolean }>([
          {
            type: 'confirm',
            name: 'retry',
            message: 'Try another provider or API key?',
            default: true,
          },
        ]);
        if (!retry) {
          ui.banner({
            label: 'OpenMeta Init',
            title: 'Setup paused',
            subtitle: 'The LLM provider was not configured. Run "openmeta init" again when you want to continue.',
            tone: 'warning',
          });
          return;
        }
      }
    }

    ui.section('Step 3 · Your matching profile', 'Choose the stack and focus areas that should influence issue scoring.');

    const { techStack } = await prompt<{
      techStack: string[];
    }>([
      {
        type: 'checkbox',
        name: 'techStack',
        message: '  Select your tech stack:',
        choices: TECH_STACK_CHOICES.map(tech => ({
          name: tech,
          value: tech,
          checked: config.userProfile.techStack.includes(tech),
        })),
        validate: (input: string[]) => input.length > 0 || 'Select at least one technology',
      },
    ]);

    const proficiency = await selectPrompt<UserProficiency>({
      message: 'Select your current proficiency level:',
      default: config.userProfile.proficiency,
      choices: [
        { name: 'Beginner', value: 'beginner', description: 'New to the stack, prefer guided issues.' },
        { name: 'Intermediate', value: 'intermediate', description: 'Comfortable with the stack, can handle moderate tasks.' },
        { name: 'Advanced', value: 'advanced', description: 'Deep experience, ready for complex changes.' },
      ],
    });

    const { focusAreas } = await prompt<{
      focusAreas: string[];
    }>([
      {
        type: 'checkbox',
        name: 'focusAreas',
        message: '  Select your focus areas:',
        choices: FOCUS_AREA_CHOICES.map(area => ({
          ...area,
          checked: config.userProfile.focusAreas.includes(area.value),
        })),
        validate: (input: string[]) => input.length > 0 || 'Select at least one focus area',
      },
    ]);

    ui.section('Step 4 · Target repository', 'Leave this blank if you want OpenMeta to manage a dedicated private repo for you.');

    const { targetRepoPath } = await prompt<{ targetRepoPath: string }>([
      {
        type: 'input',
        name: 'targetRepoPath',
        message: 'Enter the path to your private repository (optional):',
        default: config.github.targetRepoPath || '',
        filter: (input: string) => input.trim(),
        validate: async (input: string) => {
          if (!input) {
            return true;
          }

          if (!existsSync(input)) {
            return 'This path does not exist.';
          }

          const isValidRepo = await githubService.validateTargetRepo(input);
          if (!isValidRepo) {
            return 'This path must be a git repository with a configured remote.';
          }

          return true;
        },
      },
    ]);

    const newConfig: AppConfig = {
      ...config,
      userProfile: {
        techStack,
        proficiency,
        focusAreas,
      },
      github: {
        pat,
        username,
        targetRepoPath: targetRepoPath || undefined,
      },
      llm: {
        provider: providerValue as 'openai' | 'minimax',
        apiBaseUrl: selectedProvider!.baseUrl,
        apiKey,
        modelName: modelValue,
      },
    };

    await configService.save(newConfig);

    ui.banner({
      label: 'OpenMeta Init',
      title: 'Setup complete',
      subtitle: 'Your local workspace is ready for daily issue discovery and note generation.',
      lines: [
        `GitHub account: ${username}`,
        `Model: ${selectedProvider!.name} / ${modelValue}`,
        `Target repo: ${targetRepoPath || 'Auto-managed private repository'}`,
        `Config saved at: ${configService.getConfigPath()}`,
        'Next step: run "openmeta daily".',
      ],
      tone: 'success',
    });
  }

  private async promptGitHubPAT(): Promise<string> {
    const { pat } = await prompt<{ pat: string }>([
      {
        type: 'password',
        name: 'pat',
        message: 'Enter your GitHub Personal Access Token (PAT):',
        mask: '*',
        validate: (input: string) => input.trim().length > 0 || 'PAT is required.',
      },
    ]);
    return pat.trim();
  }

  private async promptAPIKey(): Promise<string> {
    const { apiKey } = await prompt<{ apiKey: string }>([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your LLM API Key:',
        mask: '*',
        validate: (input: string) => input.trim().length > 0 || 'API key is required.',
      },
    ]);
    return apiKey.trim();
  }

  private async promptUsername(): Promise<string> {
    const { username } = await prompt<{ username: string }>([
      {
        type: 'input',
        name: 'username',
        message: 'Enter your GitHub username:',
        filter: (input: string) => input.trim(),
        validate: (input: string) => input.trim().length > 0 || 'GitHub username is required.',
      },
    ]);
    return username.trim();
  }
}

export const initOrchestrator = new InitOrchestrator();

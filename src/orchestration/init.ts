import { existsSync } from 'fs';
import type { AppConfig } from '../types/index.js';
import type { UserProficiency } from '../types/config.types.js';
import {
  githubService,
  llmService,
  schedulerService,
  LLM_PROVIDER_PRESETS,
  findLLMProviderPreset,
  type SchedulerSyncResult,
} from '../services/index.js';
import { configService, prompt, selectPrompt, ui } from '../infra/index.js';
import type { ContentType } from '../types/content.types.js';

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

type SetupStepId = 'github' | 'llm' | 'profile' | 'targetRepo' | 'automation';

const SETUP_STEPS: Array<{ id: SetupStepId; label: string }> = [
  {
    id: 'github',
    label: 'GitHub access',
  },
  {
    id: 'llm',
    label: 'LLM provider',
  },
  {
    id: 'profile',
    label: 'Matching profile',
  },
  {
    id: 'targetRepo',
    label: 'Target repository',
  },
  {
    id: 'automation',
    label: 'Automation policy',
  },
];

export class InitOrchestrator {
  async execute(): Promise<void> {
    ui.hero({
      label: 'OpenMeta Init',
      title: 'Assemble a sharper cockpit for contribution work',
      subtitle: 'Connect GitHub, your model, and your preferences so every later run feels guided instead of improvised.',
      lines: [
        'Local-first by default. Only the APIs you explicitly authorize ever leave the machine.',
        'Once saved, OpenMeta remembers the route as well as the result. Press Ctrl+C at any time to step away cleanly.',
      ],
    });

    const config = await configService.get();
    const completedSteps = new Set<SetupStepId>();

    this.renderStep('github', completedSteps, 'OpenMeta needs a GitHub token so it can discover and rank contribution issues.');

    let pat = '';
    let username = '';
    let ghValid = false;

    while (!ghValid) {
      pat = await this.promptGitHubPAT();
      username = await this.promptUsername();

      githubService.initialize(pat, username);
      ghValid = await this.validateGitHubCredentials();

      if (!ghValid) {
        this.renderStep('github', completedSteps, 'GitHub credentials need to be retried.', true);
        ui.callout({
          label: 'OpenMeta Init',
          title: 'GitHub validation failed',
          subtitle: 'OpenMeta could not verify repository access with the token and username you entered.',
          lines: [
            'Suggested token scopes: repo, user',
            'Check that the username matches the token owner.',
          ],
          tone: 'warning',
        });

        const { retry } = await prompt<{ retry: boolean }>([
          {
            type: 'confirm',
            name: 'retry',
            message: 'Try another GitHub token?',
            default: true,
          },
        ]);
        if (!retry) {
          ui.callout({
            label: 'OpenMeta Init',
            title: 'Setup paused',
            subtitle: 'GitHub access was not configured. Run "openmeta init" again whenever you are ready.',
            tone: 'warning',
          });
          return;
        }
      }
    }

    completedSteps.add('github');
    ui.keyValues('GitHub connected', [
      { label: 'Username', value: username, tone: 'success' },
      { label: 'Token', value: ui.maskSecret(pat), tone: 'success' },
    ]);

    this.renderStep('llm', completedSteps, 'Your model is used to score issues and draft research notes or diaries.');

    let providerValue = '';
    let selectedProvider = findLLMProviderPreset(config.llm.provider);
    let modelValue = '';
    let apiBaseUrl = '';
    let apiHeaders: Record<string, string> = {};
    let apiKey = '';
    let llmValid = false;

    while (!llmValid) {
      providerValue = await selectPrompt<string>({
        message: 'Select LLM provider:',
        default: this.getProviderDefault(config.llm.provider),
        choices: LLM_PROVIDER_PRESETS.map(provider => ({
          name: provider.name,
          value: provider.value,
          description: provider.baseUrl || 'Bring your own compatible endpoint',
        })),
      });

      selectedProvider = findLLMProviderPreset(providerValue as AppConfig['llm']['provider']);
      if (!selectedProvider) {
        throw new Error(`Provider not found: ${providerValue}`);
      }

      apiHeaders = selectedProvider.apiHeaders || {};
      apiBaseUrl = selectedProvider.allowCustomBaseUrl
        ? await this.promptApiBaseUrl(config.llm.apiBaseUrl)
        : selectedProvider.baseUrl;

      modelValue = selectedProvider.allowCustomModel
        ? await this.promptModelName(config.llm.modelName)
        : await selectPrompt<string>({
          message: 'Select model:',
          default: config.llm.modelName,
          choices: selectedProvider.models.map((model) => ({
            name: model.name,
            value: model.value,
          })),
        });

      apiKey = await this.promptAPIKey();

      llmService.initialize(
        apiKey,
        apiBaseUrl,
        modelValue,
        apiHeaders,
        selectedProvider.value as AppConfig['llm']['provider'],
      );
      llmValid = await this.validateLlmConnection();

      if (!llmValid) {
        // 保留底层失败原因，方便用户区分是鉴权、配额还是网关问题。
        const validationDetail = llmService.getLastValidationError();
        this.renderStep('llm', completedSteps, 'Provider validation needs to be retried.', true);
        ui.callout({
          label: 'OpenMeta Init',
          title: 'LLM validation failed',
          subtitle: 'OpenMeta could not connect to the configured provider with the selected model and API key.',
          lines: [
            'Check provider endpoint, model name, and API key.',
            'If you use a proxy or compatible endpoint, confirm the base URL is correct.',
            ...(validationDetail ? [`Provider detail: ${validationDetail}`] : []),
          ],
          tone: 'warning',
        });

        const { retry } = await prompt<{ retry: boolean }>([
          {
            type: 'confirm',
            name: 'retry',
            message: 'Try another provider or API key?',
            default: true,
          },
        ]);
        if (!retry) {
          ui.callout({
            label: 'OpenMeta Init',
            title: 'Setup paused',
            subtitle: 'The LLM provider was not configured. Run "openmeta init" again when you want to continue.',
            tone: 'warning',
          });
          return;
        }
      }
    }

    completedSteps.add('llm');
    ui.keyValues('LLM provider connected', [
      { label: 'Provider', value: selectedProvider!.name, tone: 'success' },
      { label: 'Model', value: modelValue, tone: 'success' },
      { label: 'Endpoint', value: apiBaseUrl, tone: 'info' },
      { label: 'Extra headers', value: Object.keys(apiHeaders).length > 0 ? JSON.stringify(apiHeaders) : '(none)', tone: 'info' },
      { label: 'API key', value: ui.maskSecret(apiKey), tone: 'success' },
    ]);

    this.renderStep('profile', completedSteps, 'Choose the stack and focus areas that should influence issue scoring.');

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

    completedSteps.add('profile');
    ui.keyValues('Matching profile captured', [
      { label: 'Tech stack', value: techStack.join(', '), tone: 'info' },
      { label: 'Proficiency', value: proficiency, tone: 'info' },
      { label: 'Focus areas', value: focusAreas.join(', '), tone: 'info' },
    ]);

    this.renderStep('targetRepo', completedSteps, 'Leave this blank if you want OpenMeta to manage a dedicated private repo for you.');

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

    completedSteps.add('targetRepo');
    ui.keyValues('Target repository policy', [
      {
        label: 'Publish destination',
        value: targetRepoPath || 'Auto-managed private repository',
        tone: targetRepoPath ? 'info' : 'accent',
      },
    ]);

    this.renderStep('automation', completedSteps, 'OpenMeta can install a system scheduler so one init keeps your autonomous contribution agent running unattended.');

    const { automationEnabled } = await prompt<{ automationEnabled: boolean }>([
      {
        type: 'confirm',
        name: 'automationEnabled',
        message: 'Enable unattended agent automation?',
        default: config.automation.enabled,
      },
    ]);

    let scheduleTime = config.automation.scheduleTime;
    let contentType = config.automation.contentType;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || config.automation.timezone;
    const scheduler = schedulerService.detectProvider();

    if (automationEnabled) {
      const scheduleResponse = await prompt<{ scheduleTime: string }>([
        {
          type: 'input',
          name: 'scheduleTime',
          message: 'Run every day at what local time? (HH:mm)',
          default: config.automation.scheduleTime,
          filter: (input: string) => input.trim(),
          validate: (input: string) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(input) || 'Enter time as HH:mm.',
        },
      ]);
      scheduleTime = scheduleResponse.scheduleTime;

      contentType = await selectPrompt<ContentType>({
        message: 'Default content type for legacy daily note runs:',
        default: config.automation.contentType,
        choices: [
          { name: 'Research Notes', value: 'research_note', description: 'Safer default for unattended runs.' },
          { name: 'Development Diary', value: 'development_diary', description: 'Generates diary-style summaries without code snippets.' },
        ],
      });

      const confirmed = await this.confirmPersistentAutomation(scheduleTime, timezone);
      if (!confirmed) {
        ui.callout({
          label: 'OpenMeta Init',
          title: 'Automation not enabled',
          subtitle: 'Persistent unattended execution was cancelled before any scheduler changes were made.',
          lines: [
            'You can still run "openmeta daily" manually.',
            'Enable later with "openmeta init" or "openmeta automation enable".',
          ],
          tone: 'warning',
        });
        return;
      }
    }

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
        provider: providerValue as AppConfig['llm']['provider'],
        apiBaseUrl,
        apiKey,
        modelName: modelValue,
        apiHeaders,
      },
      automation: {
        ...config.automation,
        enabled: automationEnabled,
        scheduleTime,
        timezone,
        contentType,
        scheduler,
      },
    };

    await ui.task({
      title: 'Saving local configuration',
      doneMessage: 'Local configuration saved',
      failedMessage: 'Saving local configuration failed',
      tone: 'info',
    }, async () => {
      await configService.save(newConfig);
    });

    const schedulerResult = await ui.task({
      title: 'Syncing automation policy',
      doneMessage: 'Automation policy synced',
      failedMessage: 'Automation policy sync failed',
      tone: automationEnabled ? 'warning' : 'info',
    }, async () => schedulerService.sync(newConfig));
    const nextStepMessage = this.getNextStepMessage(newConfig, schedulerResult);
    completedSteps.add('automation');

    ui.hero({
      label: 'OpenMeta Init',
      title: 'The cockpit is wired and ready',
      subtitle: 'OpenMeta now has enough shape to scout, draft, and automate with intention instead of guesswork.',
      lines: [
        `Config saved at: ${configService.getConfigPath()}`,
        nextStepMessage,
      ],
      tone: schedulerResult.status === 'failed' ? 'warning' : 'success',
    });

    ui.stats('Setup summary', [
      { label: 'GitHub', value: username, tone: 'success' },
      { label: 'Model', value: modelValue, hint: selectedProvider!.name, tone: 'success' },
      { label: 'Repo policy', value: targetRepoPath ? 'CUSTOM' : 'MANAGED', tone: 'accent' },
      { label: 'Automation', value: automationEnabled ? 'ENABLED' : 'MANUAL', tone: automationEnabled ? 'warning' : 'muted' },
    ]);
    ui.keyValues('Saved preferences', [
      { label: 'Tech stack', value: techStack.join(', '), tone: 'info' },
      { label: 'Proficiency', value: proficiency, tone: 'info' },
      { label: 'Focus areas', value: focusAreas.join(', '), tone: 'info' },
      { label: 'Target repo', value: targetRepoPath || 'Auto-managed private repository', tone: 'info' },
      { label: 'Automation', value: this.formatAutomationSummary(newConfig, schedulerResult), tone: schedulerResult.status === 'failed' ? 'warning' : 'success' },
    ]);
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

  private async promptApiBaseUrl(defaultValue: string): Promise<string> {
    const { apiBaseUrl } = await prompt<{ apiBaseUrl: string }>([
      {
        type: 'input',
        name: 'apiBaseUrl',
        message: 'Enter your OpenAI-compatible API base URL:',
        default: defaultValue || 'https://api.openai.com/v1',
        filter: (input: string) => input.trim(),
        validate: (input: string) => input.trim().length > 0 || 'API base URL is required.',
      },
    ]);

    return apiBaseUrl.trim();
  }

  private async promptModelName(defaultValue: string): Promise<string> {
    const { modelName } = await prompt<{ modelName: string }>([
      {
        type: 'input',
        name: 'modelName',
        message: 'Enter your model name:',
        default: defaultValue || 'gpt-4o-mini',
        filter: (input: string) => input.trim(),
        validate: (input: string) => input.trim().length > 0 || 'Model name is required.',
      },
    ]);

    return modelName.trim();
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

  private getProviderDefault(provider: AppConfig['llm']['provider']): string {
    return LLM_PROVIDER_PRESETS.some((option) => option.value === provider)
      ? provider
      : 'custom';
  }

  private formatAutomationSummary(config: AppConfig, result: SchedulerSyncResult): string {
    if (!config.automation.enabled) {
      return 'Automation: disabled.';
    }

    if (result.status === 'installed') {
      return `Automation: ${config.automation.scheduler} installed for ${config.automation.scheduleTime} (${config.automation.timezone}).`;
    }

    if (result.status === 'manual') {
      return `Automation: scheduler unsupported on this platform. Manual command: ${result.command}`;
    }

    return `Automation: configuration saved, but scheduler setup needs attention (${result.detail}).`;
  }

  private async confirmPersistentAutomation(scheduleTime: string, timezone: string): Promise<boolean> {
    ui.callout({
      label: 'OpenMeta Init',
      title: 'Persistent automation warning',
      subtitle: 'When enabled, OpenMeta installs a system-level scheduled task that runs the autonomous contribution agent every day until you turn it off.',
      lines: [
        `Current target time: ${scheduleTime} (${timezone})`,
        'Scheduled runs use headless agent mode and can commit and push generated artifacts without interactive review.',
        'Disable command: openmeta automation disable',
      ],
      tone: 'warning',
    });

    ui.keyValues('Automation impact', [
      { label: 'Execution mode', value: 'Headless autonomous agent', tone: 'warning' },
      { label: 'Interactive review', value: 'Skipped during scheduled runs', tone: 'warning' },
      { label: 'Rollback', value: 'openmeta automation disable', tone: 'info' },
    ]);

    const { acknowledgePersistence } = await prompt<{ acknowledgePersistence: boolean }>([
      {
        type: 'confirm',
        name: 'acknowledgePersistence',
        message: 'Do you understand that this creates a long-running scheduled task on your machine?',
        default: false,
      },
    ]);

    if (!acknowledgePersistence) {
      return false;
    }

    const { finalConsent } = await prompt<{ finalConsent: boolean }>([
      {
        type: 'confirm',
        name: 'finalConsent',
        message: 'Enable persistent daily automation now?',
        default: false,
      },
    ]);

    return finalConsent;
  }

  private getNextStepMessage(config: AppConfig, result: SchedulerSyncResult): string {
    if (!config.automation.enabled) {
      return 'Next step: run "openmeta daily".';
    }

    if (result.status === 'installed') {
      return 'OpenMeta will keep running daily in headless mode.';
    }

    if (result.status === 'manual') {
      return 'Add the manual command above to your system scheduler.';
    }

    return 'Fix the scheduler issue above, then rerun "openmeta init".';
  }

  private renderStep(
    currentStep: SetupStepId,
    completedSteps: Set<SetupStepId>,
    subtitle: string,
    failed: boolean = false,
  ): void {
    const currentIndex = SETUP_STEPS.findIndex((step) => step.id === currentStep);
    const stateLabel = failed ? 'needs attention' : completedSteps.has(currentStep) ? '[success]' : 'in progress';

    ui.section(
      `Step ${currentIndex + 1} of ${SETUP_STEPS.length} · ${SETUP_STEPS[currentIndex]?.label || currentStep} · ${stateLabel}`,
      subtitle,
    );
  }

  private async validateGitHubCredentials(): Promise<boolean> {
    try {
      await ui.task({
        title: 'Validating GitHub credentials',
        doneMessage: 'GitHub credentials verified',
        failedMessage: 'GitHub credentials rejected',
        tone: 'info',
      }, async () => {
        const valid = await githubService.validateCredentials();
        if (!valid) {
          throw new Error('GitHub validation failed');
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  private async validateLlmConnection(): Promise<boolean> {
    try {
      await ui.task({
        title: 'Validating LLM provider',
        doneMessage: 'LLM provider verified',
        failedMessage: 'LLM provider rejected',
        tone: 'info',
      }, async () => {
        const valid = await llmService.validateConnection();
        if (!valid) {
          throw new Error('LLM validation failed');
        }
      });
      return true;
    } catch {
      return false;
    }
  }
}

export const initOrchestrator = new InitOrchestrator();

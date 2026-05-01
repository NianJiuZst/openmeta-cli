import { configService, prompt, selectPrompt, ui } from '../infra/index.js';
import { LLM_PROVIDER_PRESETS, findLLMProviderPreset } from '../services/index.js';
import { llmService } from '../services/index.js';
import type { AppConfig, LLMProvider, LLMProviderProfile } from '../types/index.js';

interface ProviderAddOptions {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  header?: string[];
  validate?: boolean;
}

interface ProviderUseOptions {
  validate?: boolean;
}

function parseHeaders(values: string[] = []): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Provider header "${value}" must use key=value format.`);
    }

    const key = value.slice(0, separator).trim();
    const headerValue = value.slice(separator + 1).trim();
    if (!key || !headerValue) {
      throw new Error(`Provider header "${value}" must include both key and value.`);
    }

    headers[key] = headerValue;
  }

  return headers;
}

function parseHeaderInput(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  return parseHeaders(trimmed.split(',').map((item) => item.trim()).filter(Boolean));
}

function parseProvider(value: string | undefined): LLMProvider {
  const provider = (value || 'custom').trim();
  if (!['openai', 'minimax', 'moonshot', 'zhipu', 'gemini', 'claude', 'custom'].includes(provider)) {
    throw new Error('provider must be "openai", "minimax", "moonshot", "zhipu", "gemini", "claude", or "custom".');
  }

  return provider as LLMProvider;
}

function requireValue(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }

  return trimmed;
}

export class ProviderOrchestrator {
  async list(): Promise<void> {
    const config = await configService.get();
    const profiles = config.llm.profiles || {};
    const names = Object.keys(profiles).sort();

    ui.hero({
      label: 'OpenMeta Provider',
      title: names.length > 0 ? 'Saved provider profiles are ready to switch' : 'No provider profiles saved yet',
      subtitle: 'Provider profiles let you keep multiple LLM backends available without repeating config set commands.',
      lines: [
        `Active profile: ${config.llm.activeProfile || '(none)'}`,
      ],
      tone: names.length > 0 ? 'accent' : 'warning',
    });

    if (names.length === 0) {
      ui.emptyState(
        'OpenMeta Provider',
        'No profiles found',
        'Run "openmeta provider save <name>" or "openmeta provider add <name> --base-url <url> --model <model> --api-key <key>".',
      );
      return;
    }

    ui.recordList('Provider profiles', names.map((name) => {
      const profile = profiles[name]!;
      return {
        title: name,
        subtitle: `${profile.provider} / ${profile.modelName}`,
        meta: [
          profile.apiBaseUrl,
          config.llm.activeProfile === name ? 'active' : 'saved',
        ],
        lines: [
          `API key: ${ui.maskSecret(profile.apiKey)}`,
          `Extra headers: ${Object.keys(profile.apiHeaders || {}).length > 0 ? JSON.stringify(profile.apiHeaders) : '(none)'}`,
        ],
        tone: config.llm.activeProfile === name ? 'success' : 'info',
      };
    }));
  }

  async save(nameInput: string): Promise<void> {
    const name = this.normalizeProfileName(nameInput);
    const config = await configService.get();
    const profile = this.currentProfileFromConfig(config);
    const updated = await this.saveProfile(config, name, profile, name);

    ui.card({
      label: 'OpenMeta Provider',
      title: 'Current provider saved as a reusable profile',
      subtitle: 'You can switch back to this LLM backend with one command.',
      lines: [
        `Profile: ${name}`,
        `Provider: ${profile.provider}`,
        `Model: ${profile.modelName}`,
        `Endpoint: ${profile.apiBaseUrl}`,
        `Config path: ${configService.getConfigPath()}`,
      ],
      tone: updated.llm.activeProfile === name ? 'success' : 'info',
    });
  }

  async add(nameInput: string, options: ProviderAddOptions): Promise<void> {
    const name = this.normalizeProfileName(nameInput);
    const config = await configService.get();
    const profile: LLMProviderProfile = {
      provider: parseProvider(options.provider),
      apiBaseUrl: requireValue(options.baseUrl, 'base URL'),
      modelName: requireValue(options.model, 'model'),
      apiKey: requireValue(options.apiKey, 'API key'),
      apiHeaders: parseHeaders(options.header?.filter(Boolean) ?? []),
    };
    const updated = await this.saveProfile(config, name, profile, config.llm.activeProfile);

    ui.card({
      label: 'OpenMeta Provider',
      title: 'Provider profile saved',
      subtitle: options.validate ? 'The profile was saved. Run provider use to activate and validate it.' : 'The profile is available for fast switching.',
      lines: [
        `Profile: ${name}`,
        `Provider: ${profile.provider}`,
        `Model: ${profile.modelName}`,
        `Endpoint: ${profile.apiBaseUrl}`,
        `Active profile: ${updated.llm.activeProfile || '(none)'}`,
      ],
      tone: 'success',
    });
  }

  async configure(): Promise<void> {
    const config = await configService.get();

    ui.hero({
      label: 'OpenMeta Provider',
      title: 'Configure a provider profile without memorizing flags',
      subtitle: 'Save one LLM backend as a named profile, then switch to it whenever OpenMeta needs a different model route.',
      lines: [
        `Current provider: ${config.llm.provider} / ${config.llm.modelName || '(no model)'}`,
        `Active profile: ${config.llm.activeProfile || '(none)'}`,
      ],
      tone: 'accent',
    });

    const { profileName } = await prompt<{ profileName: string }>([
      {
        type: 'input',
        name: 'profileName',
        message: 'Provider profile name:',
        default: this.suggestProfileName(config),
        filter: (input: string) => input.trim(),
        validate: (input: string) => {
          try {
            this.normalizeProfileName(input);
            return true;
          } catch (error) {
            return error instanceof Error ? error.message : 'Invalid provider profile name.';
          }
        },
      },
    ]);
    const name = this.normalizeProfileName(profileName);

    const provider = await selectPrompt<LLMProvider>({
      message: 'Select LLM provider:',
      default: this.getProviderDefault(config.llm.provider),
      choices: LLM_PROVIDER_PRESETS.map((preset) => ({
        name: preset.name,
        value: preset.value,
        description: preset.baseUrl || 'Bring your own OpenAI-compatible endpoint',
      })),
    });
    const preset = findLLMProviderPreset(provider);
    if (!preset) {
      throw new Error(`Provider not found: ${provider}`);
    }

    let apiBaseUrl = preset.baseUrl;
    if (preset.allowCustomBaseUrl) {
      ({ apiBaseUrl } = await prompt<{ apiBaseUrl: string }>([
        {
          type: 'input',
          name: 'apiBaseUrl',
          message: 'OpenAI-compatible API base URL:',
          default: config.llm.apiBaseUrl || 'https://api.openai.com/v1',
          filter: (input: string) => input.trim(),
          validate: (input: string) => input.length > 0 || 'API base URL is required.',
        },
      ]));
    }

    let modelName = config.llm.modelName;
    if (preset.allowCustomModel) {
      ({ modelName } = await prompt<{ modelName: string }>([
        {
          type: 'input',
          name: 'modelName',
          message: 'Model name:',
          default: config.llm.modelName || 'gpt-4o-mini',
          filter: (input: string) => input.trim(),
          validate: (input: string) => input.length > 0 || 'Model name is required.',
        },
      ]));
    } else {
      modelName = await selectPrompt<string>({
        message: 'Select model:',
        default: preset.models.some((model) => model.value === config.llm.modelName)
          ? config.llm.modelName
          : preset.models[0]?.value,
        choices: preset.models.map((model) => ({ name: model.name, value: model.value })),
      });
    }

    const { apiKey } = await prompt<{ apiKey: string }>([
      {
        type: 'password',
        name: 'apiKey',
        message: 'LLM API key:',
        mask: '*',
        validate: (input: string) => input.trim().length > 0 || 'API key is required.',
      },
    ]);

    const { extraHeaders } = await prompt<{ extraHeaders: string }>([
      {
        type: 'input',
        name: 'extraHeaders',
        message: 'Extra headers (optional, comma-separated key=value):',
        default: this.formatHeaderInput(preset.apiHeaders || config.llm.apiHeaders || {}),
        filter: (input: string) => input.trim(),
        validate: (input: string) => {
          try {
            parseHeaderInput(input);
            return true;
          } catch (error) {
            return error instanceof Error ? error.message : 'Invalid header format.';
          }
        },
      },
    ]);

    const { activate } = await prompt<{ activate: boolean }>([
      {
        type: 'confirm',
        name: 'activate',
        message: 'Use this provider profile now?',
        default: true,
      },
    ]);

    let validate = false;
    if (activate) {
      ({ validate } = await prompt<{ validate: boolean }>([
        {
          type: 'confirm',
          name: 'validate',
          message: 'Validate this provider after switching?',
          default: true,
        },
      ]));
    }

    const profile: LLMProviderProfile = {
      provider,
      apiBaseUrl,
      modelName,
      apiKey: apiKey.trim(),
      apiHeaders: {
        ...(preset.apiHeaders || {}),
        ...parseHeaderInput(extraHeaders),
      },
    };

    await this.saveProfile(config, name, profile, config.llm.activeProfile);

    if (activate) {
      await this.use(name, { validate });
      return;
    }

    ui.card({
      label: 'OpenMeta Provider',
      title: 'Provider profile saved',
      subtitle: 'Switch to it later with "openmeta provider use <name>".',
      lines: [
        `Profile: ${name}`,
        `Provider: ${profile.provider}`,
        `Model: ${profile.modelName}`,
        `Endpoint: ${profile.apiBaseUrl}`,
      ],
      tone: 'success',
    });
  }

  async use(nameInput: string, options: ProviderUseOptions = {}): Promise<void> {
    const name = this.normalizeProfileName(nameInput);
    const config = await configService.get();
    const profile = config.llm.profiles?.[name];
    if (!profile) {
      throw new Error(`Provider profile "${name}" does not exist. Run "openmeta provider list" to see saved profiles.`);
    }

    const updated = await configService.update({
      llm: {
        ...config.llm,
        ...profile,
        apiHeaders: profile.apiHeaders ?? config.llm.apiHeaders ?? {},
        activeProfile: name,
        profiles: config.llm.profiles ?? {},
      },
    });

    let validationDetail = 'Validation skipped.';
    let tone: 'success' | 'warning' = 'success';
    if (options.validate) {
      const valid = await this.validateProfile(profile);
      validationDetail = valid
        ? 'Provider validation succeeded.'
        : `Provider validation failed: ${llmService.getLastValidationError() || 'unknown reason'}`;
      tone = valid ? 'success' : 'warning';
    }

    ui.card({
      label: 'OpenMeta Provider',
      title: 'Active provider switched',
      subtitle: 'OpenMeta will use this LLM backend for the next agent or scout run.',
      lines: [
        `Profile: ${name}`,
        `Provider: ${updated.llm.provider}`,
        `Model: ${updated.llm.modelName}`,
        `Endpoint: ${updated.llm.apiBaseUrl}`,
        validationDetail,
      ],
      tone,
    });
  }

  async remove(nameInput: string): Promise<void> {
    const name = this.normalizeProfileName(nameInput);
    const config = await configService.get();
    const profiles = { ...(config.llm.profiles || {}) };
    if (!profiles[name]) {
      throw new Error(`Provider profile "${name}" does not exist.`);
    }

    delete profiles[name];
    const activeProfile = config.llm.activeProfile === name ? '' : config.llm.activeProfile;
    await configService.update({
      llm: {
        ...config.llm,
        activeProfile,
        profiles,
      },
    });

    ui.card({
      label: 'OpenMeta Provider',
      title: 'Provider profile removed',
      subtitle: activeProfile ? 'The active provider remained unchanged.' : 'The removed profile was active, so no profile is now marked active.',
      lines: [
        `Profile: ${name}`,
        `Active profile: ${activeProfile || '(none)'}`,
      ],
      tone: 'success',
    });
  }

  private normalizeProfileName(nameInput: string): string {
    const name = nameInput.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
      throw new Error('Provider profile name must start with a letter or number and may contain letters, numbers, dots, underscores, or dashes.');
    }

    return name;
  }

  private getProviderDefault(provider: LLMProvider): LLMProvider {
    return LLM_PROVIDER_PRESETS.some((option) => option.value === provider)
      ? provider
      : 'custom';
  }

  private suggestProfileName(config: AppConfig): string {
    if (config.llm.activeProfile) {
      return config.llm.activeProfile;
    }

    const model = config.llm.modelName || 'default';
    return `${config.llm.provider}-${model}`
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 64) || 'default';
  }

  private formatHeaderInput(headers: Record<string, string>): string {
    return Object.entries(headers)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
  }

  private currentProfileFromConfig(config: AppConfig): LLMProviderProfile {
    return {
      provider: parseProvider(config.llm.provider),
      apiBaseUrl: config.llm.apiBaseUrl,
      apiKey: config.llm.apiKey,
      modelName: config.llm.modelName,
      apiHeaders: config.llm.apiHeaders ?? {},
    };
  }

  private async saveProfile(
    config: AppConfig,
    name: string,
    profile: LLMProviderProfile,
    activeProfile: string | undefined,
  ): Promise<AppConfig> {
    return configService.update({
      llm: {
        ...config.llm,
        activeProfile: activeProfile || '',
        profiles: {
          ...(config.llm.profiles ?? {}),
          [name]: {
            ...profile,
            apiHeaders: profile.apiHeaders ?? {},
          },
        },
      },
    });
  }

  private async validateProfile(profile: LLMProviderProfile): Promise<boolean> {
    llmService.initialize(
      profile.apiKey,
      profile.apiBaseUrl,
      profile.modelName,
      profile.apiHeaders,
      profile.provider,
    );

    return llmService.validateConnection();
  }
}

export const providerOrchestrator = new ProviderOrchestrator();

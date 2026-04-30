import { configService, ui } from '../infra/index.js';
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

function normalizeProviderName(name: string): string {
  return name.trim();
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
      apiHeaders: parseHeaders(options.header),
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
        activeProfile: name,
        profiles: config.llm.profiles || {},
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
    const name = normalizeProviderName(nameInput);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
      throw new Error('Provider profile name must start with a letter or number and may contain letters, numbers, dots, underscores, or dashes.');
    }

    return name;
  }

  private currentProfileFromConfig(config: AppConfig): LLMProviderProfile {
    return {
      provider: config.llm.provider,
      apiBaseUrl: config.llm.apiBaseUrl,
      apiKey: config.llm.apiKey,
      modelName: config.llm.modelName,
      apiHeaders: config.llm.apiHeaders || {},
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
          ...(config.llm.profiles || {}),
          [name]: profile,
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

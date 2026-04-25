import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import type { AppConfig } from '../types/index.js';
import { CryptoService } from './crypto.js';
import { logger } from './logger.js';

function getConfigDirPath(): string {
  return process.env['OPENMETA_CONFIG_DIR'] || join(homedir(), '.config', 'openmeta');
}

function getConfigFilePath(): string {
  return join(getConfigDirPath(), 'config.json');
}

function getDefaultSchedulerProvider(): AppConfig['automation']['scheduler'] {
  if (process.platform === 'darwin') {
    return 'launchd';
  }

  if (process.platform === 'linux') {
    return 'cron';
  }

  return 'manual';
}

function createDefaultConfig(): AppConfig {
  return {
    userProfile: {
      techStack: [],
      proficiency: 'beginner',
      focusAreas: [],
    },
    github: {
      pat: '',
      username: '',
      targetRepoPath: '',
    },
    llm: {
      provider: 'openai',
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      modelName: 'gpt-4o-mini',
      apiHeaders: {},
    },
    automation: {
      enabled: true,
      scheduleTime: '09:00',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      contentType: 'research_note',
      scheduler: getDefaultSchedulerProvider(),
      minMatchScore: 70,
      skipIfAlreadyGeneratedToday: true,
    },
    commitTemplate: 'feat(daily): {{title}}\n\n{{content}}',
  };
}

export class ConfigService {
  private config: AppConfig | null = null;

  async load(): Promise<AppConfig> {
    const configFilePath = getConfigFilePath();

    if (this.config) {
      return this.config;
    }

    if (existsSync(configFilePath)) {
      try {
        const fileContent = readFileSync(configFilePath, 'utf-8');
        const parsedConfig = JSON.parse(fileContent) as Partial<AppConfig>;
        this.config = this.normalizeConfig(this.decryptConfig(parsedConfig));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to load config from ${configFilePath}: ${message}`);
        throw new Error(`Unable to load OpenMeta configuration. See ${configFilePath} for details.`);
      }
    } else {
      this.config = createDefaultConfig();
    }

    return this.config;
  }

  async save(config: AppConfig): Promise<void> {
    const configDirPath = getConfigDirPath();
    const configFilePath = getConfigFilePath();

    if (!existsSync(configDirPath)) {
      mkdirSync(configDirPath, { recursive: true });
    }

    const encryptedConfig = this.encryptConfig(config);
    writeFileSync(configFilePath, JSON.stringify(encryptedConfig, null, 2), 'utf-8');
    this.config = config;
    logger.success('Configuration saved successfully');
  }

  async get(): Promise<AppConfig> {
    if (!this.config) {
      return this.load();
    }
    return this.config;
  }

  async update(partial: Partial<AppConfig>): Promise<AppConfig> {
    const current = await this.get();
    const updated = { ...current, ...partial };
    await this.save(updated);
    return updated;
  }

  async reset(): Promise<void> {
    const configFilePath = getConfigFilePath();

    if (existsSync(configFilePath)) {
      const backupPath = `${configFilePath}.backup`;
      const currentContent = readFileSync(configFilePath, 'utf-8');
      writeFileSync(backupPath, currentContent, 'utf-8');
      logger.info(`Backup created at ${backupPath}`);
    }
    await this.save(createDefaultConfig());
    logger.success('Configuration reset to defaults');
  }

  private encryptConfig(config: AppConfig): AppConfig {
    const encrypted = this.normalizeConfig(config);
    if (encrypted.github.pat) {
      encrypted.github = { ...encrypted.github, pat: CryptoService.encrypt(encrypted.github.pat) };
    }
    if (encrypted.llm.apiKey) {
      encrypted.llm = { ...encrypted.llm, apiKey: CryptoService.encrypt(encrypted.llm.apiKey) };
    }
    return encrypted;
  }

  private decryptConfig(config: Partial<AppConfig>): AppConfig {
    const decrypted = this.normalizeConfig(config);
    if (decrypted.github.pat && CryptoService.isEncrypted(decrypted.github.pat)) {
      decrypted.github = { ...decrypted.github, pat: CryptoService.decrypt(decrypted.github.pat) };
    }
    if (decrypted.llm.apiKey && CryptoService.isEncrypted(decrypted.llm.apiKey)) {
      decrypted.llm = { ...decrypted.llm, apiKey: CryptoService.decrypt(decrypted.llm.apiKey) };
    }
    return decrypted;
  }

  getConfigPath(): string {
    return getConfigFilePath();
  }

  private normalizeConfig(config: Partial<AppConfig>): AppConfig {
    const defaults = createDefaultConfig();

    return {
      ...defaults,
      ...config,
      userProfile: {
        ...defaults.userProfile,
        ...config.userProfile,
      },
      github: {
        ...defaults.github,
        ...config.github,
      },
      llm: {
        ...defaults.llm,
        ...config.llm,
      },
      automation: {
        ...defaults.automation,
        ...config.automation,
      },
    };
  }
}

export const configService = new ConfigService();

import { configService, prompt, ui } from '../infra/index.js';
import { schedulerService } from '../services/index.js';
import type { AppConfig } from '../types/index.js';

export class ConfigOrchestrator {
  async view(): Promise<void> {
    const config = await configService.get();
    const missingRequired = [
      !config.github.username,
      !config.github.pat,
      !config.llm.apiKey,
    ].filter(Boolean).length;

    ui.hero({
      label: 'OpenMeta Config',
      title: 'See the machine state without digging through raw files',
      subtitle: 'Profile, credentials, defaults, and automation policy arranged into one readable control surface.',
      lines: [
        `Config path: ${configService.getConfigPath()}`,
        missingRequired === 0 ? 'Critical settings are present.' : `${missingRequired} critical setting group still needs attention.`,
      ],
      tone: missingRequired === 0 ? 'accent' : 'warning',
    });

    ui.stats('Status overview', [
      {
        label: 'GitHub',
        value: config.github.username && config.github.pat ? 'READY' : 'MISSING',
        tone: config.github.username && config.github.pat ? 'success' : 'warning',
      },
      {
        label: 'LLM',
        value: config.llm.apiKey ? 'READY' : 'MISSING',
        tone: config.llm.apiKey ? 'success' : 'warning',
      },
      {
        label: 'Automation',
        value: config.automation.enabled ? 'ENABLED' : 'DISABLED',
        tone: config.automation.enabled ? 'warning' : 'muted',
      },
      {
        label: 'Profile',
        value: `${config.userProfile.techStack.length} stack item(s)`,
        tone: config.userProfile.techStack.length > 0 ? 'info' : 'warning',
      },
    ]);

    ui.keyValues('User profile', [
      { label: 'Tech stack', value: config.userProfile.techStack.join(', ') || '(not set)', tone: config.userProfile.techStack.length > 0 ? 'info' : 'warning' },
      { label: 'Proficiency', value: config.userProfile.proficiency || '(not set)', tone: config.userProfile.proficiency ? 'info' : 'warning' },
      { label: 'Focus areas', value: config.userProfile.focusAreas.join(', ') || '(not set)', tone: config.userProfile.focusAreas.length > 0 ? 'info' : 'warning' },
    ]);

    ui.keyValues('GitHub', [
      { label: 'Username', value: config.github.username || '(not set)', tone: config.github.username ? 'info' : 'warning' },
      { label: 'PAT', value: ui.maskSecret(config.github.pat), tone: config.github.pat ? 'info' : 'warning' },
      { label: 'Target repo', value: config.github.targetRepoPath || 'Auto-managed private repository', tone: 'info' },
    ]);

    ui.keyValues('LLM', [
      { label: 'Provider', value: config.llm.provider || '(not set)', tone: config.llm.provider ? 'info' : 'warning' },
      { label: 'Base URL', value: config.llm.apiBaseUrl || '(not set)', tone: config.llm.apiBaseUrl ? 'info' : 'warning' },
      { label: 'Model', value: config.llm.modelName || '(not set)', tone: config.llm.modelName ? 'info' : 'warning' },
      { label: 'Extra headers', value: Object.keys(config.llm.apiHeaders || {}).length > 0 ? JSON.stringify(config.llm.apiHeaders) : '(none)', tone: 'info' },
      { label: 'API key', value: ui.maskSecret(config.llm.apiKey), tone: config.llm.apiKey ? 'info' : 'warning' },
    ]);

    ui.keyValues('Automation', [
      { label: 'Enabled', value: config.automation.enabled ? 'yes' : 'no', tone: config.automation.enabled ? 'warning' : 'muted' },
      { label: 'Schedule', value: `${config.automation.scheduleTime} (${config.automation.timezone})`, tone: 'info' },
      { label: 'Scheduler', value: config.automation.scheduler, tone: 'info' },
      { label: 'Content type', value: config.automation.contentType, tone: 'info' },
      { label: 'Min match score', value: String(config.automation.minMatchScore), tone: 'info' },
      { label: 'Skip if already generated today', value: config.automation.skipIfAlreadyGeneratedToday ? 'yes' : 'no', tone: 'info' },
    ]);

    ui.card({
      label: 'OpenMeta Config',
      title: 'Default commit template',
      subtitle: 'This template is used when OpenMeta publishes contribution artifacts.',
      lines: [config.commitTemplate],
      tone: 'muted',
    });

    if (missingRequired > 0) {
      ui.callout({
        label: 'OpenMeta Config',
        title: 'Configuration still needs attention',
        subtitle: 'Run "openmeta init" after updating credentials so validation can confirm your GitHub and LLM connections.',
        tone: 'warning',
      });
    }
  }

  async set(key: string, value: string): Promise<void> {
    const config = await configService.get();
    const validPaths = ['userProfile.techStack', 'userProfile.proficiency', 'userProfile.focusAreas',
                       'github.username', 'github.targetRepoPath', 'llm.provider', 'llm.apiBaseUrl', 'llm.modelName',
                       'automation.enabled', 'automation.scheduleTime', 'automation.contentType',
                       'automation.minMatchScore', 'automation.skipIfAlreadyGeneratedToday',
                       'commitTemplate'];

    if (!validPaths.includes(key)) {
      ui.callout({
        label: 'OpenMeta Config',
        title: 'Unknown configuration key',
        subtitle: `OpenMeta does not recognize "${key}". Use one of the supported dotted paths below.`,
        lines: validPaths,
        tone: 'warning',
      });
      return;
    }

    let updated: AppConfig;

    if (key === 'userProfile.techStack') {
      updated = await configService.update({
        userProfile: { ...config.userProfile, techStack: value.split(',').map(s => s.trim()).filter(Boolean) }
      });
    } else if (key === 'userProfile.focusAreas') {
      updated = await configService.update({
        userProfile: { ...config.userProfile, focusAreas: value.split(',').map(s => s.trim()).filter(Boolean) }
      });
    } else if (key === 'userProfile.proficiency') {
      updated = await configService.update({
        userProfile: { ...config.userProfile, proficiency: value as 'beginner' | 'intermediate' | 'advanced' }
      });
    } else if (key === 'github.username') {
      updated = await configService.update({ github: { ...config.github, username: value } });
    } else if (key === 'github.targetRepoPath') {
      updated = await configService.update({ github: { ...config.github, targetRepoPath: value } });
    } else if (key === 'llm.provider') {
      if (!['openai', 'minimax', 'moonshot', 'zhipu', 'custom'].includes(value)) {
        throw new Error('llm.provider must be "openai", "minimax", "moonshot", "zhipu", or "custom".');
      }
      updated = await configService.update({ llm: { ...config.llm, provider: value as AppConfig['llm']['provider'] } });
    } else if (key === 'llm.apiBaseUrl') {
      updated = await configService.update({ llm: { ...config.llm, apiBaseUrl: value } });
    } else if (key === 'llm.modelName') {
      updated = await configService.update({ llm: { ...config.llm, modelName: value } });
    } else if (key === 'automation.enabled') {
      updated = await configService.update({
        automation: {
          ...config.automation,
          enabled: this.parseBoolean(value, key),
        },
      });
    } else if (key === 'automation.scheduleTime') {
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
        throw new Error('automation.scheduleTime must use HH:mm format.');
      }
      updated = await configService.update({
        automation: {
          ...config.automation,
          scheduleTime: value,
        },
      });
    } else if (key === 'automation.contentType') {
      if (value !== 'research_note' && value !== 'development_diary') {
        throw new Error('automation.contentType must be "research_note" or "development_diary".');
      }
      updated = await configService.update({
        automation: {
          ...config.automation,
          contentType: value,
        },
      });
    } else if (key === 'automation.minMatchScore') {
      const minMatchScore = Number.parseInt(value, 10);
      if (Number.isNaN(minMatchScore) || minMatchScore < 0 || minMatchScore > 100) {
        throw new Error('automation.minMatchScore must be an integer between 0 and 100.');
      }
      updated = await configService.update({
        automation: {
          ...config.automation,
          minMatchScore,
        },
      });
    } else if (key === 'automation.skipIfAlreadyGeneratedToday') {
      updated = await configService.update({
        automation: {
          ...config.automation,
          skipIfAlreadyGeneratedToday: this.parseBoolean(value, key),
        },
      });
    } else if (key === 'commitTemplate') {
      updated = await configService.update({ commitTemplate: value });
    } else {
      return;
    }

    let schedulerDetail = 'Scheduler state unchanged.';
    let resultTone: 'success' | 'warning' = 'success';

    if (key.startsWith('automation.')) {
      const syncResult = await schedulerService.sync(updated);
      schedulerDetail = syncResult.detail;
      resultTone = syncResult.status === 'failed' ? 'warning' : 'success';
    }

    ui.card({
      label: 'OpenMeta Config',
      title: 'The setting change has been sealed',
      subtitle: 'Local configuration accepted the update without friction.',
      lines: [
        `Key: ${key}`,
        `Value: ${this.describeUpdatedValue(key, updated)}`,
        `Config path: ${configService.getConfigPath()}`,
        `Scheduler: ${schedulerDetail}`,
      ],
      tone: resultTone,
    });
  }

  async reset(): Promise<void> {
    ui.callout({
      label: 'OpenMeta Config',
      title: 'Reset local configuration',
      subtitle: 'This restores defaults for GitHub, LLM, profile, and automation settings stored by OpenMeta.',
      lines: [
        `Config file: ${configService.getConfigPath()}`,
        'You will need to run "openmeta init" again before using authenticated workflows.',
      ],
      tone: 'warning',
    });

    const { confirm } = await prompt<{ confirm: boolean }>([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to reset all configuration to defaults?',
        default: false,
      },
    ]);

    if (confirm) {
      await configService.reset();
      ui.banner({
        label: 'OpenMeta Config',
        title: 'The control surface returned to a clean slate',
        subtitle: 'Local settings have been rolled back to their defaults.',
        lines: [`Config file: ${configService.getConfigPath()}`],
        tone: 'success',
      });
    } else {
      ui.callout({
        label: 'OpenMeta Config',
        title: 'Reset cancelled',
        subtitle: 'Existing configuration remains unchanged.',
        tone: 'info',
      });
    }
  }

  private parseBoolean(value: string, key: string): boolean {
    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }

    throw new Error(`${key} must be a boolean value.`);
  }

  private describeUpdatedValue(key: string, config: AppConfig): string {
    switch (key) {
      case 'userProfile.techStack':
        return config.userProfile.techStack.join(', ') || '(not set)';
      case 'userProfile.proficiency':
        return config.userProfile.proficiency;
      case 'userProfile.focusAreas':
        return config.userProfile.focusAreas.join(', ') || '(not set)';
      case 'github.username':
        return config.github.username || '(not set)';
      case 'github.targetRepoPath':
        return config.github.targetRepoPath || 'Auto-managed private repository';
      case 'llm.provider':
        return config.llm.provider;
      case 'llm.apiBaseUrl':
        return config.llm.apiBaseUrl;
      case 'llm.modelName':
        return config.llm.modelName;
      case 'automation.enabled':
        return config.automation.enabled ? 'yes' : 'no';
      case 'automation.scheduleTime':
        return config.automation.scheduleTime;
      case 'automation.contentType':
        return config.automation.contentType;
      case 'automation.minMatchScore':
        return String(config.automation.minMatchScore);
      case 'automation.skipIfAlreadyGeneratedToday':
        return config.automation.skipIfAlreadyGeneratedToday ? 'yes' : 'no';
      case 'commitTemplate':
        return config.commitTemplate;
      default:
        return '(updated)';
    }
  }
}

export const configOrchestrator = new ConfigOrchestrator();

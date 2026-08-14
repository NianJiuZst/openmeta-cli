import { existsSync, readFileSync, writeFileSync } from 'fs';
import { configService, parseLLMReasoningEffort, prompt, selectPrompt, ui } from '../infra/index.js';
import {
  getPreset,
  normalizeOverallWeights,
  normalizeWeights,
  repositoryTargetingService,
  SCORING_PRESETS,
  schedulerService,
} from '../services/index.js';
import type { AppConfig, LLMProviderProfile, OverallWeights, ScoringWeights } from '../types/index.js';

export class ConfigOrchestrator {
  async setMachineValue(
    key: string,
    value: string,
  ): Promise<{
    updatedKey: string;
    appliedValue: string;
    snapshot: Awaited<ReturnType<ConfigOrchestrator['getMachineSnapshot']>>;
    scheduler: {
      status: 'unchanged' | 'synced' | 'failed';
      detail: string;
    };
  }> {
    const updated = await this.applyConfigValue(key, value);
    const syncResult = key.startsWith('automation.') ? await schedulerService.sync(updated) : null;

    return {
      updatedKey: key,
      appliedValue: this.describeUpdatedValue(key, updated),
      snapshot: await this.getMachineSnapshot(),
      scheduler: syncResult
        ? {
            status: syncResult.status === 'failed' ? 'failed' : 'synced',
            detail: syncResult.detail,
          }
        : {
            status: 'unchanged',
            detail: 'Scheduler state unchanged.',
          },
    };
  }

  async getMachineSnapshot(): Promise<{
    userProfile: AppConfig['userProfile'];
    github: { username: string; pat: string; targetRepoPath?: string };
    repositoryTargeting: AppConfig['repositoryTargeting'];
    llm: {
      provider: AppConfig['llm']['provider'];
      apiBaseUrl: string;
      apiKey: string;
      modelName: string;
      apiHeaders: Record<string, string>;
      reasoningEffort?: AppConfig['llm']['reasoningEffort'];
      stream?: boolean;
      activeProfile?: string;
      savedProfiles: string[];
    };
    automation: AppConfig['automation'];
    scoring: AppConfig['scoring'];
    commitTemplate: string;
  }> {
    const config = await configService.get();

    return {
      userProfile: config.userProfile,
      github: {
        username: config.github.username,
        pat: ui.maskSecret(config.github.pat),
        targetRepoPath: config.github.targetRepoPath,
      },
      repositoryTargeting: config.repositoryTargeting,
      llm: {
        provider: config.llm.provider,
        apiBaseUrl: config.llm.apiBaseUrl,
        apiKey: ui.maskSecret(config.llm.apiKey),
        modelName: config.llm.modelName,
        apiHeaders: config.llm.apiHeaders ?? {},
        reasoningEffort: config.llm.reasoningEffort,
        stream: config.llm.stream,
        activeProfile: config.llm.activeProfile,
        savedProfiles: Object.keys(config.llm.profiles ?? {}).sort(),
      },
      automation: config.automation,
      scoring: config.scoring,
      commitTemplate: config.commitTemplate,
    };
  }

  async view(): Promise<void> {
    const config = await configService.get();
    const missingRequired = [!config.github.username, !config.github.pat, !config.llm.apiKey].filter(Boolean).length;

    ui.hero({
      label: 'OpenMeta Config',
      title: 'See the machine state without digging through raw files',
      subtitle: 'Profile, credentials, defaults, and automation policy arranged into one readable control surface.',
      lines: [
        `Config path: ${configService.getConfigPath()}`,
        missingRequired === 0
          ? 'Critical settings are present.'
          : `${missingRequired} critical setting group${missingRequired === 1 ? '' : 's'} still need attention.`,
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
      {
        label: 'Tech stack',
        value: config.userProfile.techStack.join(', ') || '(not set)',
        tone: config.userProfile.techStack.length > 0 ? 'info' : 'warning',
      },
      {
        label: 'Proficiency',
        value: config.userProfile.proficiency || '(not set)',
        tone: config.userProfile.proficiency ? 'info' : 'warning',
      },
      {
        label: 'Focus areas',
        value: config.userProfile.focusAreas.join(', ') || '(not set)',
        tone: config.userProfile.focusAreas.length > 0 ? 'info' : 'warning',
      },
    ]);

    ui.keyValues('GitHub', [
      {
        label: 'Username',
        value: config.github.username || '(not set)',
        tone: config.github.username ? 'info' : 'warning',
      },
      { label: 'PAT', value: ui.maskSecret(config.github.pat), tone: config.github.pat ? 'info' : 'warning' },
      {
        label: 'Artifact repo',
        value: config.github.targetRepoPath || 'Auto-managed private repository',
        tone: 'info',
      },
    ]);

    ui.keyValues('Repository targeting', [
      {
        label: 'Active preset',
        value: config.repositoryTargeting.activePreset || '(none)',
        tone: config.repositoryTargeting.activePreset ? 'success' : 'muted',
      },
      {
        label: 'Saved presets',
        value: String(Object.keys(config.repositoryTargeting.presets || {}).length),
        tone: Object.keys(config.repositoryTargeting.presets || {}).length > 0 ? 'info' : 'muted',
      },
      {
        label: 'Active repos',
        value: repositoryTargetingService.getActiveRepos(config).join(', ') || '(none)',
        tone: repositoryTargetingService.getActiveRepos(config).length > 0 ? 'info' : 'muted',
      },
    ]);

    ui.keyValues('LLM', [
      {
        label: 'Active profile',
        value: config.llm.activeProfile || '(none)',
        tone: config.llm.activeProfile ? 'success' : 'muted',
      },
      { label: 'Provider', value: config.llm.provider || '(not set)', tone: config.llm.provider ? 'info' : 'warning' },
      {
        label: 'Base URL',
        value: config.llm.apiBaseUrl || '(not set)',
        tone: config.llm.apiBaseUrl ? 'info' : 'warning',
      },
      { label: 'Model', value: config.llm.modelName || '(not set)', tone: config.llm.modelName ? 'info' : 'warning' },
      { label: 'Reasoning effort', value: config.llm.reasoningEffort || 'none', tone: 'info' },
      { label: 'Streaming', value: config.llm.stream ? 'yes' : 'no', tone: config.llm.stream ? 'info' : 'muted' },
      {
        label: 'Extra headers',
        value: Object.keys(config.llm.apiHeaders || {}).length > 0 ? JSON.stringify(config.llm.apiHeaders) : '(none)',
        tone: 'info',
      },
      { label: 'API key', value: ui.maskSecret(config.llm.apiKey), tone: config.llm.apiKey ? 'info' : 'warning' },
      {
        label: 'Saved profiles',
        value: String(Object.keys(config.llm.profiles || {}).length),
        tone: Object.keys(config.llm.profiles || {}).length > 0 ? 'info' : 'muted',
      },
    ]);

    ui.keyValues('Automation', [
      {
        label: 'Enabled',
        value: config.automation.enabled ? 'yes' : 'no',
        tone: config.automation.enabled ? 'warning' : 'muted',
      },
      { label: 'Schedule', value: `${config.automation.scheduleTime} (${config.automation.timezone})`, tone: 'info' },
      { label: 'Scheduler', value: config.automation.scheduler, tone: 'info' },
      { label: 'Content type', value: config.automation.contentType, tone: 'info' },
      { label: 'Min match score', value: String(config.automation.minMatchScore), tone: 'info' },
      {
        label: 'Skip if already generated today',
        value: config.automation.skipIfAlreadyGeneratedToday ? 'yes' : 'no',
        tone: 'info',
      },
    ]);

    ui.card({
      label: 'OpenMeta Config',
      title: 'Default commit template',
      subtitle: 'This template is used when OpenMeta publishes contribution artifacts.',
      lines: [config.commitTemplate],
      tone: 'muted',
    });

    const sw = config.scoring.weights;
    const ow = config.scoring.overallWeights;
    ui.keyValues('Scoring weights', [
      {
        label: 'Active preset',
        value: config.scoring.preset || 'custom',
        tone: config.scoring.preset ? 'success' : 'muted',
      },
      { label: 'Freshness', value: `${(sw.freshness * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Onboarding Clarity', value: `${(sw.onboardingClarity * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Merge Potential', value: `${(sw.mergePotential * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Impact', value: `${(sw.impact * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Risk Penalty', value: `${(sw.riskPenalty * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Technical Match', value: `${(ow.technicalMatch * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Opportunity Score', value: `${(ow.opportunityScore * 100).toFixed(0)}%`, tone: 'info' },
    ]);

    if (missingRequired > 0) {
      ui.callout({
        label: 'OpenMeta Config',
        title: 'Configuration still needs attention',
        subtitle:
          'Run "openmeta init" after updating credentials so validation can confirm your GitHub and LLM connections.',
        tone: 'warning',
      });
    }
  }

  async set(key: string, value: string): Promise<void> {
    const updated = await this.applyConfigValue(key, value);

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

  async scoring(): Promise<void> {
    const config = await configService.get();

    ui.hero({
      label: 'OpenMeta Scoring',
      title: 'Tune the scoring weights to match your contribution style',
      subtitle: 'Choose a preset or customize individual weights. Higher weight = more influence on the final ranking.',
      tone: 'accent',
    });

    const presetChoices = [
      ...SCORING_PRESETS.map((p) => ({
        name: `${p.label} — ${p.description}`,
        value: p.name,
      })),
      { name: 'Custom — Adjust weights manually', value: 'custom' },
    ];

    const selectedPreset = await selectPrompt<string>({
      message: 'Select a scoring preset',
      choices: presetChoices,
      default: config.scoring.preset || 'balanced',
    });

    let newWeights: ScoringWeights;
    let newOverallWeights: OverallWeights;

    if (selectedPreset !== 'custom') {
      const preset = getPreset(selectedPreset)!;
      newWeights = { ...preset.weights };
      newOverallWeights = { ...preset.overallWeights };
    } else {
      ui.section(
        'Custom weights',
        'Enter a value between 0 and 100 for each dimension. They will be normalized automatically.',
      );

      const current = config.scoring.weights;
      const entries: Array<{ key: keyof ScoringWeights; label: string; default: number }> = [
        {
          key: 'freshness',
          label: 'Freshness (newer issues rank higher)',
          default: Math.round(current.freshness * 100),
        },
        {
          key: 'onboardingClarity',
          label: 'Onboarding Clarity (clear descriptions, good-first-issue)',
          default: Math.round(current.onboardingClarity * 100),
        },
        {
          key: 'mergePotential',
          label: 'Merge Potential (likely to be accepted)',
          default: Math.round(current.mergePotential * 100),
        },
        { key: 'impact', label: 'Impact (repo stars and visibility)', default: Math.round(current.impact * 100) },
        {
          key: 'riskPenalty',
          label: 'Risk Penalty (reduce score for risky issues)',
          default: Math.round(current.riskPenalty * 100),
        },
      ];

      const rawWeights: Record<string, number> = {};
      for (const entry of entries) {
        const result = await prompt<{ value: string }>([
          {
            type: 'input',
            name: 'value',
            message: `${entry.label} (0-100)`,
            default: String(entry.default),
          },
        ]);
        const num = Number.parseFloat(result.value);
        if (Number.isNaN(num) || num < 0 || num > 100) {
          throw new Error('Weight must be a number between 0 and 100.');
        }
        rawWeights[entry.key] = num / 100;
      }

      newWeights = normalizeWeights(rawWeights as unknown as ScoringWeights);

      const owCurrent = config.scoring.overallWeights;
      ui.section('Overall weights', 'Adjust the balance between technical match and opportunity score.');

      const owEntries: Array<{ key: keyof OverallWeights; label: string; default: number }> = [
        {
          key: 'technicalMatch',
          label: 'Technical Match (your stack vs issue)',
          default: Math.round(owCurrent.technicalMatch * 100),
        },
        {
          key: 'opportunityScore',
          label: 'Opportunity Score (freshness, impact, clarity)',
          default: Math.round(owCurrent.opportunityScore * 100),
        },
      ];

      const rawOverall: Record<string, number> = {};
      for (const entry of owEntries) {
        const result = await prompt<{ value: string }>([
          {
            type: 'input',
            name: 'value',
            message: `${entry.label} (0-100)`,
            default: String(entry.default),
          },
        ]);
        const num = Number.parseFloat(result.value);
        if (Number.isNaN(num) || num < 0 || num > 100) {
          throw new Error('Weight must be a number between 0 and 100.');
        }
        rawOverall[entry.key] = num / 100;
      }

      newOverallWeights = normalizeOverallWeights(rawOverall as unknown as OverallWeights);
    }

    ui.keyValues('Preview — Scoring weights', [
      { label: 'Preset', value: selectedPreset === 'custom' ? 'custom' : selectedPreset, tone: 'success' },
      { label: 'Freshness', value: `${(newWeights.freshness * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Onboarding Clarity', value: `${(newWeights.onboardingClarity * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Merge Potential', value: `${(newWeights.mergePotential * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Impact', value: `${(newWeights.impact * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Risk Penalty', value: `${(newWeights.riskPenalty * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Technical Match', value: `${(newOverallWeights.technicalMatch * 100).toFixed(0)}%`, tone: 'info' },
      { label: 'Opportunity Score', value: `${(newOverallWeights.opportunityScore * 100).toFixed(0)}%`, tone: 'info' },
    ]);

    const { confirm } = await prompt<{ confirm: boolean }>([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Save these scoring weights?',
        default: true,
      },
    ]);

    if (confirm) {
      const presetName = selectedPreset === 'custom' ? 'custom' : selectedPreset;
      await configService.update({
        scoring: { weights: newWeights, overallWeights: newOverallWeights, preset: presetName },
      });
      ui.banner({
        label: 'OpenMeta Scoring',
        title: 'Scoring weights updated',
        subtitle: `Preset: ${presetName}. The new weights will be used in the next scout/agent run.`,
        lines: [`Config: ${configService.getConfigPath()}`],
        tone: 'success',
      });
    } else {
      ui.callout({
        label: 'OpenMeta Scoring',
        title: 'Changes discarded',
        subtitle: 'Scoring weights remain unchanged.',
        tone: 'info',
      });
    }
  }

  async exportConfig(outputPath: string, options: { includeSecrets?: boolean } = {}): Promise<void> {
    const config = await configService.get();

    const exported: Record<string, unknown> = {
      userProfile: config.userProfile,
      github: {
        username: config.github.username,
        pat: options.includeSecrets ? config.github.pat : '<REDACTED>',
        targetRepoPath: config.github.targetRepoPath,
      },
      repositoryTargeting: config.repositoryTargeting,
      llm: {
        provider: config.llm.provider,
        apiBaseUrl: config.llm.apiBaseUrl,
        apiKey: options.includeSecrets ? config.llm.apiKey : '<REDACTED>',
        modelName: config.llm.modelName,
        apiHeaders: config.llm.apiHeaders ?? {},
        reasoningEffort: config.llm.reasoningEffort,
        stream: config.llm.stream,
        activeProfile: config.llm.activeProfile,
        profiles: options.includeSecrets ? config.llm.profiles : this.redactProfileSecrets(config.llm.profiles ?? {}),
      },
      automation: config.automation,
      scoring: config.scoring,
      commitTemplate: config.commitTemplate,
    };

    const content = JSON.stringify(exported, null, 2);
    writeFileSync(outputPath, content, 'utf-8');

    ui.card({
      label: 'OpenMeta Config',
      title: 'Configuration exported',
      subtitle: options.includeSecrets
        ? 'Secrets are included in plaintext. Keep this file safe.'
        : 'Secrets have been redacted. Use --include-secrets to include credentials.',
      lines: [`Output: ${outputPath}`],
      tone: options.includeSecrets ? 'warning' : 'success',
    });
  }

  async importConfig(inputPath: string): Promise<void> {
    if (!existsSync(inputPath)) {
      throw new Error(`File not found: ${inputPath}`);
    }

    let parsed: Record<string, unknown>;
    try {
      const content = readFileSync(inputPath, 'utf-8');
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Failed to parse config file: ${error instanceof Error ? error.message : String(error)}`);
    }

    const current = await configService.get();
    const partial: Record<string, unknown> = {};

    if (parsed['userProfile'] && typeof parsed['userProfile'] === 'object') {
      partial['userProfile'] = parsed['userProfile'];
    }

    if (parsed['github'] && typeof parsed['github'] === 'object') {
      const gh = parsed['github'] as Record<string, unknown>;
      partial['github'] = {
        ...current.github,
        ...(gh['username'] && gh['username'] !== '<REDACTED>' ? { username: gh['username'] } : {}),
        ...(gh['pat'] && gh['pat'] !== '<REDACTED>' ? { pat: gh['pat'] } : {}),
        ...(gh['targetRepoPath'] !== undefined ? { targetRepoPath: gh['targetRepoPath'] } : {}),
      };
    }

    if (parsed['repositoryTargeting'] && typeof parsed['repositoryTargeting'] === 'object') {
      partial['repositoryTargeting'] = parsed['repositoryTargeting'];
    }

    if (parsed['llm'] && typeof parsed['llm'] === 'object') {
      const llm = parsed['llm'] as Record<string, unknown>;
      partial['llm'] = {
        ...current.llm,
        ...(llm['provider'] !== undefined ? { provider: llm['provider'] } : {}),
        ...(llm['apiBaseUrl'] !== undefined ? { apiBaseUrl: llm['apiBaseUrl'] } : {}),
        ...(llm['apiKey'] && llm['apiKey'] !== '<REDACTED>' ? { apiKey: llm['apiKey'] } : {}),
        ...(llm['modelName'] !== undefined ? { modelName: llm['modelName'] } : {}),
        ...(llm['apiHeaders'] !== undefined ? { apiHeaders: llm['apiHeaders'] } : {}),
        ...(llm['reasoningEffort'] !== undefined ? { reasoningEffort: llm['reasoningEffort'] } : {}),
        ...(llm['stream'] !== undefined ? { stream: llm['stream'] } : {}),
        ...(llm['activeProfile'] !== undefined ? { activeProfile: llm['activeProfile'] } : {}),
        ...(llm['profiles'] !== undefined
          ? {
              profiles: this.restoreProfileSecrets(
                llm['profiles'] as Record<string, unknown>,
                current.llm.profiles ?? {},
              ),
            }
          : {}),
      };
    }

    if (parsed['automation'] && typeof parsed['automation'] === 'object') {
      partial['automation'] = parsed['automation'];
    }

    if (parsed['scoring'] && typeof parsed['scoring'] === 'object') {
      partial['scoring'] = parsed['scoring'];
    }

    if (parsed['commitTemplate'] && typeof parsed['commitTemplate'] === 'string') {
      partial['commitTemplate'] = parsed['commitTemplate'];
    }

    await configService.update(partial as Partial<typeof current>);

    ui.card({
      label: 'OpenMeta Config',
      title: 'Configuration imported',
      subtitle:
        'Settings have been merged into the local configuration. Redacted secrets were preserved from the existing config.',
      lines: [`Source: ${inputPath}`, `Config: ${configService.getConfigPath()}`],
      tone: 'success',
    });
  }

  private redactProfileSecrets(profiles: Record<string, LLMProviderProfile>): Record<string, LLMProviderProfile> {
    return Object.fromEntries(
      Object.entries(profiles).map(([name, profile]) => [name, { ...profile, apiKey: '<REDACTED>' }]),
    );
  }

  private restoreProfileSecrets(
    imported: Record<string, unknown>,
    existing: Record<string, LLMProviderProfile>,
  ): Record<string, LLMProviderProfile> {
    return Object.fromEntries(
      Object.entries(imported).map(([name, profile]) => {
        const p = profile as LLMProviderProfile;
        const existingProfile = existing[name];
        if (p.apiKey === '<REDACTED>' && existingProfile?.apiKey) {
          return [name, { ...p, apiKey: existingProfile.apiKey }];
        }
        return [name, p];
      }),
    );
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

  private parseRequiredSecret(value: string, key: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(`${key} cannot be empty.`);
    }
    return trimmed;
  }

  private parseNumberInRange(
    value: string,
    options: { key: string; min: number; max: number; integer?: boolean },
  ): number {
    const normalized = value.trim();
    const parsed = normalized ? Number(normalized) : Number.NaN;
    const expectedType = options.integer ? 'an integer' : 'a number';

    if (
      !Number.isFinite(parsed) ||
      (options.integer && !Number.isInteger(parsed)) ||
      parsed < options.min ||
      parsed > options.max
    ) {
      throw new Error(`${options.key} must be ${expectedType} between ${options.min} and ${options.max}.`);
    }

    return parsed;
  }

  private async applyConfigValue(key: string, value: string): Promise<AppConfig> {
    const config = await configService.get();
    const validPaths = [
      'userProfile.techStack',
      'userProfile.proficiency',
      'userProfile.focusAreas',
      'github.username',
      'github.pat',
      'github.targetRepoPath',
      'llm.provider',
      'llm.apiBaseUrl',
      'llm.apiKey',
      'llm.modelName',
      'llm.reasoningEffort',
      'llm.stream',
      'automation.enabled',
      'automation.scheduleTime',
      'automation.contentType',
      'automation.minMatchScore',
      'automation.skipIfAlreadyGeneratedToday',
      'scoring.weights.freshness',
      'scoring.weights.onboardingClarity',
      'scoring.weights.mergePotential',
      'scoring.weights.impact',
      'scoring.weights.riskPenalty',
      'scoring.overallWeights.technicalMatch',
      'scoring.overallWeights.opportunityScore',
      'scoring.preset',
      'commitTemplate',
    ];

    if (!validPaths.includes(key)) {
      throw new Error(`Unknown configuration key "${key}".`);
    }

    if (key === 'userProfile.techStack') {
      return configService.update({
        userProfile: {
          ...config.userProfile,
          techStack: value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        },
      });
    }

    if (key === 'userProfile.focusAreas') {
      return configService.update({
        userProfile: {
          ...config.userProfile,
          focusAreas: value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        },
      });
    }

    if (key === 'userProfile.proficiency') {
      const proficiency = value.trim();
      if (!['beginner', 'intermediate', 'advanced'].includes(proficiency)) {
        throw new Error('userProfile.proficiency must be "beginner", "intermediate", or "advanced".');
      }
      return configService.update({
        userProfile: {
          ...config.userProfile,
          proficiency: proficiency as AppConfig['userProfile']['proficiency'],
        },
      });
    }

    if (key === 'github.username') {
      return configService.update({ github: { ...config.github, username: value } });
    }

    if (key === 'github.pat') {
      return configService.update({ github: { ...config.github, pat: this.parseRequiredSecret(value, key) } });
    }

    if (key === 'github.targetRepoPath') {
      return configService.update({ github: { ...config.github, targetRepoPath: value } });
    }

    if (key === 'llm.provider') {
      if (!['openai', 'minimax', 'moonshot', 'zhipu', 'gemini', 'claude', 'custom'].includes(value)) {
        throw new Error(
          'llm.provider must be "openai", "minimax", "moonshot", "zhipu", "gemini", "claude", or "custom".',
        );
      }
      return configService.update({ llm: { ...config.llm, provider: value as AppConfig['llm']['provider'] } });
    }

    if (key === 'llm.apiBaseUrl') {
      return configService.update({ llm: { ...config.llm, apiBaseUrl: value } });
    }

    if (key === 'llm.apiKey') {
      return configService.update({ llm: { ...config.llm, apiKey: this.parseRequiredSecret(value, key) } });
    }

    if (key === 'llm.modelName') {
      return configService.update({ llm: { ...config.llm, modelName: value } });
    }

    if (key === 'llm.reasoningEffort') {
      return configService.update({ llm: { ...config.llm, reasoningEffort: parseLLMReasoningEffort(value) } });
    }

    if (key === 'llm.stream') {
      return configService.update({ llm: { ...config.llm, stream: this.parseBoolean(value, key) } });
    }

    if (key === 'automation.enabled') {
      return configService.update({
        automation: {
          ...config.automation,
          enabled: this.parseBoolean(value, key),
        },
      });
    }

    if (key === 'automation.scheduleTime') {
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
        throw new Error('automation.scheduleTime must use HH:mm format.');
      }
      return configService.update({
        automation: {
          ...config.automation,
          scheduleTime: value,
        },
      });
    }

    if (key === 'automation.contentType') {
      if (value !== 'research_note' && value !== 'development_diary') {
        throw new Error('automation.contentType must be "research_note" or "development_diary".');
      }
      return configService.update({
        automation: {
          ...config.automation,
          contentType: value,
        },
      });
    }

    if (key === 'automation.minMatchScore') {
      const minMatchScore = this.parseNumberInRange(value, { key, min: 0, max: 100, integer: true });
      return configService.update({
        automation: {
          ...config.automation,
          minMatchScore,
        },
      });
    }

    if (key === 'automation.skipIfAlreadyGeneratedToday') {
      return configService.update({
        automation: {
          ...config.automation,
          skipIfAlreadyGeneratedToday: this.parseBoolean(value, key),
        },
      });
    }

    if (key.startsWith('scoring.weights.')) {
      const weightKey = key.replace('scoring.weights.', '') as keyof ScoringWeights;
      const numValue = this.parseNumberInRange(value, { key, min: 0, max: 1 });
      const newWeights = normalizeWeights({ ...config.scoring.weights, [weightKey]: numValue });
      return configService.update({
        scoring: { ...config.scoring, weights: newWeights, preset: 'custom' },
      });
    }

    if (key.startsWith('scoring.overallWeights.')) {
      const weightKey = key.replace('scoring.overallWeights.', '') as keyof OverallWeights;
      const numValue = this.parseNumberInRange(value, { key, min: 0, max: 1 });
      const newWeights = normalizeOverallWeights({ ...config.scoring.overallWeights, [weightKey]: numValue });
      return configService.update({
        scoring: { ...config.scoring, overallWeights: newWeights, preset: 'custom' },
      });
    }

    if (key === 'scoring.preset') {
      const preset = getPreset(value);
      if (!preset) {
        throw new Error(
          `Unknown scoring preset "${value}". Available: ${SCORING_PRESETS.map((p) => p.name).join(', ')}`,
        );
      }
      return configService.update({
        scoring: { weights: preset.weights, overallWeights: preset.overallWeights, preset: preset.name },
      });
    }

    if (key === 'commitTemplate') {
      return configService.update({ commitTemplate: value });
    }

    throw new Error(`Unknown configuration key "${key}".`);
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
      case 'github.pat':
        return ui.maskSecret(config.github.pat);
      case 'github.targetRepoPath':
        return config.github.targetRepoPath || 'Auto-managed private repository';
      case 'llm.provider':
        return config.llm.provider;
      case 'llm.apiBaseUrl':
        return config.llm.apiBaseUrl;
      case 'llm.apiKey':
        return ui.maskSecret(config.llm.apiKey);
      case 'llm.modelName':
        return config.llm.modelName;
      case 'llm.reasoningEffort':
        return config.llm.reasoningEffort || 'none';
      case 'llm.stream':
        return config.llm.stream ? 'yes' : 'no';
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
      case 'scoring.preset':
        return config.scoring.preset;
      case 'commitTemplate':
        return config.commitTemplate;
      default:
        if (key.startsWith('scoring.')) {
          return '(updated)';
        }
        return '(updated)';
    }
  }
}

export const configOrchestrator = new ConfigOrchestrator();

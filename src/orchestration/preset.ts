import { configService, ui } from '../infra/index.js';
import { repositoryTargetingService } from '../services/index.js';

interface PresetAddOptions {
  repo?: string[];
  activate?: boolean;
}

export class PresetOrchestrator {
  async list(): Promise<void> {
    const config = await configService.get();
    const presets = config.repositoryTargeting.presets || {};
    const names = Object.keys(presets).sort();

    ui.hero({
      label: 'OpenMeta Preset',
      title: names.length > 0 ? 'Saved repository presets are ready to reuse' : 'No repository presets saved yet',
      subtitle: 'Repository presets let you reuse fixed exploration targets across scout, analyze, and agent runs.',
      lines: [`Active preset: ${config.repositoryTargeting.activePreset || '(none)'}`],
      tone: names.length > 0 ? 'accent' : 'warning',
    });

    if (names.length === 0) {
      ui.emptyState(
        'OpenMeta Preset',
        'No presets found',
        'Run "openmeta preset add <name> --repo <owner/name>" to create a reusable repository target set.',
      );
      return;
    }

    ui.recordList(
      'Repository presets',
      names.map((name) => ({
        title: name,
        subtitle: `${presets[name]?.repos.length || 0} repository target(s)`,
        meta: [config.repositoryTargeting.activePreset === name ? 'active' : 'saved'],
        lines: (presets[name]?.repos || []).map((repo) => `- ${repo}`),
        tone: config.repositoryTargeting.activePreset === name ? 'success' : 'info',
      })),
    );
  }

  async add(nameInput: string, options: PresetAddOptions): Promise<void> {
    const name = repositoryTargetingService.normalizePresetName(nameInput);
    const config = await configService.get();
    const repos = repositoryTargetingService.normalizeRepos(options.repo || []);

    const updated = await configService.update({
      repositoryTargeting: {
        activePreset: options.activate ? name : config.repositoryTargeting.activePreset,
        presets: {
          ...(config.repositoryTargeting.presets || {}),
          [name]: { repos },
        },
      },
    });

    ui.card({
      label: 'OpenMeta Preset',
      title: 'Repository preset saved',
      subtitle: options.activate
        ? 'This preset is now the active exploration target set.'
        : 'Switch to it later with "openmeta preset use <name>".',
      lines: [
        `Preset: ${name}`,
        `Repositories: ${repos.join(', ')}`,
        `Active preset: ${updated.repositoryTargeting.activePreset || '(none)'}`,
      ],
      tone: 'success',
    });
  }

  async use(nameInput: string): Promise<void> {
    const name = repositoryTargetingService.normalizePresetName(nameInput);
    const config = await configService.get();
    const preset = config.repositoryTargeting.presets?.[name];
    if (!preset) {
      throw new Error(`Repository preset "${name}" does not exist. Run "openmeta preset list" to see saved presets.`);
    }

    await configService.update({
      repositoryTargeting: {
        ...config.repositoryTargeting,
        activePreset: name,
      },
    });

    ui.card({
      label: 'OpenMeta Preset',
      title: 'Active repository preset switched',
      subtitle: 'OpenMeta will use this preset by default unless a command overrides the target scope.',
      lines: [`Preset: ${name}`, `Repositories: ${preset.repos.join(', ')}`],
      tone: 'success',
    });
  }

  async remove(nameInput: string): Promise<void> {
    const name = repositoryTargetingService.normalizePresetName(nameInput);
    const config = await configService.get();
    const presets = { ...(config.repositoryTargeting.presets || {}) };
    if (!presets[name]) {
      throw new Error(`Repository preset "${name}" does not exist.`);
    }

    delete presets[name];
    const activePreset =
      config.repositoryTargeting.activePreset === name ? '' : config.repositoryTargeting.activePreset;
    await configService.update({
      repositoryTargeting: {
        activePreset,
        presets,
      },
    });

    ui.card({
      label: 'OpenMeta Preset',
      title: 'Repository preset removed',
      subtitle: activePreset
        ? 'The active preset remained unchanged.'
        : 'The removed preset was active, so no preset is now marked active.',
      lines: [`Preset: ${name}`, `Active preset: ${activePreset || '(none)'}`],
      tone: 'success',
    });
  }
}

export const presetOrchestrator = new PresetOrchestrator();

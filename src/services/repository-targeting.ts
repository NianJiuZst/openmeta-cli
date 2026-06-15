import { parseGitHubRepoFullName } from '../infra/index.js';
import type { AppConfig, RepositoryPreset } from '../types/index.js';

export interface ResolvedRepositoryScope {
  mode: 'single' | 'preset' | 'global' | 'none';
  repo?: string;
  presetName?: string;
  repos: string[];
}

export class RepositoryTargetingService {
  normalizePresetName(nameInput: string): string {
    const name = nameInput.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
      throw new Error(
        'Repository preset name must start with a letter or number and may contain letters, numbers, dots, underscores, or dashes.',
      );
    }

    return name;
  }

  normalizeRepos(repoInputs: string[]): string[] {
    const repos = [...new Set(repoInputs.map((value) => parseGitHubRepoFullName(value)))];
    if (repos.length < 1 || repos.length > 10) {
      throw new Error('A repository preset must contain between 1 and 10 repositories.');
    }

    return repos;
  }

  getPreset(config: AppConfig, nameInput: string): { name: string; preset: RepositoryPreset } {
    const name = this.normalizePresetName(nameInput);
    const preset = config.repositoryTargeting.presets?.[name];
    if (!preset) {
      throw new Error(`Repository preset "${name}" does not exist.`);
    }

    return { name, preset };
  }

  getActivePreset(config: AppConfig): { name: string; preset: RepositoryPreset } | null {
    const targeting = config.repositoryTargeting ?? { activePreset: '', presets: {} };
    const activeName = targeting.activePreset?.trim();
    if (!activeName) {
      return null;
    }

    const preset = targeting.presets?.[activeName];
    if (!preset) {
      return null;
    }

    return {
      name: activeName,
      preset,
    };
  }

  getActiveRepos(config: AppConfig): string[] {
    return this.getActivePreset(config)?.preset.repos || [];
  }

  resolveScope(
    config: AppConfig,
    options: { repo?: string; preset?: string; allRepos?: boolean; allowGlobal?: boolean } = {},
  ): ResolvedRepositoryScope {
    if (options.repo) {
      const repo = parseGitHubRepoFullName(options.repo);
      return {
        mode: 'single',
        repo,
        repos: [repo],
      };
    }

    if (options.allRepos) {
      return {
        mode: options.allowGlobal === false ? 'none' : 'global',
        repos: [],
      };
    }

    if (options.preset) {
      const { name, preset } = this.getPreset(config, options.preset);
      return {
        mode: 'preset',
        presetName: name,
        repos: preset.repos,
      };
    }

    const active = this.getActivePreset(config);
    if (active) {
      return {
        mode: 'preset',
        presetName: active.name,
        repos: active.preset.repos,
      };
    }

    return {
      mode: options.allowGlobal === false ? 'none' : 'global',
      repos: [],
    };
  }

  validateConfig(config: AppConfig): {
    status: 'pass' | 'warn' | 'fail';
    summary: string;
    detail?: string;
    remediation?: string;
  } {
    const targeting = config.repositoryTargeting ?? { activePreset: '', presets: {} };
    const presets = targeting.presets || {};
    const names = Object.keys(presets);

    if (names.length === 0) {
      return {
        status: 'pass',
        summary: 'No repository presets are configured.',
      };
    }

    if (!targeting.activePreset) {
      return {
        status: 'warn',
        summary: 'Repository presets exist but no active preset is selected.',
        remediation: 'Run "openmeta preset use <name>" to choose the default exploration target set.',
      };
    }

    const active = presets[targeting.activePreset];
    if (!active) {
      return {
        status: 'fail',
        summary: 'The active repository preset does not exist in the saved preset list.',
        detail: targeting.activePreset,
        remediation: 'Select a valid preset with "openmeta preset use <name>" or remove the stale active preset.',
      };
    }

    try {
      const repos = this.normalizeRepos(active.repos || []);
      return {
        status: 'pass',
        summary: `Active repository preset "${targeting.activePreset}" is configured.`,
        detail: repos.join(', '),
      };
    } catch (error) {
      return {
        status: 'fail',
        summary: 'The active repository preset contains invalid repository entries.',
        detail: error instanceof Error ? error.message : String(error),
        remediation: 'Update the preset with "openmeta preset add <name> --repo <owner/name>" and switch back to it.',
      };
    }
  }
}

export const repositoryTargetingService = new RepositoryTargetingService();

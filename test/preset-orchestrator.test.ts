import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configService } from '../src/infra/config.js';
import { PresetOrchestrator } from '../src/orchestration/preset.js';
import type { AppConfig } from '../src/types/index.js';

let tempRoot = '';

function clearSharedConfigCache(): void {
  (configService as unknown as { config: AppConfig | null }).config = null;
}

describe('PresetOrchestrator', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'openmeta-preset-orchestrator-'));
    process.env['OPENMETA_CONFIG_DIR'] = join(tempRoot, '.config', 'openmeta');
    process.env['OPENMETA_HOME'] = join(tempRoot, '.openmeta');
    clearSharedConfigCache();
  });

  afterEach(() => {
    clearSharedConfigCache();
    delete process.env['OPENMETA_CONFIG_DIR'];
    delete process.env['OPENMETA_HOME'];

    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  test('adds repository presets with normalized deduplicated repos and can switch the active preset', async () => {
    const orchestrator = new PresetOrchestrator();

    await orchestrator.add('frontend-core', {
      repo: ['vercel/next.js', 'https://github.com/vercel/next.js', 'git@github.com:facebook/react.git'],
      activate: true,
    });
    await orchestrator.add('tooling', {
      repo: ['oven-sh/bun'],
    });
    await orchestrator.use('tooling');

    const loaded = await configService.get();

    expect(loaded.repositoryTargeting.presets['frontend-core']).toEqual({
      repos: ['vercel/next.js', 'facebook/react'],
    });
    expect(loaded.repositoryTargeting.presets['tooling']).toEqual({
      repos: ['oven-sh/bun'],
    });
    expect(loaded.repositoryTargeting.activePreset).toBe('tooling');
  });

  test('rejects invalid preset repositories and repo counts beyond the configured limit', async () => {
    const orchestrator = new PresetOrchestrator();

    await expect(
      orchestrator.add('broken', {
        repo: ['https://gitlab.com/acme/demo'],
      }),
    ).rejects.toThrow('Repository must be a GitHub repository');

    await expect(
      orchestrator.add('too-many', {
        repo: Array.from({ length: 11 }, (_, index) => `acme/demo-${index}`),
      }),
    ).rejects.toThrow('must contain between 1 and 10 repositories');
  });

  test('removes repository presets and clears the active preset when needed', async () => {
    const orchestrator = new PresetOrchestrator();

    await orchestrator.add('default', {
      repo: ['acme/demo'],
      activate: true,
    });
    await orchestrator.remove('default');

    const loaded = await configService.get();
    expect(loaded.repositoryTargeting.presets['default']).toBeUndefined();
    expect(loaded.repositoryTargeting.activePreset).toBe('');
  });
});

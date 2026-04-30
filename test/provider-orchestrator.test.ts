import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigService, configService } from '../src/infra/config.js';
import { ProviderOrchestrator } from '../src/orchestration/provider.js';
import type { AppConfig } from '../src/types/index.js';

let tempRoot = '';

function clearSharedConfigCache(): void {
  (configService as unknown as { config: AppConfig | null }).config = null;
}

describe('ProviderOrchestrator', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'openmeta-provider-orchestrator-'));
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

  test('saves the current LLM settings as an encrypted provider profile', async () => {
    const orchestrator = new ProviderOrchestrator();
    const config = await configService.get();
    await configService.save({
      ...config,
      llm: {
        ...config.llm,
        provider: 'custom',
        apiBaseUrl: 'https://example.com/v1',
        modelName: 'example-model',
        apiKey: 'sk-profile-secret',
      },
    });

    await orchestrator.save('example');

    const raw = readFileSync(configService.getConfigPath(), 'utf-8');
    const loaded = await new ConfigService().load();

    expect(raw).not.toContain('sk-profile-secret');
    expect(loaded.llm.profiles?.['example']).toEqual({
      provider: 'custom',
      apiBaseUrl: 'https://example.com/v1',
      modelName: 'example-model',
      apiKey: 'sk-profile-secret',
      apiHeaders: {},
    });
    expect(loaded.llm.activeProfile).toBe('example');
  });

  test('adds and switches to a named provider profile', async () => {
    const orchestrator = new ProviderOrchestrator();

    await orchestrator.add('henng-gpt54', {
      provider: 'custom',
      baseUrl: 'https://api2.henng.cn/v1',
      model: 'gpt-5.4',
      apiKey: 'sk-henng-secret',
      header: ['X-Test=yes'],
    });
    await orchestrator.use('henng-gpt54');

    const loaded = await configService.get();
    expect(loaded.llm.provider).toBe('custom');
    expect(loaded.llm.apiBaseUrl).toBe('https://api2.henng.cn/v1');
    expect(loaded.llm.modelName).toBe('gpt-5.4');
    expect(loaded.llm.apiKey).toBe('sk-henng-secret');
    expect(loaded.llm.apiHeaders).toEqual({ 'X-Test': 'yes' });
    expect(loaded.llm.activeProfile).toBe('henng-gpt54');
  });

  test('removes provider profiles without changing the active provider settings', async () => {
    const orchestrator = new ProviderOrchestrator();

    await orchestrator.add('temporary', {
      provider: 'custom',
      baseUrl: 'https://example.com/v1',
      model: 'temporary-model',
      apiKey: 'sk-temporary-secret',
    });
    await orchestrator.use('temporary');
    await orchestrator.remove('temporary');

    const loaded = await configService.get();
    expect(loaded.llm.profiles?.['temporary']).toBeUndefined();
    expect(loaded.llm.activeProfile).toBe('');
    expect(loaded.llm.modelName).toBe('temporary-model');
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigService, configService } from '../src/infra/config.js';
import { ConfigOrchestrator } from '../src/orchestration/config.js';
import type { AppConfig } from '../src/types/index.js';

let tempRoot = '';

function clearSharedConfigCache(): void {
  (configService as unknown as { config: AppConfig | null }).config = null;
}

describe('ConfigOrchestrator', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'openmeta-config-orchestrator-'));
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

  test('sets encrypted GitHub and LLM secrets from dotted config keys', async () => {
    const orchestrator = new ConfigOrchestrator();

    await orchestrator.set('github.pat', 'ghp_new_secret');
    await orchestrator.set('llm.apiKey', 'sk-new-secret');

    const configPath = configService.getConfigPath();
    const raw = readFileSync(configPath, 'utf-8');
    const loaded = await new ConfigService().load();

    expect(raw).not.toContain('ghp_new_secret');
    expect(raw).not.toContain('sk-new-secret');
    expect(loaded.github.pat).toBe('ghp_new_secret');
    expect(loaded.llm.apiKey).toBe('sk-new-secret');
  });

  test('sets llm.provider to gemini', async () => {
    const orchestrator = new ConfigOrchestrator();

    await orchestrator.set('llm.provider', 'gemini');

    const loaded = await new ConfigService().load();
    expect(loaded.llm.provider).toBe('gemini');
  });

  test('sets llm.provider to claude', async () => {
    const orchestrator = new ConfigOrchestrator();

    await orchestrator.set('llm.provider', 'claude');

    const loaded = await new ConfigService().load();
    expect(loaded.llm.provider).toBe('claude');
  });

  test('rejects invalid llm.provider', async () => {
    const orchestrator = new ConfigOrchestrator();

    await expect(orchestrator.set('llm.provider', 'invalid_provider')).rejects.toThrow(/llm.provider must be/);
  });

  test('accepts all valid llm.provider values', async () => {
    const orchestrator = new ConfigOrchestrator();
    const validProviders = ['openai', 'minimax', 'moonshot', 'zhipu', 'gemini', 'claude', 'custom'];

    for (const provider of validProviders) {
      await orchestrator.set('llm.provider', provider);
      const loaded = await new ConfigService().load();
      expect(loaded.llm.provider).toBe(provider);
    }
  });
});

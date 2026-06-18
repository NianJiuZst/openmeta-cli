import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService, configService } from '../src/infra/config.js';
import { ConfigOrchestrator } from '../src/orchestration/config.js';
import type { AppConfig } from '../src/types/index.js';

let tempRoot = '';

function clearSharedConfigCache(): void {
  (configService as unknown as { config: AppConfig | null }).config = null;
}

function withMockedPlatform<T>(platform: NodeJS.Platform, callback: () => Promise<T> | T): Promise<T> | T {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });

  const restore = () => {
    if (originalDescriptor) {
      Object.defineProperty(process, 'platform', originalDescriptor);
      return;
    }

    delete (process as { platform?: NodeJS.Platform }).platform;
  };

  try {
    const result = callback();
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).finally(restore);
    }

    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
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

  test('sets and validates LLM reasoning effort from dotted config keys', async () => {
    const orchestrator = new ConfigOrchestrator();

    await orchestrator.set('llm.reasoningEffort', 'high');

    const loaded = await configService.get();
    expect(loaded.llm.reasoningEffort).toBe('high');

    await expect(orchestrator.set('llm.reasoningEffort', 'unsupported')).rejects.toThrow('llm.reasoningEffort must be');
  });

  test('sets and validates LLM streaming from dotted config keys', async () => {
    const orchestrator = new ConfigOrchestrator();

    await orchestrator.set('llm.stream', 'true');
    expect((await configService.get()).llm.stream).toBe(true);

    await orchestrator.set('llm.stream', 'false');
    expect((await configService.get()).llm.stream).toBe(false);

    await expect(orchestrator.set('llm.stream', 'maybe')).rejects.toThrow('llm.stream must be a boolean value.');
  });

  test('returns a masked machine config snapshot', async () => {
    const orchestrator = new ConfigOrchestrator();

    await orchestrator.set('github.pat', 'ghp_new_secret');
    await orchestrator.set('llm.apiKey', 'sk-new-secret');

    const snapshot = await orchestrator.getMachineSnapshot();

    expect(snapshot.github.pat).toBe('***cret');
    expect(snapshot.llm.apiKey).toBe('***cret');
    expect(snapshot.llm.modelName).toBe('gpt-4o-mini');
    expect(snapshot.llm.savedProfiles).toEqual([]);
  });

  test('returns machine config set results with masked secret values', async () => {
    const orchestrator = new ConfigOrchestrator();

    const result = await orchestrator.setMachineValue('llm.apiKey', 'sk-machine-secret');

    expect(result.updatedKey).toBe('llm.apiKey');
    expect(result.appliedValue).toBe('***cret');
    expect(result.snapshot.llm.apiKey).toBe('***cret');
    expect(result.scheduler.status).toBe('unchanged');
  });

  test('normalizes legacy manual scheduler configs to schtasks on Windows', async () => {
    await withMockedPlatform('win32', async () => {
      const service = new ConfigService();

      await service.save({
        ...(await service.get()),
        automation: {
          ...(await service.get()).automation,
          scheduler: 'manual',
        },
      });

      expect((await service.get()).automation.scheduler).toBe('schtasks');

      (service as unknown as { config: AppConfig | null }).config = null;
      const loaded = await service.load();

      expect(loaded.automation.scheduler).toBe('schtasks');
    });
  });

  test('save keeps unrelated llm fields intact while normalizing scheduler cache on Windows', async () => {
    await withMockedPlatform('win32', async () => {
      const service = new ConfigService();
      const current = await service.get();

      await service.save({
        ...current,
        llm: {
          ...current.llm,
          apiHeaders: { 'X-Keep': 'yes' },
        },
        automation: {
          ...current.automation,
          scheduler: 'manual',
        },
      });

      const saved = await service.get();
      expect(saved.llm.apiHeaders).toEqual({ 'X-Keep': 'yes' });
      expect(saved.automation.scheduler).toBe('schtasks');
    });
  });
});

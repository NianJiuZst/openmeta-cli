import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService, configService } from '../src/infra/config.js';
import * as infra from '../src/infra/index.js';
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
    mock.restore();
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

  test('rejects unsupported proficiency and partially numeric configuration values', async () => {
    const orchestrator = new ConfigOrchestrator();

    await expect(orchestrator.set('userProfile.proficiency', 'expert')).rejects.toThrow(
      'userProfile.proficiency must be "beginner", "intermediate", or "advanced".',
    );
    await expect(orchestrator.set('automation.minMatchScore', '75points')).rejects.toThrow(
      'automation.minMatchScore must be an integer between 0 and 100.',
    );
    await expect(orchestrator.set('scoring.weights.impact', '0.5weight')).rejects.toThrow(
      'scoring.weights.impact must be a number between 0 and 1.',
    );
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

  test('renders repository preset summary and artifact repository terminology in config view', async () => {
    const orchestrator = new ConfigOrchestrator();
    const heroSpy = spyOn(infra.ui, 'hero').mockImplementation(() => {});
    const keyValuesSpy = spyOn(infra.ui, 'keyValues').mockImplementation(() => {});
    const statsSpy = spyOn(infra.ui, 'stats').mockImplementation(() => {});
    const cardSpy = spyOn(infra.ui, 'card').mockImplementation(() => {});

    await configService.save({
      ...(await configService.get()),
      github: {
        pat: 'ghp_secret',
        username: 'octocat',
        targetRepoPath: '/tmp/private-artifacts',
      },
      repositoryTargeting: {
        activePreset: 'frontend',
        presets: {
          frontend: {
            repos: ['vercel/next.js', 'facebook/react'],
          },
          tools: {
            repos: ['oven-sh/bun'],
          },
        },
      },
      llm: {
        ...(await configService.get()).llm,
        apiKey: 'sk-secret',
      },
    });

    await orchestrator.view();

    expect(heroSpy).toHaveBeenCalled();
    expect(statsSpy).toHaveBeenCalled();
    expect(cardSpy).toHaveBeenCalled();
    expect(keyValuesSpy).toHaveBeenCalledWith(
      'GitHub',
      expect.arrayContaining([expect.objectContaining({ label: 'Artifact repo', value: '/tmp/private-artifacts' })]),
    );
    expect(keyValuesSpy).toHaveBeenCalledWith('Repository targeting', [
      { label: 'Active preset', value: 'frontend', tone: 'success' },
      { label: 'Saved presets', value: '2', tone: 'info' },
      { label: 'Active repos', value: 'vercel/next.js, facebook/react', tone: 'info' },
    ]);
  });

  test('exports config with secrets redacted by default', async () => {
    const orchestrator = new ConfigOrchestrator();

    await orchestrator.set('github.pat', 'ghp_export_secret');
    await orchestrator.set('llm.apiKey', 'sk-export-secret');
    await orchestrator.set('github.username', 'testuser');

    const exportPath = join(tempRoot, 'exported.json');
    const cardSpy = spyOn(infra.ui, 'card').mockImplementation(() => {});

    await orchestrator.exportConfig(exportPath);

    expect(existsSync(exportPath)).toBe(true);
    const content = JSON.parse(readFileSync(exportPath, 'utf-8'));
    expect(content.github.pat).toBe('<REDACTED>');
    expect(content.llm.apiKey).toBe('<REDACTED>');
    expect(content.github.username).toBe('testuser');
    expect(content.userProfile).toBeDefined();
    expect(content.scoring).toBeDefined();
    expect(cardSpy).toHaveBeenCalled();
  });

  test('exports config with secrets included when flag is set', async () => {
    const orchestrator = new ConfigOrchestrator();

    await orchestrator.set('github.pat', 'ghp_include_secret');
    await orchestrator.set('llm.apiKey', 'sk-include-secret');

    const exportPath = join(tempRoot, 'exported-secrets.json');
    spyOn(infra.ui, 'card').mockImplementation(() => {});

    await orchestrator.exportConfig(exportPath, { includeSecrets: true });

    const content = JSON.parse(readFileSync(exportPath, 'utf-8'));
    expect(content.github.pat).toBe('ghp_include_secret');
    expect(content.llm.apiKey).toBe('sk-include-secret');
  });

  test('imports config and merges non-redacted fields', async () => {
    const orchestrator = new ConfigOrchestrator();

    await orchestrator.set('github.pat', 'ghp_original');
    await orchestrator.set('llm.apiKey', 'sk-original');

    const exportPath = join(tempRoot, 'to-import.json');
    spyOn(infra.ui, 'card').mockImplementation(() => {});

    await orchestrator.exportConfig(exportPath);

    clearSharedConfigCache();
    await configService.load();

    await orchestrator.importConfig(exportPath);

    const loaded = await configService.get();
    expect(loaded.github.pat).toBe('ghp_original');
    expect(loaded.llm.apiKey).toBe('sk-original');
  });

  test('import preserves existing secrets when file has redacted values', async () => {
    const orchestrator = new ConfigOrchestrator();

    await orchestrator.set('github.pat', 'ghp_keep_me');
    await orchestrator.set('llm.apiKey', 'sk-keep-me');
    await orchestrator.set('userProfile.techStack', 'rust,go');

    const exportPath = join(tempRoot, 'redacted-import.json');
    spyOn(infra.ui, 'card').mockImplementation(() => {});

    await orchestrator.exportConfig(exportPath);

    const exportedContent = JSON.parse(readFileSync(exportPath, 'utf-8'));
    exportedContent.userProfile.techStack = ['typescript', 'python'];

    const modifiedPath = join(tempRoot, 'modified-import.json');
    const { writeFileSync } = await import('fs');
    writeFileSync(modifiedPath, JSON.stringify(exportedContent, null, 2), 'utf-8');

    await orchestrator.importConfig(modifiedPath);

    const loaded = await configService.get();
    expect(loaded.github.pat).toBe('ghp_keep_me');
    expect(loaded.llm.apiKey).toBe('sk-keep-me');
    expect(loaded.userProfile.techStack).toEqual(['typescript', 'python']);
  });

  test('import throws on non-existent file', async () => {
    const orchestrator = new ConfigOrchestrator();
    await expect(orchestrator.importConfig('/nonexistent/path.json')).rejects.toThrow('File not found');
  });

  test('import throws on invalid JSON', async () => {
    const orchestrator = new ConfigOrchestrator();
    const badPath = join(tempRoot, 'bad.json');
    const { writeFileSync } = await import('fs');
    writeFileSync(badPath, 'not valid json {{{', 'utf-8');

    await expect(orchestrator.importConfig(badPath)).rejects.toThrow('Failed to parse config file');
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

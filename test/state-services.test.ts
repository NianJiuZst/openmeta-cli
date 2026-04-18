import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigService } from '../src/infra/config.js';
import { inboxService } from '../src/services/inbox.js';
import { memoryService } from '../src/services/memory.js';
import { proofOfWorkService } from '../src/services/proof-of-work.js';
import { createInboxItem, createProofRecord, createRankedIssue, createWorkspace } from './helpers/factories.js';

let tempRoot = '';

function createIsolatedDir(): string {
  return mkdtempSync(join(tmpdir(), 'openmeta-test-'));
}

describe('stateful services', () => {
  beforeEach(() => {
    tempRoot = createIsolatedDir();
    process.env['OPENMETA_CONFIG_DIR'] = join(tempRoot, '.config', 'openmeta');
    process.env['OPENMETA_HOME'] = join(tempRoot, '.openmeta');
  });

  afterEach(() => {
    delete process.env['OPENMETA_CONFIG_DIR'];
    delete process.env['OPENMETA_HOME'];

    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  test('config service saves and loads encrypted credentials in an isolated config dir', async () => {
    const service = new ConfigService();
    const config = await service.get();

    config.github.pat = 'ghp_test_token';
    config.github.username = 'nianjiu';
    config.llm.apiKey = 'sk-test-key';

    await service.save(config);

    const configPath = service.getConfigPath();
    const raw = readFileSync(configPath, 'utf-8');

    expect(existsSync(configPath)).toBe(true);
    expect(raw).not.toContain('ghp_test_token');
    expect(raw).not.toContain('sk-test-key');

    const reloaded = new ConfigService();
    const loaded = await reloaded.load();

    expect(loaded.github.pat).toBe('ghp_test_token');
    expect(loaded.llm.apiKey).toBe('sk-test-key');
  });

  test('memory service persists repo memory snapshots', () => {
    const nextMemory = memoryService.update(createRankedIssue(), createWorkspace());
    const loadedMemory = memoryService.load('acme/demo');

    expect(nextMemory.generatedDossiers).toBe(1);
    expect(loadedMemory.lastSelectedIssue).toBe('acme/demo#42');
    expect(loadedMemory.preferredPaths).toContain('src/components/IconButton.tsx');
    expect(readFileSync(memoryService.getPath('acme/demo'), 'utf-8')).toContain('"generatedDossiers": 1');
  });

  test('inbox service deduplicates items and keeps higher scores first', () => {
    inboxService.saveItem(createInboxItem({ id: 'one', overallScore: 70, repoFullName: 'acme/one', issueNumber: 1 }));
    const items = inboxService.saveItem(createInboxItem({ id: 'two', overallScore: 90, repoFullName: 'acme/two', issueNumber: 2 }));

    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe('two');
    expect(inboxService.renderMarkdown(items)).toContain('[READY] acme/two#2 | overall 90');
  });

  test('proof-of-work service records PR links in markdown output', () => {
    const records = proofOfWorkService.record(createProofRecord());
    const markdown = proofOfWorkService.renderMarkdown(records);

    expect(records).toHaveLength(1);
    expect(markdown).toContain('Published Runs: 1');
    expect(markdown).toContain('pr=https://github.com/acme/demo/pull/123');
  });
});

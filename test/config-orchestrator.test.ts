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

		await expect(orchestrator.set('llm.reasoningEffort', 'unsupported')).rejects.toThrow(
			'llm.reasoningEffort must be',
		);
	});

	test('sets and validates LLM streaming from dotted config keys', async () => {
		const orchestrator = new ConfigOrchestrator();

		await orchestrator.set('llm.stream', 'true');
		expect((await configService.get()).llm.stream).toBe(true);

		await orchestrator.set('llm.stream', 'false');
		expect((await configService.get()).llm.stream).toBe(false);

		await expect(orchestrator.set('llm.stream', 'maybe')).rejects.toThrow(
			'llm.stream must be a boolean value.',
		);
	});
});

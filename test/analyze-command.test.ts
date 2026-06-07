import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerAnalyzeCommand } from '../src/commands/analyze.js';

describe('registerAnalyzeCommand', () => {
	test('registers analyze command with repository targeting options', () => {
		const program = new Command();
		registerAnalyzeCommand(program);

		const analyzeCommand = program.commands.find((command) => command.name() === 'analyze');
		const help = analyzeCommand?.helpInformation() ?? '';

		expect(help).toContain('analyze');
		expect(help).toContain('--repo <repository>');
		expect(help).toContain('--headless');
		expect(help).toContain('--run-checks');
		expect(help).toContain('--dry-run');
	});
});

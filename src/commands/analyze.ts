import type { Command } from 'commander';
import { analyzeOrchestrator } from '../orchestration/index.js';
import { runCommand } from './run-command.js';

export function registerAnalyzeCommand(program: Command): void {
	program
		.command('analyze')
		.description(
			'Analyze a repository and draft contribution suggestions without relying on existing issues',
		)
		.requiredOption('--repo <repository>', 'GitHub repository URL or owner/name to analyze')
		.option('--headless', 'Select the highest-scoring suggestion without prompting')
		.option(
			'--run-checks',
			'Execute detected baseline validation commands during workspace preparation',
		)
		.option('--dry-run', 'Preview artifact paths without writing local analysis files')
		.action(
			(options: { repo?: string; headless?: boolean; runChecks?: boolean; dryRun?: boolean }) =>
				runCommand('OpenMeta Analyze', () =>
					analyzeOrchestrator.run({
						repo: options.repo,
						headless: options.headless,
						runChecks: options.runChecks,
						dryRun: options.dryRun,
					}),
				),
		);
}

import { type Command, Option } from 'commander';
import { agentOrchestrator } from '../orchestration/index.js';
import { runCommand } from './run-command.js';

export function registerAgentCommand(program: Command): void {
	program
		.command('agent')
		.description('Run the autonomous contribution agent workflow')
		.option('--headless', 'Run unattended using saved automation defaults')
		.option('--force', 'Reserved for compatibility with scheduled runs')
		.option('--run-checks', 'Execute detected baseline validation commands')
		.option(
			'--draft-only',
			'Generate dossier and PR draft artifacts without applying file edits or opening a PR',
		)
		.option('--refresh', 'Ignore cached GitHub issue discovery results')
		.option(
			'--repo <repository>',
			'Limit issue discovery to one GitHub repository URL or owner/name',
		)
		.option('--issue <issue>', 'Solve one GitHub issue number or issue URL')
		.option('--dry-run', 'Preview artifacts without writing to git')
		.addOption(new Option('--scheduler-run', 'Internal flag for scheduled automation').hideHelp())
		.action(
			(options: {
				headless?: boolean;
				force?: boolean;
				runChecks?: boolean;
				draftOnly?: boolean;
				refresh?: boolean;
				repo?: string;
				issue?: string;
				dryRun?: boolean;
				schedulerRun?: boolean;
			}) =>
				runCommand('OpenMeta Agent', () =>
					agentOrchestrator.run({
						headless: options.headless,
						force: options.force,
						runChecks: options.runChecks,
						draftOnly: options.draftOnly,
						refresh: options.refresh,
						repo: options.repo,
						issue: options.issue,
						dryRun: options.dryRun,
						schedulerRun: options.schedulerRun,
					}),
				),
		);
}

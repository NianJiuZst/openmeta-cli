import { type Command, Option } from "commander";
import { dailyOrchestrator } from "../orchestration/index.js";
import { runCommand } from "./run-command.js";

export function registerDailyCommand(program: Command): void {
	program
		.command("daily")
		.description("Alias for the autonomous contribution agent workflow")
		.option("--headless", "Run unattended using saved automation defaults")
		.option("--force", "Reserved for compatibility with scheduled runs")
		.option("--run-checks", "Execute detected baseline validation commands")
		.option(
			"--draft-only",
			"Generate dossier and PR draft artifacts without applying file edits or opening a PR",
		)
		.option("--refresh", "Ignore cached GitHub issue discovery results")
		.addOption(
			new Option(
				"--scheduler-run",
				"Internal flag for scheduled automation",
			).hideHelp(),
		)
		.action(
			(options: {
				headless?: boolean;
				force?: boolean;
				runChecks?: boolean;
				draftOnly?: boolean;
				refresh?: boolean;
				schedulerRun?: boolean;
			}) =>
				runCommand("OpenMeta Daily", () =>
					dailyOrchestrator.execute({
						headless: options.headless,
						force: options.force,
						runChecks: options.runChecks,
						draftOnly: options.draftOnly,
						refresh: options.refresh,
						schedulerRun: options.schedulerRun,
					}),
				),
		);
}

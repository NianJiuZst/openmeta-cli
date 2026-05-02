import type { Command } from "commander";
import { runsOrchestrator } from "../orchestration/index.js";
import { runCommand } from "./run-command.js";

export function registerRunsCommand(program: Command): void {
	program
		.command("runs [id]")
		.description("Show recent OpenMeta command runs or inspect one run")
		.option("--limit <count>", "Number of runs to show", "10")
		.option("--json", "Print raw run history JSON")
		.action(
			(id: string | undefined, options: { limit?: string; json?: boolean }) =>
				runCommand(
					"OpenMeta Runs",
					() =>
						id
							? runsOrchestrator.show(id, { json: options.json })
							: runsOrchestrator.list({
									limit: Number.parseInt(options.limit || "10", 10) || 10,
									json: options.json,
								}),
					{ silentSuccess: options.json, recordRun: false },
				),
		);
}

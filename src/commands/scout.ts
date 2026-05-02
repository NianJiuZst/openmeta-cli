import type { Command } from "commander";
import { agentOrchestrator } from "../orchestration/index.js";
import { runCommand } from "./run-command.js";

export function registerScoutCommand(program: Command): void {
	program
		.command("scout")
		.description("Rank the highest-value contribution opportunities")
		.option("--limit <count>", "Number of opportunities to show", "10")
		.option("--refresh", "Ignore cached GitHub issue discovery results")
		.option(
			"--local",
			"Use local heuristic scoring without calling the LLM provider",
		)
		.action((options: { limit?: string; refresh?: boolean; local?: boolean }) =>
			runCommand("OpenMeta Scout", () =>
				agentOrchestrator.scout({
					limit: Number.parseInt(options.limit || "10", 10) || 10,
					refresh: options.refresh,
					localOnly: options.local,
				}),
			),
		);
}

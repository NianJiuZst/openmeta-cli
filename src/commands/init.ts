import type { Command } from "commander";
import { initOrchestrator } from "../orchestration/index.js";
import { runCommand } from "./run-command.js";

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize OpenMeta CLI configuration")
		.action(() =>
			runCommand("OpenMeta Init", () => initOrchestrator.execute()),
		);
}

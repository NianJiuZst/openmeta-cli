import type { Command } from "commander";
import { configOrchestrator } from "../orchestration/index.js";
import { runCommand } from "./run-command.js";

export function registerConfigCommand(program: Command): void {
	const config = program
		.command("config")
		.description("View and modify OpenMeta CLI configuration");

	config
		.command("view")
		.description("View current configuration")
		.action(() =>
			runCommand("OpenMeta Config", () => configOrchestrator.view()),
		);

	config
		.command("set <key> <value>")
		.description("Set a configuration value")
		.action((key: string, value: string) =>
			runCommand("OpenMeta Config", () => configOrchestrator.set(key, value)),
		);

	config
		.command("reset")
		.description("Reset configuration to defaults")
		.action(() =>
			runCommand("OpenMeta Config", () => configOrchestrator.reset()),
		);
}

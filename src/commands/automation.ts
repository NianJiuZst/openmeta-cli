import type { Command } from "commander";
import { automationOrchestrator } from "../orchestration/index.js";
import { runCommand } from "./run-command.js";

export function registerAutomationCommand(program: Command): void {
	const automation = program
		.command("automation")
		.description("Manage unattended daily automation");

	automation
		.command("status")
		.description("Show automation status")
		.action(() =>
			runCommand("OpenMeta Automation", () => automationOrchestrator.status()),
		);

	automation
		.command("enable")
		.description("Enable unattended daily automation using saved settings")
		.action(() =>
			runCommand("OpenMeta Automation", () => automationOrchestrator.enable()),
		);

	automation
		.command("disable")
		.description(
			"Disable unattended daily automation and remove the system scheduler",
		)
		.action(() =>
			runCommand("OpenMeta Automation", () => automationOrchestrator.disable()),
		);
}

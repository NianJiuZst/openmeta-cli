import type { Command } from "commander";
import { agentOrchestrator } from "../orchestration/index.js";
import { runCommand } from "./run-command.js";

export function registerInboxCommand(program: Command): void {
	program
		.command("inbox")
		.description("Show drafted contribution opportunities")
		.action(() =>
			runCommand("OpenMeta Inbox", () => agentOrchestrator.showInbox()),
		);
}

import type { Command } from "commander";
import { doctorOrchestrator } from "../orchestration/index.js";
import { runCommand } from "./run-command.js";

export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("Check local prerequisites for running the OpenMeta agent")
		.action(() =>
			runCommand("OpenMeta Doctor", () => doctorOrchestrator.execute()),
		);
}

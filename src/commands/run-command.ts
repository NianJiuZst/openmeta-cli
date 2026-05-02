import { getErrorMessage, isUserCancelledError, ui } from "../infra/index.js";
import { runHistoryService } from "../services/index.js";

export async function runCommand(
	commandName: string,
	task: () => Promise<void>,
	options: { silentSuccess?: boolean; recordRun?: boolean } = {},
): Promise<void> {
	const shouldRecordRun = options.recordRun ?? true;
	const run = shouldRecordRun
		? runHistoryService.start({
				commandName,
				args: process.argv.slice(2),
			})
		: null;

	try {
		await task();
		if (run) {
			runHistoryService.finish(run.id, "success");
		}
		if (!options.silentSuccess) {
			ui.commandCompleted(commandName);
		}
	} catch (error) {
		if (isUserCancelledError(error)) {
			if (run) {
				runHistoryService.finish(run.id, "cancelled");
			}
			ui.commandCancelled(commandName);
			return;
		}

		const message = getErrorMessage(error);
		if (run) {
			runHistoryService.finish(run.id, "failed", message);
		}
		ui.commandFailed(commandName, message);
		process.exitCode = 1;
	}
}

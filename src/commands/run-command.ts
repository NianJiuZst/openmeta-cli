import { getErrorMessage, isUserCancelledError, ui } from '../infra/index.js';

export async function runCommand(
  commandName: string,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task();
    ui.commandCompleted(commandName);
  } catch (error) {
    if (isUserCancelledError(error)) {
      ui.commandCancelled(commandName);
      return;
    }

    ui.commandFailed(commandName, getErrorMessage(error));
    process.exitCode = 1;
  }
}

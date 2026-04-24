#!/usr/bin/env bun
import { Command } from 'commander';
import {
  registerAgentCommand,
  registerAutomationCommand,
  registerConfigCommand,
  registerDailyCommand,
  registerDoctorCommand,
  registerInboxCommand,
  registerInitCommand,
  registerPowCommand,
  registerScoutCommand,
} from './commands/index.js';
import { getErrorMessage, ui } from './infra/index.js';

const VERSION = '1.0.0';

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('openmeta')
    .description("OpenMeta CLI - Developer's daily open source growth companion")
    .version(VERSION, '-v, --version', 'Show version')
    .helpOption('-h, --help', 'Show help')
    .showSuggestionAfterError()
    .showHelpAfterError();

  registerInitCommand(program);
  registerAgentCommand(program);
  registerDailyCommand(program);
  registerScoutCommand(program);
  registerInboxCommand(program);
  registerPowCommand(program);
  registerConfigCommand(program);
  registerAutomationCommand(program);
  registerDoctorCommand(program);

  program.on('command:*', () => {
    ui.commandFailed('openmeta', `Unknown command "${program.args.join(' ')}". Run "openmeta --help" to see available commands.`);
    process.exit(1);
  });

  if (process.argv.length === 2) {
    program.help();
  }

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  ui.commandFailed('openmeta', getErrorMessage(error));
  process.exit(1);
});

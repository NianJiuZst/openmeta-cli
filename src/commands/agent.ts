import { Command, Option } from 'commander';
import { agentOrchestrator } from '../orchestration/index.js';
import { runCommand } from './run-command.js';

export function registerAgentCommand(program: Command): void {
  program
    .command('agent')
    .description('Run the autonomous contribution agent workflow')
    .option('--headless', 'Run unattended using saved automation defaults')
    .option('--force', 'Reserved for compatibility with scheduled runs')
    .option('--run-checks', 'Execute detected baseline validation commands')
    .addOption(new Option('--scheduler-run', 'Internal flag for scheduled automation').hideHelp())
    .action((options: { headless?: boolean; force?: boolean; runChecks?: boolean; schedulerRun?: boolean }) => runCommand(
      'OpenMeta Agent',
      () => agentOrchestrator.run({
        headless: options.headless,
        force: options.force,
        runChecks: options.runChecks,
        schedulerRun: options.schedulerRun,
      }),
    ));
}

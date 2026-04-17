import { Command } from 'commander';
import { agentOrchestrator } from '../orchestration/index.js';
import { runCommand } from './run-command.js';

export function registerScoutCommand(program: Command): void {
  program
    .command('scout')
    .description('Rank the highest-value contribution opportunities')
    .option('--limit <count>', 'Number of opportunities to show', '10')
    .action((options: { limit?: string }) => runCommand(
      'OpenMeta Scout',
      () => agentOrchestrator.scout(Number.parseInt(options.limit || '10', 10) || 10),
    ));
}

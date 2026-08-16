import type { Command } from 'commander';
import { agentOrchestrator } from '../orchestration/index.js';
import { parseStarCount } from './number-options.js';
import { runCommand } from './run-command.js';

export function registerScoutCommand(program: Command): void {
  program
    .command('scout')
    .description('Rank the highest-value contribution opportunities')
    .option('--limit <count>', 'Number of opportunities to show', '10')
    .option('--refresh', 'Ignore cached GitHub issue discovery results')
    .option('--min-stars <count>', 'Minimum repository star count', parseStarCount)
    .option('--max-stars <count>', 'Maximum repository star count', parseStarCount)
    .option('--repo <repository>', 'Limit issue discovery to one GitHub repository URL or owner/name')
    .option('--preset <name>', 'Use one saved repository preset as the discovery scope')
    .option('--all-repos', 'Ignore the active repository preset and search the broader issue stream')
    .action(
      (options: {
        limit?: string;
        refresh?: boolean;
        minStars?: number;
        maxStars?: number;
        repo?: string;
        preset?: string;
        allRepos?: boolean;
      }) =>
        runCommand('OpenMeta Scout', () =>
          agentOrchestrator.scout({
            limit: Number.parseInt(options.limit || '10', 10) || 10,
            refresh: options.refresh,
            minStars: options.minStars,
            maxStars: options.maxStars,
            repo: options.repo,
            preset: options.preset,
            allRepos: options.allRepos,
          }),
        ),
    );
}

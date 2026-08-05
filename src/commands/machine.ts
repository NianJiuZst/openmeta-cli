import type { Command } from 'commander';
import {
  machineAgentFlowOrchestrator,
  machineAnalyzeOrchestrator,
  machineConfigOrchestrator,
  machineDoctorOrchestrator,
  machineInboxOrchestrator,
  machineProofOfWorkOrchestrator,
  machineProviderOrchestrator,
  machineRunsOrchestrator,
  machineScoutOrchestrator,
} from '../orchestration/machine/index.js';
import { parseListLimit, parseStarCount } from './number-options.js';

export function registerMachineCommand(program: Command): void {
  const machine = program.command('machine').description('Stable JSON-first automation surface');

  machine
    .command('doctor')
    .description('Inspect local prerequisites and return machine-readable diagnostics')
    .action(() => machineDoctorOrchestrator.execute());

  const config = machine.command('config').description('Machine-safe configuration access');

  config
    .command('get')
    .description('Read a masked machine-safe configuration snapshot')
    .action(() => machineConfigOrchestrator.get());

  config
    .command('set <key> <value>')
    .description('Update a configuration key and return the masked resulting snapshot')
    .action((key: string, value: string) => machineConfigOrchestrator.set(key, value));

  const provider = machine.command('provider').description('Machine-safe provider profile management');

  provider
    .command('add <name>')
    .description('Save a provider profile and return its machine-readable state')
    .requiredOption('--base-url <url>', 'OpenAI-compatible API base URL')
    .requiredOption('--model <model>', 'Model name')
    .requiredOption('--api-key <key>', 'Provider API key')
    .option('--provider <provider>', 'Provider preset name')
    .option('--reasoning-effort <effort>', 'Reasoning effort')
    .option('--stream <enabled>', 'Streaming mode as true or false')
    .option(
      '--header <key=value>',
      'Extra provider header',
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .action(
      (
        name: string,
        options: {
          provider?: string;
          baseUrl?: string;
          model?: string;
          apiKey?: string;
          reasoningEffort?: string;
          stream?: string;
          header?: string[];
        },
      ) => machineProviderOrchestrator.add(name, options),
    );

  provider
    .command('use <name>')
    .description('Switch to a saved provider profile and return machine-readable state')
    .action((name: string) => machineProviderOrchestrator.use(name));

  machine
    .command('runs [id]')
    .description('Machine-safe run history access')
    .option('--limit <count>', 'Number of runs to show', parseListLimit, 10)
    .action((id: string | undefined, options: { limit?: number }) => machineRunsOrchestrator.show(id, options));

  machine
    .command('inbox')
    .description('Machine-safe drafted opportunity list')
    .action(() => machineInboxOrchestrator.execute());

  machine
    .command('pow')
    .description('Machine-safe proof-of-work list')
    .action(() => machineProofOfWorkOrchestrator.execute());

  machine
    .command('scout')
    .description('Machine-safe opportunity discovery')
    .option('--limit <count>', 'Number of opportunities to return', parseListLimit, 10)
    .option('--refresh', 'Ignore cached GitHub issue discovery results')
    .option('--min-stars <count>', 'Minimum repository star count', parseStarCount)
    .option('--max-stars <count>', 'Maximum repository star count', parseStarCount)
    .option('--repo <repository>', 'Limit issue discovery to one repository')
    .action((options: { limit?: number; refresh?: boolean; minStars?: number; maxStars?: number; repo?: string }) =>
      machineScoutOrchestrator.execute(options),
    );

  machine
    .command('analyze')
    .description('Machine-safe repository-first analysis')
    .requiredOption('--repo <repository>', 'GitHub repository URL or owner/name to analyze')
    .option('--repo-path <path>', 'Reuse a local repository path via an isolated worktree')
    .option('--headless', 'Select the highest-scoring suggestion without prompting')
    .option('--run-checks', 'Execute detected baseline validation commands during workspace preparation')
    .option('--dry-run', 'Preview artifact paths without writing local analysis files')
    .action(
      (options: { repo?: string; repoPath?: string; headless?: boolean; runChecks?: boolean; dryRun?: boolean }) =>
        machineAnalyzeOrchestrator.execute(options),
    );

  machine
    .command('agent')
    .description('Machine-safe contribution execution flow')
    .option('--headless', 'Run unattended using saved automation defaults')
    .option('--run-checks', 'Execute detected baseline validation commands')
    .option('--draft-only', 'Generate artifacts without applying file edits or opening a PR')
    .option('--local-artifacts-only', 'Write local artifacts without publishing, committing, or pushing them')
    .option('--refresh', 'Ignore cached GitHub issue discovery results')
    .option('--min-stars <count>', 'Minimum repository star count', parseStarCount)
    .option('--max-stars <count>', 'Maximum repository star count', parseStarCount)
    .option('--repo <repository>', 'Limit issue discovery to one repository')
    .option('--repo-path <path>', 'Reuse a local repository path via an isolated worktree')
    .option('--issue <issue>', 'Solve one GitHub issue number or issue URL')
    .option('--dry-run', 'Preview artifacts without publishing them')
    .action(
      (options: {
        headless?: boolean;
        runChecks?: boolean;
        draftOnly?: boolean;
        localArtifactsOnly?: boolean;
        refresh?: boolean;
        minStars?: number;
        maxStars?: number;
        repo?: string;
        repoPath?: string;
        issue?: string;
        dryRun?: boolean;
      }) => machineAgentFlowOrchestrator.execute(options),
    );
}

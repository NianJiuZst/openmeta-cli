import { type Command, Option } from 'commander';
import { agentOrchestrator } from '../orchestration/index.js';
import { parseStarCount } from './number-options.js';
import { runCommand } from './run-command.js';

export function registerAgentCommand(program: Command): void {
  program
    .command('agent')
    .description('Run the autonomous contribution agent workflow')
    .option('--headless', 'Run unattended using saved automation defaults')
    .option('--force', 'Reserved for compatibility with scheduled runs')
    .option('--run-checks', 'Execute detected baseline validation commands')
    .option('--draft-only', 'Generate dossier and PR draft artifacts without applying file edits or opening a PR')
    .option('--local-artifacts-only', 'Write local artifacts without publishing, committing, or pushing them')
    .option('--refresh', 'Ignore cached GitHub issue discovery results')
    .option('--min-stars <count>', 'Minimum repository star count', parseStarCount)
    .option('--max-stars <count>', 'Maximum repository star count', parseStarCount)
    .option('--repo <repository>', 'Limit issue discovery to one GitHub repository URL or owner/name')
    .option('--preset <name>', 'Use one saved repository preset as the exploration scope')
    .option('--all-repos', 'Ignore the active repository preset and search the broader issue stream')
    .option('--repo-path <path>', 'Reuse a local repository path via an isolated worktree')
    .option('--issue <issue>', 'Solve one GitHub issue number or issue URL')
    .option('--dry-run', 'Preview artifacts without writing to git')
    .addOption(new Option('--scheduler-run', 'Internal flag for scheduled automation').hideHelp())
    .action(
      (options: {
        headless?: boolean;
        force?: boolean;
        runChecks?: boolean;
        draftOnly?: boolean;
        localArtifactsOnly?: boolean;
        refresh?: boolean;
        minStars?: number;
        maxStars?: number;
        repo?: string;
        preset?: string;
        allRepos?: boolean;
        repoPath?: string;
        issue?: string;
        dryRun?: boolean;
        schedulerRun?: boolean;
      }) =>
        runCommand('OpenMeta Agent', () =>
          agentOrchestrator.run({
            headless: options.headless,
            force: options.force,
            runChecks: options.runChecks,
            draftOnly: options.draftOnly,
            localArtifactsOnly: options.localArtifactsOnly,
            refresh: options.refresh,
            minStars: options.minStars,
            maxStars: options.maxStars,
            repo: options.repo,
            preset: options.preset,
            allRepos: options.allRepos,
            repoPath: options.repoPath,
            issue: options.issue,
            dryRun: options.dryRun,
            schedulerRun: options.schedulerRun,
          }),
        ),
    );
}

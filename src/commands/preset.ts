import { Command } from 'commander';
import { presetOrchestrator } from '../orchestration/index.js';
import { runCommand } from './run-command.js';

export function registerPresetCommand(program: Command): void {
  const preset = program.command('preset').description('Manage reusable repository target presets');

  preset
    .command('list')
    .alias('ls')
    .description('List saved repository presets')
    .action(() => runCommand('OpenMeta Preset', () => presetOrchestrator.list()));

  preset
    .command('add <name>')
    .description('Add a repository preset from command-line values')
    .requiredOption(
      '--repo <repository>',
      'GitHub repository URL or owner/name; repeat for multiple repos',
      (value, previous: string[] = []) => [...previous, value],
      [],
    )
    .option('--activate', 'Mark this preset as the active default target set')
    .action((name: string, options: { repo: string[]; activate?: boolean }) =>
      runCommand('OpenMeta Preset', () => presetOrchestrator.add(name, options)),
    );

  preset
    .command('use <name>')
    .description('Switch the active repository preset')
    .action((name: string) => runCommand('OpenMeta Preset', () => presetOrchestrator.use(name)));

  preset
    .command('remove <name>')
    .alias('rm')
    .description('Remove a saved repository preset')
    .action((name: string) => runCommand('OpenMeta Preset', () => presetOrchestrator.remove(name)));
}

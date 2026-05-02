import { Command } from 'commander';
import { providerOrchestrator } from '../orchestration/index.js';
import { runCommand } from './run-command.js';

export function registerProviderCommand(program: Command): void {
  const provider = program
    .command('provider')
    .description('Manage reusable LLM provider profiles');

  provider
    .command('list')
    .alias('ls')
    .description('List saved provider profiles')
    .action(() => runCommand('OpenMeta Provider', () => providerOrchestrator.list()));

  provider
    .command('save <name>')
    .description('Save the current LLM settings as a provider profile')
    .action((name: string) => runCommand('OpenMeta Provider', () => providerOrchestrator.save(name)));

  provider
    .command('config')
    .alias('configure')
    .description('Configure a provider profile interactively')
    .action(() => runCommand('OpenMeta Provider', () => providerOrchestrator.configure()));

  provider
    .command('add <name>')
    .description('Add a provider profile from command-line values')
    .option('--provider <provider>', 'Provider type, defaults to custom')
    .requiredOption('--base-url <url>', 'OpenAI-compatible API base URL')
    .requiredOption('--model <model>', 'Model name')
    .requiredOption('--api-key <key>', 'LLM API key')
    .option('--header <key=value>', 'Extra API header; repeat for multiple headers', (value, previous: string[] = []) => [...previous, value], [])
    .action((name: string, options: {
      provider?: string;
      baseUrl: string;
      model: string;
      apiKey: string;
      header: string[];
    }) => runCommand('OpenMeta Provider', () => providerOrchestrator.add(name, options)));

  provider
    .command('use <name>')
    .description('Switch the active LLM provider to a saved profile')
    .option('--validate', 'Validate the selected provider after switching')
    .action((name: string, options: { validate?: boolean }) => runCommand(
      'OpenMeta Provider',
      () => providerOrchestrator.use(name, options),
    ));

  provider
    .command('remove <name>')
    .alias('rm')
    .description('Remove a saved provider profile')
    .action((name: string) => runCommand('OpenMeta Provider', () => providerOrchestrator.remove(name)));
}

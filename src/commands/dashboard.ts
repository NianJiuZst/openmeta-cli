import { Command } from 'commander';
import { dashboardOrchestrator } from '../orchestration/index.js';
import { parseDashboardPort } from './number-options.js';
import { runCommand } from './run-command.js';

export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('Serve the contribution dashboard with live local OpenMeta data')
    .option('--host <host>', 'Host to bind the local dashboard server', '127.0.0.1')
    .option('--port <port>', 'Preferred port for the local dashboard server', parseDashboardPort, 4326)
    .option('--open', 'Open the dashboard in your default browser after the server starts')
    .action((options: { host?: string; port?: number; open?: boolean }) =>
      runCommand(
        'OpenMeta Dashboard',
        () =>
          dashboardOrchestrator.serve({
            host: options.host,
            port: options.port ?? 4326,
            open: options.open,
          }),
        { recordRun: false },
      ),
    );
}

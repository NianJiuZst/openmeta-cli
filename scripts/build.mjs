import { execFileSync } from 'node:child_process';

const args = [
  'build',
  '--target=bun',
  '--outfile=bin/openmeta.js',
  '--external=@anthropic-ai/sandbox-runtime',
  './src/cli.ts',
];

function run(command, commandArgs) {
  execFileSync(command, commandArgs, {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}

function resolveBunCommand() {
  if (process.release?.name === 'bun') {
    return { command: process.execPath, args };
  }

  if (process.platform === 'win32') {
    try {
      const resolved = execFileSync('where', ['bun'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.toLowerCase().endsWith('.exe'));

      if (resolved) {
        return { command: resolved, args };
      }
    } catch {
      // fall through to bare command
    }
  }

  return { command: 'bun', args };
}

const { command, args: commandArgs } = resolveBunCommand();
run(command, commandArgs);

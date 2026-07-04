import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import type { TestCommand, TestResult } from '../types/index.js';

const SANDBOX_TIMEOUT_MS = 120_000;

interface SandboxRuntime {
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  isSupportedPlatform(): boolean;
  checkDependencies(): { errors: string[]; warnings: string[] };
  wrapWithSandbox(command: string): Promise<string>;
  annotateStderrWithSandboxFailures(command: string, stderr: string): string;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

interface CommandResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
}

type CommandRunner = (command: string, options: SpawnSyncOptionsWithStringEncoding) => CommandResult;

export interface SandboxAvailability {
  available: boolean;
  reason?: string;
  warnings: string[];
}

export class SandboxService {
  constructor(
    private readonly runtime: SandboxRuntime = SandboxManager,
    private readonly commandRunner: CommandRunner = spawnSync,
  ) {}

  getAvailability(): SandboxAvailability {
    if (!this.runtime.isSupportedPlatform()) {
      return {
        available: false,
        reason: `Sandboxed validation is not supported on ${process.platform}. Use Linux, WSL2, or macOS.`,
        warnings: [],
      };
    }

    const dependencies = this.runtime.checkDependencies();
    if (dependencies.errors.length > 0) {
      return {
        available: false,
        reason: `Sandbox dependencies are unavailable: ${dependencies.errors.join('; ')}`,
        warnings: dependencies.warnings,
      };
    }

    return { available: true, warnings: dependencies.warnings };
  }

  async runValidationCommands(workspacePath: string, commands: TestCommand[]): Promise<TestResult[]> {
    if (commands.length === 0) return [];

    const availability = this.getAvailability();
    if (!availability.available) {
      return commands.map((command) => this.unavailableResult(command, availability.reason || 'Sandbox unavailable.'));
    }

    const rootPath = resolve(workspacePath);
    const sandboxTemp = mkdtempSync(join(tmpdir(), 'openmeta-sandbox-'));

    try {
      await this.runtime.initialize(this.buildConfig(rootPath, sandboxTemp));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.safeReset();
      rmSync(sandboxTemp, { recursive: true, force: true });
      return commands.map((command) => this.unavailableResult(command, `Sandbox initialization failed: ${reason}`));
    }

    try {
      const results: TestResult[] = [];
      for (const command of commands) {
        results.push(await this.runCommand(rootPath, sandboxTemp, command));
      }
      return results;
    } finally {
      await this.safeReset();
      rmSync(sandboxTemp, { recursive: true, force: true });
    }
  }

  private buildConfig(workspacePath: string, sandboxTemp: string): SandboxRuntimeConfig {
    const home = homedir();
    return {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: [],
        allowLocalBinding: false,
      },
      filesystem: {
        denyRead: [
          join(home, '.ssh'),
          join(home, '.aws'),
          join(home, '.azure'),
          join(home, '.config', 'gh'),
          join(home, '.config', 'openmeta'),
          join(home, '.openmeta'),
          join(home, '.git-credentials'),
          join(home, '.netrc'),
          join(home, '.npmrc'),
          join(home, '.pypirc'),
        ],
        allowRead: [workspacePath, sandboxTemp],
        allowWrite: [workspacePath, sandboxTemp],
        denyWrite: [join(workspacePath, '.git'), join(home, '.config', 'openmeta'), join(home, '.openmeta')],
        allowGitConfig: false,
      },
    };
  }

  private async runCommand(workspacePath: string, sandboxTemp: string, command: TestCommand): Promise<TestResult> {
    let wrappedCommand: string;
    try {
      wrappedCommand = await this.runtime.wrapWithSandbox(command.command);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.unavailableResult(command, `Sandbox command preparation failed: ${reason}`);
    }

    try {
      const result = this.commandRunner(wrappedCommand, {
        cwd: workspacePath,
        encoding: 'utf-8',
        shell: true,
        timeout: SANDBOX_TIMEOUT_MS,
        env: this.buildEnvironment(sandboxTemp),
      });
      const stdout = String(result.stdout || '');
      const stderr = this.runtime.annotateStderrWithSandboxFailures(command.command, String(result.stderr || ''));
      const errorText = result.error ? `\n${result.error.message}` : '';
      const output = `${stdout}\n${stderr}${errorText}`.trim().slice(0, 2000);

      return {
        command: command.command,
        exitCode: typeof result.status === 'number' ? result.status : null,
        passed: result.status === 0,
        output,
      };
    } finally {
      this.runtime.cleanupAfterCommand();
    }
  }

  private buildEnvironment(sandboxTemp: string): NodeJS.ProcessEnv {
    const names = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'TERM'];
    const env: NodeJS.ProcessEnv = {};
    for (const name of names) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }

    env['HOME'] = sandboxTemp;
    env['USERPROFILE'] = sandboxTemp;
    env['TMPDIR'] = sandboxTemp;
    env['TMP'] = sandboxTemp;
    env['TEMP'] = sandboxTemp;
    env['CI'] = '1';
    return env;
  }

  private unavailableResult(command: TestCommand, reason: string): TestResult {
    return {
      command: command.command,
      exitCode: 127,
      passed: false,
      output: `Validation was not executed because a secure sandbox is unavailable. ${reason}`,
    };
  }

  private async safeReset(): Promise<void> {
    try {
      await this.runtime.reset();
    } catch {
      // Preserve the validation result when sandbox cleanup itself fails.
    }
  }
}

export const sandboxService = new SandboxService();

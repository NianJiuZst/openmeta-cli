import { afterEach, describe, expect, test } from 'bun:test';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SandboxService } from '../src/services/sandbox.js';

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'openmeta-sandbox-test-'));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('SandboxService', () => {
  test('fails closed when the current platform cannot provide a sandbox', async () => {
    let executed = false;
    const runtime = {
      initialize: async (_config: SandboxRuntimeConfig) => {},
      isSupportedPlatform: () => false,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      wrapWithSandbox: async (command: string) => command,
      annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
      cleanupAfterCommand: () => {},
      reset: async () => {},
    };
    const service = new SandboxService(runtime, () => {
      executed = true;
      return { status: 0 };
    });

    const results = await service.runValidationCommands(makeWorkspace(), [
      { command: 'pytest', reason: 'Detected pyproject.toml', source: 'tool-default' },
    ]);

    expect(executed).toBe(false);
    expect(results[0]?.exitCode).toBe(127);
    expect(results[0]?.output).toContain('secure sandbox is unavailable');
  });

  test('uses a deny-by-default network policy and a sanitized child environment', async () => {
    let config: SandboxRuntimeConfig | undefined;
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    let cleaned = 0;
    let reset = 0;
    const runtime = {
      initialize: async (value: SandboxRuntimeConfig) => {
        config = value;
      },
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      wrapWithSandbox: async (command: string) => `sandboxed ${command}`,
      annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
      cleanupAfterCommand: () => {
        cleaned += 1;
      },
      reset: async () => {
        reset += 1;
      },
    };
    const service = new SandboxService(runtime, (_command, options) => {
      childEnvironment = options.env;
      return { status: 0, stdout: 'passed', stderr: '' };
    });

    const results = await service.runValidationCommands(makeWorkspace(), [
      { command: 'go test ./...', reason: 'Detected go.mod', source: 'tool-default' },
    ]);

    expect(results[0]?.passed).toBe(true);
    expect(config?.network.allowedDomains).toEqual([]);
    expect(config?.filesystem.allowWrite).toHaveLength(2);
    expect(config?.filesystem.denyWrite.some((path) => path.endsWith('.git'))).toBe(true);
    expect(childEnvironment?.['GITHUB_TOKEN']).toBeUndefined();
    expect(childEnvironment?.['OPENAI_API_KEY']).toBeUndefined();
    expect(childEnvironment?.['CI']).toBe('1');
    expect(cleaned).toBe(1);
    expect(reset).toBe(1);
  });

  test('does not execute commands when sandbox initialization fails', async () => {
    let executed = false;
    const runtime = {
      initialize: async (_config: SandboxRuntimeConfig) => {
        throw new Error('proxy failed');
      },
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      wrapWithSandbox: async (command: string) => command,
      annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
      cleanupAfterCommand: () => {},
      reset: async () => {},
    };
    const service = new SandboxService(runtime, () => {
      executed = true;
      return { status: 0 };
    });

    const results = await service.runValidationCommands(makeWorkspace(), [
      { command: 'cargo test', reason: 'Detected Cargo.toml', source: 'tool-default' },
    ]);

    expect(executed).toBe(false);
    expect(results[0]?.output).toContain('Sandbox initialization failed: proxy failed');
  });
});

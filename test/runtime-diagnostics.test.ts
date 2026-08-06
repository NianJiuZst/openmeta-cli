import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyBinarySource, inspectBinaryOnPath } from '../src/services/runtime-diagnostics.js';

const commandName = 'openmeta-runtime-diagnostics-test';
let originalHome: string | undefined;
let testHome = '';

describe('runtime diagnostics', () => {
  beforeEach(() => {
    originalHome = process.env['HOME'];
    testHome = resolve(tmpdir(), 'openmeta-runtime-diagnostics-home');
    process.env['HOME'] = testHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
  });

  test('recognizes paths inside the Bun link directory', () => {
    const executablePath = join(testHome, '.bun', 'bin', commandName);

    expect(classifyBinarySource(executablePath, executablePath)).toBe('bun-link');
  });

  test('does not treat lookalike Bun directories as Bun links', () => {
    const executablePath = join(testHome, '.bun', 'bin-backup', commandName);

    expect(classifyBinarySource(executablePath, executablePath)).toBe('unknown');
  });

  test('reports commands that are absent from PATH', () => {
    const result = inspectBinaryOnPath(commandName);

    expect(result.onPath).toBe(false);
    expect(result.source).toBe('missing');
    expect(result.error).toBeTruthy();
  });
});

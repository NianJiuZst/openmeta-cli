import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/commands/run-command.js';
import { logger, UserCancelledError, ui } from '../src/infra/index.js';
import { agentEventLogService, runHistoryService } from '../src/services/index.js';

let tempRoot = '';
let originalArgv: string[] = [];

describe('runCommand', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'openmeta-run-command-'));
    process.env['OPENMETA_CONFIG_DIR'] = join(tempRoot, '.config', 'openmeta');
    process.env['OPENMETA_HOME'] = join(tempRoot, '.openmeta');
    originalArgv = process.argv;
    process.argv = ['bun', 'openmeta', 'scout', '--refresh'];
    process.exitCode = undefined;
    spyOn(ui, 'commandCompleted').mockImplementation(() => {});
    spyOn(ui, 'commandCancelled').mockImplementation(() => {});
    spyOn(ui, 'commandFailed').mockImplementation(() => {});
  });

  afterEach(() => {
    mock.restore();
    process.argv = originalArgv;
    process.exitCode = 0;
    delete process.env['OPENMETA_CONFIG_DIR'];
    delete process.env['OPENMETA_HOME'];

    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  test('records successful command history and lifecycle events', async () => {
    await runCommand('OpenMeta Scout', async () => {});

    const [run] = runHistoryService.load().records;
    expect(run?.status).toBe('success');
    expect(run?.args).toEqual(['scout', '--refresh']);
    expect(run && agentEventLogService.load(run.id).map((event) => event.type)).toEqual([
      'run_started',
      'run_finished',
    ]);
    expect(ui.commandCompleted).toHaveBeenCalledWith('OpenMeta Scout');
  });

  test('supports silent commands without creating run state', async () => {
    await runCommand('OpenMeta JSON', async () => {}, { silentSuccess: true, recordRun: false });

    expect(runHistoryService.load().records).toEqual([]);
    expect(ui.commandCompleted).not.toHaveBeenCalled();
  });

  test('records user cancellation without setting a failure exit code', async () => {
    await runCommand('OpenMeta Agent', async () => {
      throw new UserCancelledError();
    });

    const [run] = runHistoryService.load().records;
    expect(run?.status).toBe('cancelled');
    expect(run && agentEventLogService.load(run.id).map((event) => event.type)).toEqual([
      'run_started',
      'run_cancelled',
    ]);
    expect(process.exitCode).not.toBe(1);
    expect(ui.commandCancelled).toHaveBeenCalledWith('OpenMeta Agent');
  });

  test('records failures, reports their message, and sets the exit code', async () => {
    await runCommand('OpenMeta Doctor', async () => {
      throw new Error('Configuration is invalid');
    });

    const [run] = runHistoryService.load().records;
    expect(run?.status).toBe('failed');
    expect(run?.error).toBe('Configuration is invalid');
    expect(run && agentEventLogService.load(run.id).map((event) => event.type)).toEqual(['run_started', 'run_failed']);
    expect(ui.commandFailed).toHaveBeenCalledWith('OpenMeta Doctor', 'Configuration is invalid');
    expect(process.exitCode).toBe(1);
  });

  test('keeps command execution working when event logging is unavailable', async () => {
    const debugSpy = spyOn(logger, 'debug').mockImplementation(() => {});
    spyOn(agentEventLogService, 'record').mockImplementation(() => {
      throw new Error('disk unavailable');
    });

    await runCommand('OpenMeta Scout', async () => {});

    expect(runHistoryService.load().records[0]?.status).toBe('success');
    expect(debugSpy).toHaveBeenCalledTimes(2);
  });
});

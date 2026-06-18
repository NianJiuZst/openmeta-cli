import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { SchedulerService } from '../src/services/scheduler.js';
import type { AppConfig } from '../src/types/index.js';

interface SchedulerTestHarness {
  sync(config: AppConfig): ReturnType<SchedulerService['sync']>;
  detectProvider(): 'launchd' | 'cron' | 'schtasks' | 'manual';
  getSchedulerContext(): { executablePath: string; entryScriptPath: string };
  readCrontab(): { content: string; error?: string };
  runCommand(
    command: string,
    args: string[],
    allowFailure?: boolean,
    input?: string,
  ): { success: boolean; status?: number | null; signal?: NodeJS.Signals | null; message?: string };
  parseScheduleTime(value: string): { hour: number; minute: number };
  buildCommandString(
    context: { executablePath: string; entryScriptPath: string },
    provider?: 'launchd' | 'cron' | 'schtasks' | 'manual',
  ): string;
  buildLaunchdPlist(options: {
    executablePath: string;
    entryScriptPath: string;
    hour: number;
    minute: number;
    stdoutPath: string;
    stderrPath: string;
    workingDirectory: string;
  }): string;
  shellEscape(value: string): string;
  windowsEscapeArg(value: string): string;
  escapeXml(value: string): string;
  getSchtasksTaskFilePath(): string;
}

let tempRoot = '';

function createIsolatedDir(): string {
  return mkdtempSync(join(tmpdir(), 'openmeta-scheduler-test-'));
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    userProfile: {
      techStack: [],
      proficiency: 'beginner',
      focusAreas: [],
    },
    github: {
      pat: 'ghp_test',
      username: 'nianjiu',
      targetRepoPath: '',
    },
    llm: {
      provider: 'openai',
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      modelName: 'gpt-4o-mini',
    },
    automation: {
      enabled: true,
      scheduleTime: '09:30',
      timezone: 'Asia/Shanghai',
      contentType: 'research_note',
      scheduler: 'cron',
      minMatchScore: 70,
      skipIfAlreadyGeneratedToday: true,
    },
    scoring: {
      weights: { freshness: 0.25, onboardingClarity: 0.25, mergePotential: 0.3, impact: 0.2, riskPenalty: 0.35 },
      overallWeights: { technicalMatch: 0.45, opportunityScore: 0.55 },
      preset: 'balanced',
    },
    commitTemplate: 'feat(daily): {{title}}\n\n{{content}}',
    ...overrides,
  };
}

describe('SchedulerService', () => {
  beforeEach(() => {
    tempRoot = createIsolatedDir();
    process.env['OPENMETA_CONFIG_DIR'] = join(tempRoot, '.config', 'openmeta');
    process.env['OPENMETA_HOME'] = join(tempRoot, '.openmeta');
  });

  afterEach(() => {
    delete process.env['OPENMETA_CONFIG_DIR'];
    delete process.env['OPENMETA_HOME'];

    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  test('parses valid schedule times and rejects invalid ones', () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;

    expect(scheduler.parseScheduleTime('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(scheduler.parseScheduleTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(() => scheduler.parseScheduleTime('9:30')).toThrow('Invalid schedule time');
    expect(() => scheduler.parseScheduleTime('24:00')).toThrow('Invalid schedule time');
  });

  test('shell-escapes command arguments and XML-escapes launchd values', () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;

    expect(scheduler.shellEscape("/tmp/it's here")).toBe("'/tmp/it'\\''s here'");
    expect(scheduler.windowsEscapeArg('C:\\Program Files\\OpenMeta\\bun.exe')).toBe('"C:\\Program Files\\OpenMeta\\bun.exe"');
    expect(scheduler.escapeXml(`A&B<"'`)).toBe('A&amp;B&lt;&quot;&apos;');
  });

  test('builds scheduler command strings with quoted executable and entry paths', () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
    const command = scheduler.buildCommandString(
      {
        executablePath: '/Applications/OpenMeta App/bin/node',
        entryScriptPath: "/tmp/OpenMeta's Agent/cli.js",
      },
      'cron',
    );

    expect(command).toContain("'/Applications/OpenMeta App/bin/node'");
    expect(command).toContain("'agent'");
    expect(command).toContain("'--headless'");
    expect(command).toContain("'--scheduler-run'");
    expect(command).toContain("'/tmp/OpenMeta'\\''s Agent/cli.js'");
  });

  test('builds windows scheduler command strings with quoted executable and entry paths', () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
    const command = scheduler.buildCommandString(
      {
        executablePath: 'C:\\Program Files\\OpenMeta\\bun.exe',
        entryScriptPath: 'C:\\Users\\tester\\OpenMeta Agent\\cli.js',
      },
      'schtasks',
    );

    expect(command).toContain('"C:\\Program Files\\OpenMeta\\bun.exe"');
    expect(command).toContain('"C:\\Users\\tester\\OpenMeta Agent\\cli.js"');
    expect(command).toContain('"agent"');
    expect(command).toContain('"--headless"');
    expect(command).toContain('"--scheduler-run"');
  });

  test('returns manual scheduler instructions when automation is enabled on unsupported platforms', async () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
    const originalDetectProvider = scheduler.detectProvider;
    const originalGetSchedulerContext = scheduler.getSchedulerContext;

    try {
      scheduler.detectProvider = () => 'manual';
      scheduler.getSchedulerContext = () => ({
        executablePath: '/usr/bin/node',
        entryScriptPath: '/tmp/openmeta-cli.js',
      });

      const result = await scheduler.sync(createConfig());

      expect(result).toEqual({
        provider: 'manual',
        status: 'manual',
        detail:
          'Automatic scheduling is not supported on this platform. Use your system scheduler to run OpenMeta agent in headless mode.',
        command: "'/usr/bin/node' '/tmp/openmeta-cli.js' 'agent' '--headless' '--scheduler-run'",
      });
    } finally {
      scheduler.detectProvider = originalDetectProvider;
      scheduler.getSchedulerContext = originalGetSchedulerContext;
    }
  });

  test('installs cron entries by replacing previous tagged lines and preserving unrelated entries', async () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
    const originalDetectProvider = scheduler.detectProvider;
    const originalGetSchedulerContext = scheduler.getSchedulerContext;
    const originalReadCrontab = scheduler.readCrontab;
    const originalRunCommand = scheduler.runCommand;
    let appliedCrontab = '';

    try {
      scheduler.detectProvider = () => 'cron';
      scheduler.getSchedulerContext = () => ({
        executablePath: '/usr/bin/node',
        entryScriptPath: '/tmp/openmeta-cli.js',
      });
      scheduler.readCrontab = () => ({
        content: [
          'MAILTO=dev@example.com',
          "0 1 * * * '/usr/bin/node' '/tmp/old.js' # openmeta-daily",
          '15 7 * * * /usr/bin/true',
        ].join('\n'),
      });
      scheduler.runCommand = (_command: string, _args: string[], _allowFailure: boolean = false, input?: string) => {
        appliedCrontab = input || '';
        return { success: true };
      };

      const result = await scheduler.sync(
        createConfig({
          automation: {
            ...createConfig().automation,
            scheduleTime: '18:05',
          },
        }),
      );

      expect(result.status).toBe('installed');
      expect(appliedCrontab).toContain('MAILTO=dev@example.com');
      expect(appliedCrontab).toContain('15 7 * * * /usr/bin/true');
      expect(appliedCrontab).toContain('5 18 * * *');
      expect(appliedCrontab).toContain("'agent' '--headless' '--scheduler-run'");
      expect(appliedCrontab).not.toContain('/tmp/old.js');
    } finally {
      scheduler.detectProvider = originalDetectProvider;
      scheduler.getSchedulerContext = originalGetSchedulerContext;
      scheduler.readCrontab = originalReadCrontab;
      scheduler.runCommand = originalRunCommand;
    }
  });

  test('removes only tagged cron entries when automation is disabled', async () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
    const originalDetectProvider = scheduler.detectProvider;
    const originalReadCrontab = scheduler.readCrontab;
    const originalRunCommand = scheduler.runCommand;
    let appliedCrontab = '';

    try {
      scheduler.detectProvider = () => 'cron';
      scheduler.readCrontab = () => ({
        content: [
          'MAILTO=dev@example.com',
          "0 1 * * * '/usr/bin/node' '/tmp/old.js' # openmeta-daily",
          '15 7 * * * /usr/bin/true',
        ].join('\n'),
      });
      scheduler.runCommand = (_command: string, _args: string[], _allowFailure: boolean = false, input?: string) => {
        appliedCrontab = input || '';
        return { success: true };
      };

      const result = await scheduler.sync(
        createConfig({
          automation: {
            ...createConfig().automation,
            enabled: false,
          },
        }),
      );

      expect(result).toEqual({
        provider: 'cron',
        status: 'removed',
        detail: 'cron automation was removed.',
      });
      expect(appliedCrontab).toContain('MAILTO=dev@example.com');
      expect(appliedCrontab).toContain('15 7 * * * /usr/bin/true');
      expect(appliedCrontab).not.toContain('# openmeta-daily');
    } finally {
      scheduler.detectProvider = originalDetectProvider;
      scheduler.readCrontab = originalReadCrontab;
      scheduler.runCommand = originalRunCommand;
    }
  });

  test('installs Windows Task Scheduler entries with a quoted command string', async () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
    const originalDetectProvider = scheduler.detectProvider;
    const originalGetSchedulerContext = scheduler.getSchedulerContext;
    const originalRunCommand = scheduler.runCommand;
    let capturedCommand = '';
    let capturedArgs: string[] = [];

    try {
      scheduler.detectProvider = () => 'schtasks';
      scheduler.getSchedulerContext = () => ({
        executablePath: 'C:\\Program Files\\OpenMeta\\bun.exe',
        entryScriptPath: 'C:\\Users\\tester\\OpenMeta Agent\\cli.js',
      });
      scheduler.runCommand = (command: string, args: string[]) => {
        capturedCommand = command;
        capturedArgs = args;
        return { success: true };
      };

      const result = await scheduler.sync(
        createConfig({
          automation: {
            ...createConfig().automation,
            scheduler: 'schtasks',
          },
        }),
      );

      expect(result).toEqual({
        provider: 'schtasks',
        status: 'installed',
        detail: 'Windows Task Scheduler will run the OpenMeta agent every day at 09:30 (Asia/Shanghai).',
        command:
          '"C:\\Program Files\\OpenMeta\\bun.exe" "C:\\Users\\tester\\OpenMeta Agent\\cli.js" "agent" "--headless" "--scheduler-run"',
      });
      expect(capturedCommand).toBe('schtasks');
      expect(capturedArgs).toEqual([
        '/Create',
        '/TN',
        'OpenMeta Daily',
        '/TR',
        '"C:\\Program Files\\OpenMeta\\bun.exe" "C:\\Users\\tester\\OpenMeta Agent\\cli.js" "agent" "--headless" "--scheduler-run"',
        '/SC',
        'DAILY',
        '/ST',
        '09:30',
        '/IT',
        '/F',
      ]);
    } finally {
      scheduler.detectProvider = originalDetectProvider;
      scheduler.getSchedulerContext = originalGetSchedulerContext;
      scheduler.runCommand = originalRunCommand;
    }
  });

  test('removes Windows Task Scheduler entries idempotently when the task is missing', async () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
    const originalDetectProvider = scheduler.detectProvider;
    const originalRunCommand = scheduler.runCommand;
    const originalPlatform = process.platform;
    const originalWindir = process.env['WINDIR'];
    const invocations: Array<{ command: string; args: string[]; allowFailure?: boolean }> = [];
    const fakeWindowsRoot = join(tempRoot, 'windows-root');

    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env['WINDIR'] = fakeWindowsRoot;
      scheduler.detectProvider = () => 'schtasks';
      scheduler.runCommand = (command: string, args: string[], allowFailure?: boolean) => {
        invocations.push({ command, args, allowFailure });
        if (args[0] === '/Query') {
          return { success: false, status: 2, message: 'ERROR: The system cannot find the file specified.' };
        }

        return { success: true };
      };

      const result = await scheduler.sync(
        createConfig({
          automation: {
            ...createConfig().automation,
            enabled: false,
            scheduler: 'schtasks',
          },
        }),
      );

      expect(result).toEqual({
        provider: 'schtasks',
        status: 'removed',
        detail: 'Windows Task Scheduler automation was removed.',
      });
      expect(invocations).toEqual([
        {
          command: 'schtasks',
          args: ['/Query', '/TN', 'OpenMeta Daily', '/HRESULT'],
          allowFailure: true,
        },
      ]);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalWindir === undefined) {
        delete process.env['WINDIR'];
      } else {
        process.env['WINDIR'] = originalWindir;
      }
      scheduler.detectProvider = originalDetectProvider;
      scheduler.runCommand = originalRunCommand;
    }
  });

  test('does not treat localized schtasks failures as missing when the task file still exists', () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
    const originalPlatform = process.platform;
    const originalWindir = process.env['WINDIR'];
    const taskFilePath = join(tempRoot, 'windows-root', 'System32', 'Tasks', 'OpenMeta Daily');

    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env['WINDIR'] = join(tempRoot, 'windows-root');
      mkdirSync(dirname(taskFilePath), { recursive: true });
      writeFileSync(taskFilePath, '<Task />', 'utf-8');

      expect(
        (scheduler as unknown as { isMissingSchtasksTask: (result: { success: boolean; status?: number | null; message?: string }) => boolean }).isMissingSchtasksTask({
          success: false,
          status: 2,
          message: 'ERROR: 系统找不到指定的文件。',
        }),
      ).toBe(false);
      expect(scheduler.getSchtasksTaskFilePath()).toBe(taskFilePath);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalWindir === undefined) {
        delete process.env['WINDIR'];
      } else {
        process.env['WINDIR'] = originalWindir;
      }
    }
  });

  test('renders launchd plist with escaped values and scheduler arguments', () => {
    const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
    const plist = scheduler.buildLaunchdPlist({
      executablePath: '/Applications/OpenMeta & Friends/bin/node',
      entryScriptPath: '/tmp/openmeta-cli.js',
      hour: 9,
      minute: 45,
      stdoutPath: join(tempRoot, 'logs', 'daily.stdout.log'),
      stderrPath: join(tempRoot, 'logs', 'daily.stderr.log'),
      workingDirectory: '/tmp/work & more',
    });

    expect(plist).toContain('<string>/Applications/OpenMeta &amp; Friends/bin/node</string>');
    expect(plist).toContain('<string>agent</string>');
    expect(plist).toContain('<string>--headless</string>');
    expect(plist).toContain('<integer>9</integer>');
    expect(plist).toContain('<integer>45</integer>');
    expect(plist).toContain('<string>/tmp/work &amp; more</string>');
  });
});

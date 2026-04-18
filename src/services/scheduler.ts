import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { configService, logger } from '../infra/index.js';
import type { AppConfig, SchedulerProvider } from '../types/index.js';

const LAUNCHD_LABEL = 'com.openmeta.daily';
const CRON_TAG = '# openmeta-daily';
const DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

type SchedulerSyncStatus = 'installed' | 'removed' | 'manual' | 'failed';

interface SchedulerContext {
  executablePath: string;
  entryScriptPath: string;
}

interface CommandResult {
  success: boolean;
  message?: string;
}

export interface SchedulerSyncResult {
  provider: SchedulerProvider;
  status: SchedulerSyncStatus;
  detail: string;
  location?: string;
  command?: string;
}

export class SchedulerService {
  detectProvider(): SchedulerProvider {
    if (process.platform === 'darwin') {
      return 'launchd';
    }

    if (process.platform === 'linux') {
      return 'cron';
    }

    return 'manual';
  }

  async sync(config: AppConfig): Promise<SchedulerSyncResult> {
    const provider = this.detectProvider();

    if (!config.automation.enabled) {
      return this.uninstall(provider);
    }

    if (provider === 'manual') {
      const context = this.getSchedulerContext();
      return {
        provider,
        status: 'manual',
        detail: 'Automatic scheduling is not supported on this platform. Use your system scheduler to run OpenMeta agent in headless mode.',
        command: this.buildCommandString(context),
      };
    }

    const context = this.getSchedulerContext();
    return provider === 'launchd'
      ? this.installLaunchd(config, context)
      : this.installCron(config, context);
  }

  private uninstall(provider: SchedulerProvider): SchedulerSyncResult {
    if (provider === 'launchd') {
      return this.uninstallLaunchd();
    }

    if (provider === 'cron') {
      return this.uninstallCron();
    }

    return {
      provider,
      status: 'removed',
      detail: 'Automatic scheduling is disabled.',
    };
  }

  private installLaunchd(config: AppConfig, context: SchedulerContext): SchedulerSyncResult {
    const { hour, minute } = this.parseScheduleTime(config.automation.scheduleTime);
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const logDir = this.getLogDir();
    const stdoutPath = join(logDir, 'daily.stdout.log');
    const stderrPath = join(logDir, 'daily.stderr.log');

    mkdirSync(dirname(plistPath), { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFileSync(
      plistPath,
      this.buildLaunchdPlist({
        executablePath: context.executablePath,
        entryScriptPath: context.entryScriptPath,
        hour,
        minute,
        stdoutPath,
        stderrPath,
        workingDirectory: homedir(),
      }),
      'utf-8',
    );

    const userId = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const errors: string[] = [];

    if (userId !== undefined) {
      this.runCommand('launchctl', ['bootout', `gui/${userId}`, plistPath], true);
      const bootstrap = this.runCommand('launchctl', ['bootstrap', `gui/${userId}`, plistPath], true);

      if (bootstrap.success) {
        this.runCommand('launchctl', ['enable', `gui/${userId}/${LAUNCHD_LABEL}`], true);
        return {
          provider: 'launchd',
          status: 'installed',
          detail: `launchd will run the OpenMeta agent every day at ${config.automation.scheduleTime} (${config.automation.timezone}).`,
          location: plistPath,
          command: this.buildCommandString(context),
        };
      }

      if (bootstrap.message) {
        errors.push(bootstrap.message);
      }
    }

    this.runCommand('launchctl', ['unload', '-w', plistPath], true);
    const load = this.runCommand('launchctl', ['load', '-w', plistPath], true);
    if (load.success) {
      return {
        provider: 'launchd',
        status: 'installed',
        detail: `launchd will run the OpenMeta agent every day at ${config.automation.scheduleTime} (${config.automation.timezone}).`,
        location: plistPath,
        command: this.buildCommandString(context),
      };
    }

    if (load.message) {
      errors.push(load.message);
    }

    return {
      provider: 'launchd',
      status: 'failed',
      detail: `launchd job file was written, but it could not be loaded automatically: ${errors.filter(Boolean).join(' | ') || 'unknown launchctl error'}`,
      location: plistPath,
      command: this.buildCommandString(context),
    };
  }

  private uninstallLaunchd(): SchedulerSyncResult {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const userId = typeof process.getuid === 'function' ? process.getuid() : undefined;

    if (!existsSync(plistPath)) {
      return {
        provider: 'launchd',
        status: 'removed',
        detail: 'Automatic scheduling is disabled.',
      };
    }

    if (userId !== undefined) {
      this.runCommand('launchctl', ['bootout', `gui/${userId}`, plistPath], true);
    } else {
      this.runCommand('launchctl', ['unload', '-w', plistPath], true);
    }

    rmSync(plistPath, { force: true });

    return {
      provider: 'launchd',
      status: 'removed',
      detail: 'launchd automation was removed.',
      location: plistPath,
    };
  }

  private installCron(config: AppConfig, context: SchedulerContext): SchedulerSyncResult {
    const { hour, minute } = this.parseScheduleTime(config.automation.scheduleTime);
    const currentCron = this.readCrontab();

    if (currentCron.error) {
      return {
        provider: 'cron',
        status: 'failed',
        detail: currentCron.error,
        command: this.buildCommandString(context),
      };
    }

    const logDir = this.getLogDir();
    const stdoutPath = join(logDir, 'daily.stdout.log');
    const stderrPath = join(logDir, 'daily.stderr.log');

    mkdirSync(logDir, { recursive: true });

    const cronLine = `${minute} ${hour} * * * PATH=${this.shellEscape(process.env['PATH'] || DEFAULT_PATH)} HOME=${this.shellEscape(homedir())} ${this.buildCommandString(context)} >> ${this.shellEscape(stdoutPath)} 2>> ${this.shellEscape(stderrPath)} ${CRON_TAG}`;

    const lines = currentCron.content
      .split(/\r?\n/)
      .filter(line => Boolean(line.trim()) && !line.includes(CRON_TAG));
    lines.push(cronLine);

    const updatedContent = `${lines.join('\n')}\n`;
    const applyResult = this.runCommand('crontab', ['-'], false, updatedContent);

    if (!applyResult.success) {
      return {
        provider: 'cron',
        status: 'failed',
        detail: `Cron entry could not be installed: ${applyResult.message || 'unknown crontab error'}`,
        command: this.buildCommandString(context),
      };
    }

    return {
      provider: 'cron',
      status: 'installed',
      detail: `cron will run the OpenMeta agent every day at ${config.automation.scheduleTime} (${config.automation.timezone}).`,
      command: this.buildCommandString(context),
    };
  }

  private uninstallCron(): SchedulerSyncResult {
    const currentCron = this.readCrontab();

    if (currentCron.error) {
      return {
        provider: 'cron',
        status: 'failed',
        detail: currentCron.error,
      };
    }

    const filteredLines = currentCron.content
      .split(/\r?\n/)
      .filter(line => Boolean(line.trim()) && !line.includes(CRON_TAG));

    const updatedContent = filteredLines.length > 0 ? `${filteredLines.join('\n')}\n` : '';
    const applyResult = this.runCommand('crontab', ['-'], false, updatedContent);

    if (!applyResult.success) {
      return {
        provider: 'cron',
        status: 'failed',
        detail: `Cron entry could not be removed: ${applyResult.message || 'unknown crontab error'}`,
      };
    }

    return {
      provider: 'cron',
      status: 'removed',
      detail: 'cron automation was removed.',
    };
  }

  private readCrontab(): { content: string; error?: string } {
    const result = spawnSync('crontab', ['-l'], { encoding: 'utf-8' });

    if (result.error) {
      return {
        content: '',
        error: `Unable to access crontab: ${result.error.message}`,
      };
    }

    if (result.status === 0) {
      return {
        content: result.stdout || '',
      };
    }

    const stderr = result.stderr || '';
    if (/no crontab for/i.test(stderr)) {
      return { content: '' };
    }

    return {
      content: '',
      error: `Unable to read current crontab: ${stderr.trim() || 'unknown error'}`,
    };
  }

  private runCommand(
    command: string,
    args: string[],
    allowFailure: boolean = false,
    input?: string,
  ): CommandResult {
    const result = spawnSync(command, args, {
      encoding: 'utf-8',
      input,
    });

    if (result.error) {
      if (!allowFailure) {
        logger.debug(`${command} failed`, result.error);
      }
      return {
        success: false,
        message: result.error.message,
      };
    }

    if (result.status !== 0) {
      const message = result.stderr?.trim() || result.stdout?.trim() || `exit status ${result.status}`;
      if (!allowFailure) {
        logger.debug(`${command} ${args.join(' ')} failed`, message);
      }
      return {
        success: false,
        message,
      };
    }

    return { success: true };
  }

  private getSchedulerContext(): SchedulerContext {
    const executablePath = resolve(process.execPath);
    const entryScript = process.argv[1];

    if (!entryScript) {
      throw new Error('Unable to resolve the OpenMeta CLI entry script for automation setup.');
    }

    return {
      executablePath,
      entryScriptPath: resolve(entryScript),
    };
  }

  private buildCommandString(context: SchedulerContext): string {
    return [
      context.executablePath,
      context.entryScriptPath,
      'agent',
      '--headless',
      '--scheduler-run',
    ].map(value => this.shellEscape(value)).join(' ');
  }

  private parseScheduleTime(value: string): { hour: number; minute: number } {
    const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    const hourValue = match?.[1];
    const minuteValue = match?.[2];

    if (!hourValue || !minuteValue) {
      throw new Error(`Invalid schedule time "${value}". Expected HH:mm.`);
    }

    return {
      hour: Number.parseInt(hourValue, 10),
      minute: Number.parseInt(minuteValue, 10),
    };
  }

  private getLogDir(): string {
    return join(dirname(configService.getConfigPath()), 'logs');
  }

  private buildLaunchdPlist(options: {
    executablePath: string;
    entryScriptPath: string;
    hour: number;
    minute: number;
    stdoutPath: string;
    stderrPath: string;
    workingDirectory: string;
  }): string {
    const pathValue = this.escapeXml(process.env['PATH'] || DEFAULT_PATH);

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${this.escapeXml(options.executablePath)}</string>
    <string>${this.escapeXml(options.entryScriptPath)}</string>
    <string>agent</string>
    <string>--headless</string>
    <string>--scheduler-run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${this.escapeXml(options.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathValue}</string>
    <key>HOME</key>
    <string>${this.escapeXml(homedir())}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${options.hour}</integer>
    <key>Minute</key>
    <integer>${options.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${this.escapeXml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${this.escapeXml(options.stderrPath)}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

export const schedulerService = new SchedulerService();

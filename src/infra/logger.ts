import chalk from 'chalk';

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

export class Logger {
  private prefix: string;
  private debugEnabled: boolean;

  constructor(prefix: string = '') {
    this.prefix = prefix;
    this.debugEnabled = process.env['OPENMETA_DEBUG'] === '1';
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (level === 'debug' && !this.debugEnabled) {
      return;
    }

    const timestamp = new Date().toISOString().split('T')[1]?.slice(0, 8) || '';
    const prefix = this.prefix ? `[${this.prefix}] ` : '';

    const format: Record<LogLevel, string> = {
      info: chalk.blue('[INFO]'),
      success: chalk.green('[SUCCESS]'),
      warn: chalk.yellow('[WARN]'),
      error: chalk.red('[ERROR]'),
      debug: chalk.gray('[DEBUG]'),
    };

    const renderedArgs = args
      .map((arg) => this.renderArg(arg))
      .filter((arg): arg is string => arg.length > 0);

    console.log(`${chalk.gray(timestamp)} ${format[level]} ${prefix}${message}`, ...renderedArgs);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args);
  }

  success(message: string, ...args: unknown[]): void {
    this.log('success', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args);
  }

  private renderArg(arg: unknown): string {
    if (arg instanceof Error) {
      if (this.debugEnabled && arg.stack) {
        return `\n${arg.stack}`;
      }

      return arg.message;
    }

    if (typeof arg === 'string') {
      return arg;
    }

    if (arg === null || arg === undefined) {
      return '';
    }

    try {
      return this.debugEnabled ? JSON.stringify(arg, null, 2) : '';
    } catch {
      return this.debugEnabled ? String(arg) : '';
    }
  }
}

export const logger = new Logger();

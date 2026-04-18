import chalk from 'chalk';
import { stripAnsi } from './layout.js';
import type { TaskOptions, Tone, UiCapabilities } from './types.js';

const FRAMES = ['-', '\\', '|', '/'];

function toneColor(tone: Tone): (text: string) => string {
  switch (tone) {
    case 'success':
      return chalk.greenBright;
    case 'warning':
      return chalk.yellowBright;
    case 'error':
      return chalk.redBright;
    case 'muted':
      return chalk.gray;
    case 'accent':
      return chalk.magentaBright;
    case 'info':
    default:
      return chalk.cyanBright;
  }
}

function renderStatusLine(symbol: string, message: string, color: (text: string) => string): string {
  return color(`${symbol} ${message}`);
}

export async function runTask<T>(
  capabilities: UiCapabilities,
  options: TaskOptions,
  task: () => Promise<T>,
): Promise<T> {
  const tone = options.tone ?? 'info';
  const color = toneColor(tone);

  if (!capabilities.isInteractive || capabilities.mode === 'plain') {
    process.stdout.write(`${renderStatusLine('[>]', options.title, color)}\n`);
    try {
      const result = await task();
      process.stdout.write(`${renderStatusLine('[success]', options.doneMessage || options.title, chalk.greenBright)}\n`);
      return result;
    } catch (error) {
      process.stdout.write(`${renderStatusLine('[x]', options.failedMessage || options.title, chalk.redBright)}\n`);
      throw error;
    }
  }

  let frameIndex = 0;
  const writeFrame = (text: string) => {
    const line = renderStatusLine(`[${FRAMES[frameIndex]}]`, text, color);
    frameIndex = (frameIndex + 1) % FRAMES.length;
    process.stdout.write(`\r${line}`);
    const remainder = Math.max(0, capabilities.width - stripAnsi(line).length);
    if (remainder > 0) {
      process.stdout.write(' '.repeat(remainder));
    }
  };

  writeFrame(options.title);
  const timer = setInterval(() => writeFrame(options.title), 90);

  try {
    const result = await task();
    clearInterval(timer);
    if (typeof process.stdout.clearLine === 'function') {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    } else {
      process.stdout.write('\r');
    }
    process.stdout.write(`${renderStatusLine('[success]', options.doneMessage || options.title, chalk.greenBright)}\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    if (typeof process.stdout.clearLine === 'function') {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    } else {
      process.stdout.write('\r');
    }
    process.stdout.write(`${renderStatusLine('[x]', options.failedMessage || options.title, chalk.redBright)}\n`);
    throw error;
  }
}

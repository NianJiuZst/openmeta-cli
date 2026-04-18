import * as p from '@clack/prompts';
import boxen from 'boxen';
import chalk from 'chalk';
import figures from 'figures';
import gradient from 'gradient-string';
import { getOpenMetaWordmarkLines } from './brand.js';
import { getUiCapabilities } from './capabilities.js';
import { padLine, visibleLength, wrapLine } from './layout.js';
import { runTask } from './live.js';
import type {
  CardOptions,
  KeyValueItem,
  MetricItem,
  RecordItem,
  StepItem,
  StepState,
  TaskOptions,
  TimelineItem,
  Tone,
  UiCapabilities,
} from './types.js';

type CardVariant = 'standard' | 'callout';

interface TonePalette {
  accent: typeof chalk.cyanBright;
  muted: typeof chalk.gray;
  borderColor: string;
}

function paletteForTone(tone: Tone): TonePalette {
  switch (tone) {
    case 'success':
      return {
        accent: chalk.greenBright,
        muted: chalk.green,
        borderColor: 'green',
      };
    case 'warning':
      return {
        accent: chalk.yellowBright,
        muted: chalk.yellow,
        borderColor: 'yellow',
      };
    case 'error':
      return {
        accent: chalk.redBright,
        muted: chalk.red,
        borderColor: 'red',
      };
    case 'muted':
      return {
        accent: chalk.white,
        muted: chalk.gray,
        borderColor: 'gray',
      };
    case 'accent':
      return {
        accent: chalk.magentaBright,
        muted: chalk.magenta,
        borderColor: 'magenta',
      };
    case 'info':
    default:
      return {
        accent: chalk.cyanBright,
        muted: chalk.cyan,
        borderColor: 'cyan',
      };
  }
}

function genericCommandLabel(label?: string): boolean {
  return Boolean(label && /^openmeta(\s|$)/i.test(label));
}

function statusSymbol(state: StepState): string {
  switch (state) {
    case 'done':
      return `${figures.tick} [success]`;
    case 'active':
      return `${figures.pointerSmall} [active]`;
    case 'error':
      return `${figures.cross} [error]`;
    case 'pending':
    default:
      return `${figures.ellipsis} [pending]`;
  }
}

function statusColor(state: StepState): (text: string) => string {
  switch (state) {
    case 'done':
      return chalk.greenBright;
    case 'active':
      return chalk.cyanBright;
    case 'error':
      return chalk.redBright;
    case 'pending':
    default:
      return chalk.gray;
  }
}

function printBlankLine(): void {
  process.stdout.write('\n');
}

function clackLines(lines: string | string[]): void {
  p.log.message(lines, {
    symbol: ' ',
    withGuide: false,
  });
}

function renderPrefixedLines(
  text: string,
  width: number,
  prefix: string,
  continuationPrefix: string,
): string[] {
  const wrapped = wrapLine(text, Math.max(12, width - visibleLength(prefix)));
  return wrapped.map((line, index) => `${index === 0 ? prefix : continuationPrefix}${line}`);
}

function renderBrandMark(capabilities: UiCapabilities, tone: Tone = 'accent'): string[] {
  const lines = getOpenMetaWordmarkLines();
  const gradientForTone = (() => {
    switch (tone) {
      case 'success':
        return gradient(['#d9fff0', '#42d392', '#14b8a6']);
      case 'warning':
        return gradient(['#fff1c2', '#ffb84d', '#ff8a00']);
      case 'error':
        return gradient(['#ffd6d6', '#ff6b6b', '#ff3b3b']);
      case 'muted':
        return gradient(['#fafafa', '#d4d4d8', '#a1a1aa']);
      case 'accent':
        return gradient(['#67e8f9', '#60a5fa', '#c084fc', '#f472b6']);
      case 'info':
      default:
        return gradient(['#a5f3fc', '#38bdf8', '#818cf8']);
    }
  })();

  if (!capabilities.supportsColor) {
    return lines;
  }

  return gradientForTone.multiline(lines.join('\n')).split('\n').map((line) => chalk.bold(line));
}

function renderRule(capabilities: UiCapabilities, tone: Tone, width: number): string {
  const chars = capabilities.supportsUnicode ? '─' : '-';
  return paletteForTone(tone).muted(chars.repeat(Math.max(18, width)));
}

function buildCardText(capabilities: UiCapabilities, options: CardOptions, variant: CardVariant): string {
  const tone = options.tone ?? 'info';
  const palette = paletteForTone(tone);
  const width = Math.max(38, Math.min(capabilities.width - 14, 88));
  const rows: string[] = [];

  if (options.label && !genericCommandLabel(options.label)) {
    rows.push(chalk.dim(options.label.toUpperCase()));
  }

  rows.push(palette.accent(`${figures.pointerSmall} ${options.title}`));

  if (options.subtitle) {
    rows.push(...wrapLine(options.subtitle, width).map((line) => chalk.gray(line)));
  }

  if (options.lines && options.lines.length > 0) {
    if (variant === 'callout') {
      rows.push(chalk.gray(renderRule(capabilities, tone, Math.min(24, width))));
    }

    rows.push(...options.lines.flatMap((line) => renderPrefixedLines(
      line,
      width,
      `${figures.bullet} `,
      '  ',
    )));
  }

  return rows.join('\n');
}

function printCard(capabilities: UiCapabilities, options: CardOptions, variant: CardVariant = 'standard'): void {
  const tone = options.tone ?? 'info';
  const palette = paletteForTone(tone);
  const content = buildCardText(capabilities, options, variant);

  printBlankLine();
  process.stdout.write(`${boxen(content, {
    borderColor: capabilities.supportsColor ? palette.borderColor : undefined,
    borderStyle: capabilities.supportsUnicode ? (variant === 'callout' ? 'double' : 'round') : 'single',
    padding: { top: 0, right: 1, bottom: 0, left: 1 },
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
    width: Math.max(54, Math.min(capabilities.width, 96)),
    title: options.label && !genericCommandLabel(options.label) ? ` ${options.label.toUpperCase()} ` : undefined,
    titleAlignment: 'left',
  })}\n`);
}

function printHero(capabilities: UiCapabilities, options: CardOptions): void {
  const tone = options.tone ?? 'accent';
  const width = Math.max(40, Math.min(capabilities.width - 2, 96));
  const bullet = figures.pointerSmall;
  const rule = renderRule(capabilities, tone, Math.min(width, 36));
  const palette = paletteForTone(tone);

  printBlankLine();
  clackLines(renderBrandMark(capabilities, tone));
  clackLines(palette.accent(options.title));

  if (options.subtitle) {
    clackLines(wrapLine(options.subtitle, width).map((line) => chalk.gray(line)));
  }

  if (options.lines && options.lines.length > 0) {
    clackLines(chalk.gray(rule));
    const rendered = options.lines.flatMap((entry) => renderPrefixedLines(
      entry,
      width - 2,
      `${bullet} `,
      '  ',
    )).map((line) => line.startsWith(`${bullet} `)
      ? `${palette.accent(bullet)} ${chalk.white(line.slice(2))}`
      : `  ${chalk.white(line.trimStart())}`);
    clackLines(rendered);
  }
}

function printCelebration(capabilities: UiCapabilities, options: CardOptions): void {
  const tone = options.tone ?? 'success';
  const width = Math.max(40, Math.min(capabilities.width - 2, 96));
  const rule = renderRule(capabilities, tone, Math.min(width, 42));
  const palette = paletteForTone(tone);
  const symbol = tone === 'success' ? figures.tick : tone === 'warning' ? figures.warning : figures.info;

  printBlankLine();
  clackLines(chalk.gray(rule));
  clackLines(renderBrandMark(capabilities, tone));
  if (options.subtitle) {
    clackLines(wrapLine(options.subtitle, width).map((line) => chalk.gray(line)));
  }

  const rendered = (options.lines ?? []).flatMap((entry) => renderPrefixedLines(
      entry,
      width - 2,
      `${figures.pointerSmall} `,
      '  ',
    )).map((line) => line.startsWith(`${figures.pointerSmall} `)
    ? `${palette.accent(figures.pointerSmall)} ${chalk.white(line.slice(2))}`
    : `  ${chalk.white(line.trimStart())}`);
  if (rendered.length > 0) {
    clackLines(rendered);
  }
  clackLines(chalk.gray(rule));
  p.log.success(options.title, {
    symbol,
    withGuide: false,
  });
}

function printSection(capabilities: UiCapabilities, title: string, subtitle?: string): void {
  const width = Math.max(44, Math.min(capabilities.width - 2, 106));
  const rule = capabilities.supportsUnicode ? '─'.repeat(Math.max(10, width - visibleLength(title) - 6)) : '-'.repeat(Math.max(10, width - visibleLength(title) - 6));

  printBlankLine();
  process.stdout.write(`${chalk.cyanBright.bold(`${figures.line} ${title}`)} ${chalk.gray(rule)}\n`);
  if (subtitle) {
    for (const line of wrapLine(subtitle, width)) {
      process.stdout.write(`${chalk.gray(line)}\n`);
    }
  }
}

function printList(lines: string[], tone: Tone = 'muted'): void {
  const accent = paletteForTone(tone).accent;
  for (const line of lines) {
    process.stdout.write(`${accent(figures.pointerSmall)} ${chalk.gray(line)}\n`);
  }
}

function printKeyValues(capabilities: UiCapabilities, title: string, items: KeyValueItem[]): void {
  const width = Math.max(44, Math.min(capabilities.width - 2, 106));
  const labelWidth = Math.min(24, Math.max(...items.map((item) => item.label.length), 12));
  printSection(capabilities, title);

  for (const item of items) {
    const label = chalk.gray(item.label.padEnd(labelWidth));
    const valueColor = paletteForTone(item.tone ?? 'info').accent;
    const available = Math.max(20, width - labelWidth - 4);
    const wrapped = wrapLine(item.value, available);

    wrapped.forEach((line, index) => {
      const renderedLabel = index === 0 ? `${figures.pointerSmall} ${label}` : `  ${' '.repeat(labelWidth)}`;
      process.stdout.write(`  ${renderedLabel} ${valueColor(line)}\n`);
    });
  }
}

function printStats(capabilities: UiCapabilities, title: string, items: MetricItem[]): void {
  printSection(capabilities, title);
  const columns = capabilities.mode === 'interactive-rich' && capabilities.width >= 96 ? 3 : 2;
  const width = Math.max(44, Math.min(capabilities.width - 2, 106));
  const cardWidth = Math.max(18, Math.floor((width - ((columns - 1) * 3)) / columns));
  const rows: string[][] = [];

  for (let index = 0; index < items.length; index += columns) {
    rows.push(items.slice(index, index + columns).map((item) => {
      const palette = paletteForTone(item.tone ?? 'accent');
      const value = palette.accent(chalk.bold(item.value));
      const hint = item.hint ? chalk.gray(` ${item.hint}`) : '';
      return `${value}${hint}\n${chalk.gray(item.label)}`;
    }));
  }

  for (const row of rows) {
    const firstLine = row.map((entry) => {
      const [value] = entry.split('\n');
      return padLine(value || '', cardWidth);
    }).join('   ');
    const secondLine = row.map((entry) => {
      const [, label] = entry.split('\n');
      return padLine(label || '', cardWidth);
    }).join('   ');
    process.stdout.write(`  ${firstLine}\n`);
    process.stdout.write(`  ${secondLine}\n`);
  }
}

function printStepper(capabilities: UiCapabilities, title: string, steps: StepItem[]): void {
  printSection(capabilities, title);

  for (const [index, step] of steps.entries()) {
    const color = statusColor(step.state);
    const symbol = color(statusSymbol(step.state));
    const prefix = chalk.gray(`${String(index + 1).padStart(2, '0')}.`);
    process.stdout.write(`  ${prefix} ${symbol} ${chalk.white(step.label)}\n`);
    if (step.description) {
      for (const line of wrapLine(step.description, Math.max(36, capabilities.width - 14))) {
        process.stdout.write(`      ${chalk.gray(line)}\n`);
      }
    }
  }
}

function printTimeline(capabilities: UiCapabilities, title: string, items: TimelineItem[]): void {
  printSection(capabilities, title);

  for (const item of items) {
    const color = statusColor(item.state);
    process.stdout.write(`  ${color(statusSymbol(item.state))} ${chalk.white(item.title)}${item.meta ? chalk.gray(`  ${item.meta}`) : ''}\n`);
    if (item.subtitle) {
      for (const line of wrapLine(item.subtitle, Math.max(36, capabilities.width - 12))) {
        process.stdout.write(`      ${chalk.gray(line)}\n`);
      }
    }
  }
}

function printRecordList(capabilities: UiCapabilities, title: string, items: RecordItem[]): void {
  printSection(capabilities, title);

  for (const item of items) {
    const accent = paletteForTone(item.tone ?? 'info').accent;
    process.stdout.write(`  ${accent(figures.bullet)} ${accent(item.title)}\n`);
    if (item.subtitle) {
      for (const line of wrapLine(item.subtitle, Math.max(36, capabilities.width - 10))) {
        process.stdout.write(`      ${chalk.gray(line)}\n`);
      }
    }
    if (item.meta && item.meta.length > 0) {
      process.stdout.write(`      ${chalk.gray(item.meta.join(' | '))}\n`);
    }
    if (item.lines) {
      for (const line of item.lines) {
        process.stdout.write(`      ${line}\n`);
      }
    }
  }
}

function makeBadge(label: string, tone: Tone = 'info'): string {
  return paletteForTone(tone).accent(`[${label}]`);
}

function maskSecret(secret?: string): string {
  if (!secret) {
    return '(not set)';
  }

  if (secret.length <= 4) {
    return '****';
  }

  return `***${secret.slice(-4)}`;
}

function completionCopy(commandName: string): Pick<CardOptions, 'title' | 'subtitle' | 'lines' | 'tone'> {
  switch (commandName) {
    case 'OpenMeta Agent':
      return {
        title: 'The contribution arc resolved with a clean finish',
        subtitle: 'The field, the repository, and the artifact trail now sit in one readable line of motion.',
        lines: [
          'Pick up the next move only if it still feels sharper than stopping here.',
        ],
        tone: 'success',
      };
    case 'OpenMeta Init':
      return {
        title: 'The cockpit is calibrated and ready',
        subtitle: 'Identity, model, profile, and automation posture now move as one system.',
        lines: [
          'The next run can begin without re-explaining yourself to the machine.',
        ],
        tone: 'success',
      };
    case 'OpenMeta Scout':
      return {
        title: 'The noise has been cut into a usable shortlist',
        subtitle: 'You now have a field worth choosing from, not just a pile worth scanning.',
        lines: [
          'Start where the signal is strongest, not where the list is longest.',
        ],
        tone: 'success',
      };
    case 'OpenMeta Config':
      return {
        title: 'The control surface is steady and legible',
        subtitle: 'Configuration output finished in a state you can inspect at a glance.',
        lines: [
          'What matters is now visible without spelunking through raw JSON.',
        ],
        tone: 'success',
      };
    case 'OpenMeta Automation':
      return {
        title: 'The unattended cadence is now in tune',
        subtitle: 'Scheduler state and local intent are no longer drifting apart.',
        lines: [
          'Leave the loop quiet, or let it keep moving in the background.',
        ],
        tone: 'success',
      };
    case 'OpenMeta Inbox':
      return {
        title: 'The shortlist is staged for a fast return',
        subtitle: 'The most promising drafted opportunities are now easy to revisit without friction.',
        lines: [
          'Come back when you want the next smart entry point, not another search session.',
        ],
        tone: 'success',
      };
    case 'OpenMeta PoW':
      return {
        title: 'The work trail is closed into a readable ledger',
        subtitle: 'The record above can now be reviewed like a narrative instead of a dump.',
        lines: [
          'Momentum is easier to trust when the trail stays legible.',
        ],
        tone: 'success',
      };
    default:
      return {
        title: 'Execution settled into a clean end state',
        subtitle: 'The terminal is back in a readable, stable posture.',
        lines: [
          'Nothing is fighting for attention anymore.',
        ],
        tone: 'success',
      };
  }
}

const capabilities = getUiCapabilities();

export const ui = {
  banner(options: CardOptions): void {
    printCard(capabilities, options);
  },

  hero(options: CardOptions): void {
    printHero(capabilities, {
      ...options,
      tone: options.tone ?? 'accent',
    });
  },

  card(options: CardOptions): void {
    printCard(capabilities, options);
  },

  callout(options: CardOptions): void {
    printCard(capabilities, options, 'callout');
  },

  section(title: string, subtitle?: string): void {
    printSection(capabilities, title, subtitle);
  },

  list(lines: string[], tone: Tone = 'muted'): void {
    printList(lines, tone);
  },

  keyValues(title: string, items: KeyValueItem[]): void {
    printKeyValues(capabilities, title, items);
  },

  stats(title: string, items: MetricItem[]): void {
    printStats(capabilities, title, items);
  },

  stepper(title: string, steps: StepItem[]): void {
    printStepper(capabilities, title, steps);
  },

  timeline(title: string, items: TimelineItem[]): void {
    printTimeline(capabilities, title, items);
  },

  recordList(title: string, items: RecordItem[]): void {
    printRecordList(capabilities, title, items);
  },

  badge(label: string, tone: Tone = 'info'): string {
    return makeBadge(label, tone);
  },

  maskSecret(secret?: string): string {
    return maskSecret(secret);
  },

  commandCompleted(commandName: string): void {
    printCelebration(capabilities, completionCopy(commandName));
  },

  async task<T>(options: TaskOptions, task: () => Promise<T>): Promise<T> {
    return runTask(capabilities, options, task);
  },

  commandCancelled(_commandName: string): void {
    p.log.warn('The session was closed before the line finished.', {
      symbol: figures.warning,
      withGuide: false,
    });
    clackLines([
      chalk.gray('Nothing was written, nothing was published, and the terminal remains in a safe state.'),
    ]);
  },

  commandFailed(_commandName: string, message: string): void {
    p.log.error('The run broke out of its intended path.', {
      symbol: figures.cross,
      withGuide: false,
    });
    p.log.error(message, {
      withGuide: false,
    });
    clackLines([
      chalk.gray('Inspect the blocking edge, fix it cleanly, then run again from a stable state.'),
    ]);
  },

  emptyState(_commandName: string, title: string, subtitle: string): void {
    printCard(capabilities, {
      title,
      subtitle,
      tone: 'warning',
    }, 'callout');
  },
};

export type {
  CardOptions,
  KeyValueItem,
  MetricItem,
  RecordItem,
  StepItem,
  StepState,
  TaskOptions,
  TimelineItem,
  Tone,
} from './types.js';

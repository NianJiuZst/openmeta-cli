import * as p from '@clack/prompts';
import chalk from 'chalk';
import figures from 'figures';
import type { TaskController, TaskOptions, Tone, UiCapabilities } from './types.js';

function toneColor(tone: Tone): 'green' | 'yellow' | 'red' | 'magenta' | 'white' | 'cyan' {
	switch (tone) {
		case 'success':
			return 'green';
		case 'warning':
			return 'yellow';
		case 'error':
			return 'red';
		case 'accent':
			return 'magenta';
		case 'muted':
			return 'white';
		default:
			return 'cyan';
	}
}

function renderInlineStatus(symbol: string, text: string, tone: Tone): string {
	const color = toneColor(tone);

	switch (color) {
		case 'green':
			return chalk.greenBright(`${symbol} ${text}`);
		case 'yellow':
			return chalk.yellowBright(`${symbol} ${text}`);
		case 'red':
			return chalk.redBright(`${symbol} ${text}`);
		case 'magenta':
			return chalk.magentaBright(`${symbol} ${text}`);
		case 'white':
			return chalk.white(`${symbol} ${text}`);
		default:
			return chalk.cyanBright(`${symbol} ${text}`);
	}
}

export async function runTask<T>(
	capabilities: UiCapabilities,
	options: TaskOptions,
	task: (controller: TaskController) => Promise<T>,
): Promise<T> {
	const tone = options.tone ?? 'info';
	const controller: TaskController = {
		setMessage(_message: string): void {
			// no-op by default; interactive mode replaces this with spinner.message(...)
		},
	};

	if (!capabilities.isInteractive || capabilities.mode === 'plain') {
		process.stdout.write(`${renderInlineStatus(figures.pointerSmall, options.title, tone)}\n`);
		try {
			const result = await task(controller);
			process.stdout.write(
				`${renderInlineStatus(figures.tick, `[success] ${options.doneMessage || options.title}`, 'success')}\n`,
			);
			return result;
		} catch (error) {
			process.stdout.write(
				`${renderInlineStatus(figures.cross, options.failedMessage || options.title, 'error')}\n`,
			);
			throw error;
		}
	}

	const spinner = p.spinner({
		indicator: capabilities.supportsUnicode ? 'dots' : 'timer',
	});
	spinner.start(options.title);
	controller.setMessage = (message: string) => {
		spinner.message(message);
	};

	try {
		const result = await task(controller);
		spinner.stop(`${figures.tick} [success] ${options.doneMessage || options.title}`);
		return result;
	} catch (error) {
		spinner.error(`${figures.cross} [error] ${options.failedMessage || options.title}`);
		throw error;
	}
}

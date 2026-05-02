import * as p from "@clack/prompts";
import chalk from "chalk";
import figures from "figures";
import type { TaskOptions, Tone, UiCapabilities } from "./types.js";

function toneColor(
	tone: Tone,
): "green" | "yellow" | "red" | "magenta" | "white" | "cyan" {
	switch (tone) {
		case "success":
			return "green";
		case "warning":
			return "yellow";
		case "error":
			return "red";
		case "accent":
			return "magenta";
		case "muted":
			return "white";
		case "info":
		default:
			return "cyan";
	}
}

function renderInlineStatus(symbol: string, text: string, tone: Tone): string {
	const color = toneColor(tone);

	switch (color) {
		case "green":
			return chalk.greenBright(`${symbol} ${text}`);
		case "yellow":
			return chalk.yellowBright(`${symbol} ${text}`);
		case "red":
			return chalk.redBright(`${symbol} ${text}`);
		case "magenta":
			return chalk.magentaBright(`${symbol} ${text}`);
		case "white":
			return chalk.white(`${symbol} ${text}`);
		case "cyan":
		default:
			return chalk.cyanBright(`${symbol} ${text}`);
	}
}

export async function runTask<T>(
	capabilities: UiCapabilities,
	options: TaskOptions,
	task: () => Promise<T>,
): Promise<T> {
	const tone = options.tone ?? "info";

	if (!capabilities.isInteractive || capabilities.mode === "plain") {
		process.stdout.write(
			`${renderInlineStatus(figures.pointerSmall, options.title, tone)}\n`,
		);
		try {
			const result = await task();
			process.stdout.write(
				`${renderInlineStatus(figures.tick, `[success] ${options.doneMessage || options.title}`, "success")}\n`,
			);
			return result;
		} catch (error) {
			process.stdout.write(
				`${renderInlineStatus(figures.cross, options.failedMessage || options.title, "error")}\n`,
			);
			throw error;
		}
	}

	const spinner = p.spinner({
		indicator: capabilities.supportsUnicode ? "dots" : "timer",
	});
	spinner.start(options.title);

	try {
		const result = await task();
		spinner.stop(
			`${figures.tick} [success] ${options.doneMessage || options.title}`,
		);
		return result;
	} catch (error) {
		spinner.error(
			`${figures.cross} [error] ${options.failedMessage || options.title}`,
		);
		throw error;
	}
}

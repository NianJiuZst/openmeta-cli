import chalk from "chalk";
import type { RenderMode, UiCapabilities } from "./types.js";

function detectUnicodeSupport(): boolean {
	const locale =
		process.env["LC_ALL"] ||
		process.env["LC_CTYPE"] ||
		process.env["LANG"] ||
		"";
	return /utf-?8/i.test(locale);
}

function detectRenderMode(
	width: number,
	isInteractive: boolean,
	supportsColor: boolean,
): RenderMode {
	if (!isInteractive || !supportsColor) {
		return "plain";
	}

	if (width >= 92) {
		return "interactive-rich";
	}

	return "interactive-compact";
}

export function getUiCapabilities(): UiCapabilities {
	const stdout = process.stdout;
	const width = Math.max(60, Math.min(stdout.columns || 80, 120));
	const isInteractive = Boolean(stdout.isTTY);
	const supportsColor = chalk.level > 0 && !("NO_COLOR" in process.env);
	const supportsUnicode = detectUnicodeSupport();

	return {
		width,
		isInteractive,
		supportsColor,
		supportsUnicode,
		mode: detectRenderMode(width, isInteractive, supportsColor),
	};
}

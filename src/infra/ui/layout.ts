import type { UiCapabilities } from "./types.js";

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

export function stripAnsi(input: string): string {
	return input.replace(ANSI_PATTERN, "");
}

export function visibleLength(input: string): number {
	return stripAnsi(input).length;
}

export function getContentWidth(
	capabilities: UiCapabilities,
	padding: number = 4,
): number {
	return Math.max(40, capabilities.width - padding);
}

export function wrapLine(text: string, width: number): string[] {
	if (!text) {
		return [""];
	}

	if (visibleLength(text) <= width) {
		return [text];
	}

	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		const next = current ? `${current} ${word}` : word;
		if (visibleLength(next) <= width) {
			current = next;
			continue;
		}

		if (current) {
			lines.push(current);
			current = word;
			continue;
		}

		let remaining = word;
		while (visibleLength(remaining) > width) {
			lines.push(remaining.slice(0, width));
			remaining = remaining.slice(width);
		}
		current = remaining;
	}

	if (current) {
		lines.push(current);
	}

	return lines;
}

export function wrapLines(lines: string[], width: number): string[] {
	return lines.flatMap((line) => wrapLine(line, width));
}

export function padLine(text: string, width: number): string {
	const difference = Math.max(0, width - visibleLength(text));
	return `${text}${" ".repeat(difference)}`;
}

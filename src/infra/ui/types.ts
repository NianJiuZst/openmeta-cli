export type Tone =
	| "info"
	| "success"
	| "warning"
	| "error"
	| "muted"
	| "accent";
export type StepState = "pending" | "active" | "done" | "error";
export type RenderMode = "interactive-rich" | "interactive-compact" | "plain";

export interface CardOptions {
	label?: string;
	title: string;
	subtitle?: string;
	lines?: string[];
	tone?: Tone;
}

export interface KeyValueItem {
	label: string;
	value: string;
	tone?: Tone;
}

export interface MetricItem {
	label: string;
	value: string;
	hint?: string;
	tone?: Tone;
}

export interface StepItem {
	label: string;
	description?: string;
	state: StepState;
}

export interface TimelineItem {
	title: string;
	subtitle?: string;
	meta?: string;
	state: StepState;
}

export interface RecordItem {
	title: string;
	subtitle?: string;
	meta?: string[];
	lines?: string[];
	tone?: Tone;
}

export interface TaskOptions {
	title: string;
	doneMessage?: string;
	failedMessage?: string;
	tone?: Tone;
}

export interface UiCapabilities {
	width: number;
	isInteractive: boolean;
	supportsColor: boolean;
	supportsUnicode: boolean;
	mode: RenderMode;
}

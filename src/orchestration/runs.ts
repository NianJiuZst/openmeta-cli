import { runHistoryService } from "../services/index.js";
import { ui } from "../infra/index.js";
import type { AgentRunStatus } from "../types/index.js";

export interface RunsListOptions {
	limit?: number;
	json?: boolean;
}

function formatDuration(ms?: number): string {
	if (ms === undefined) {
		return "running";
	}

	if (ms < 1000) {
		return `${ms}ms`;
	}

	return `${(ms / 1000).toFixed(1)}s`;
}

function statusTone(
	status: AgentRunStatus,
): "success" | "warning" | "error" | "info" {
	if (status === "success") return "success";
	if (status === "failed") return "error";
	if (status === "cancelled") return "warning";
	return "info";
}

export class RunsOrchestrator {
	async list(options: RunsListOptions = {}): Promise<void> {
		const limit = Math.max(1, options.limit ?? 10);
		const records = runHistoryService.load().records.slice(0, limit);

		if (options.json) {
			process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
			return;
		}

		const totals = runHistoryService
			.load()
			.records.reduce<Record<AgentRunStatus, number>>(
				(acc, record) => {
					acc[record.status] += 1;
					return acc;
				},
				{ running: 0, success: 0, failed: 0, cancelled: 0 },
			);

		ui.hero({
			label: "OpenMeta Runs",
			title:
				records.length > 0
					? "The agent now leaves footprints you can inspect"
					: "No run history has been recorded yet",
			subtitle:
				"Recent command runs, durations, and failure reasons stay in a local ledger for debugging and follow-up.",
			lines: [
				`Run history path: ${runHistoryService.getPath()}`,
				`Showing latest ${records.length} run(s).`,
			],
			tone: records.some((record) => record.status === "failed")
				? "warning"
				: "accent",
		});

		ui.stats("Run ledger", [
			{ label: "Success", value: String(totals.success), tone: "success" },
			{
				label: "Failed",
				value: String(totals.failed),
				tone: totals.failed > 0 ? "error" : "muted",
			},
			{
				label: "Cancelled",
				value: String(totals.cancelled),
				tone: totals.cancelled > 0 ? "warning" : "muted",
			},
			{
				label: "Running",
				value: String(totals.running),
				tone: totals.running > 0 ? "info" : "muted",
			},
		]);

		if (records.length === 0) {
			ui.emptyState(
				"OpenMeta Runs",
				"No runs yet",
				'Run "openmeta scout", "openmeta agent", or "openmeta doctor" to populate the ledger.',
			);
			return;
		}

		ui.recordList(
			"Recent runs",
			records.map((record) => ({
				title: `${ui.badge(record.status, statusTone(record.status))} ${record.id}`,
				subtitle: record.commandName,
				meta: [
					`duration ${formatDuration(record.durationMs)}`,
					`started ${record.startedAt}`,
				],
				lines: [
					`Args: ${record.args.join(" ") || "(none)"}`,
					...(record.error ? [`Error: ${record.error}`] : []),
				],
				tone: statusTone(record.status),
			})),
		);
	}

	async show(id: string, options: { json?: boolean } = {}): Promise<void> {
		const record = runHistoryService.find(id);

		if (!record) {
			throw new Error(`Run not found: ${id}`);
		}

		if (options.json) {
			process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
			return;
		}

		ui.hero({
			label: "OpenMeta Runs",
			title: `Run ${record.id}`,
			subtitle: record.commandName,
			lines: [
				`Status: ${record.status}`,
				`Duration: ${formatDuration(record.durationMs)}`,
				`Started: ${record.startedAt}`,
				`Finished: ${record.finishedAt || "(still running)"}`,
			],
			tone: statusTone(record.status),
		});

		ui.keyValues("Run details", [
			{ label: "Command", value: record.commandName, tone: "info" },
			{ label: "Args", value: record.args.join(" ") || "(none)", tone: "info" },
			{
				label: "Error",
				value: record.error || "(none)",
				tone: record.error ? "error" : "muted",
			},
			{ label: "Ledger", value: runHistoryService.getPath(), tone: "muted" },
		]);
	}
}

export const runsOrchestrator = new RunsOrchestrator();

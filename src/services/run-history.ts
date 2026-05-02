import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ensureDirectory, getOpenMetaStateDir } from "../infra/index.js";
import type { AgentRunRecord, AgentRunStatus } from "../types/index.js";

interface RunHistoryState {
	records: AgentRunRecord[];
}

function defaultState(): RunHistoryState {
	return { records: [] };
}

function createRunId(startedAt: string): string {
	const stamp = startedAt.replace(/[-:T.Z]/g, "").slice(0, 14);
	const suffix = Math.random().toString(36).slice(2, 8);
	return `run_${stamp}_${suffix}`;
}

export class RunHistoryService {
	private getStatePath(): string {
		return join(ensureDirectory(getOpenMetaStateDir()), "runs.json");
	}

	getPath(): string {
		return this.getStatePath();
	}

	load(): RunHistoryState {
		const path = this.getStatePath();

		if (!existsSync(path)) {
			return defaultState();
		}

		const raw = JSON.parse(
			readFileSync(path, "utf-8"),
		) as Partial<RunHistoryState>;
		return {
			records: raw.records ?? [],
		};
	}

	start(input: { commandName: string; args: string[] }): AgentRunRecord {
		const startedAt = new Date().toISOString();
		const record: AgentRunRecord = {
			id: createRunId(startedAt),
			commandName: input.commandName,
			args: input.args,
			status: "running",
			startedAt,
		};

		this.write([record, ...this.load().records].slice(0, 100));
		return record;
	}

	finish(
		id: string,
		status: Exclude<AgentRunStatus, "running">,
		error?: string,
	): AgentRunRecord | undefined {
		const state = this.load();
		const current = state.records.find((record) => record.id === id);

		if (!current) {
			return undefined;
		}

		const finishedAt = new Date().toISOString();
		const updated: AgentRunRecord = {
			...current,
			status,
			finishedAt,
			durationMs: Math.max(
				0,
				new Date(finishedAt).getTime() - new Date(current.startedAt).getTime(),
			),
			...(error ? { error } : {}),
		};

		this.write(
			[updated, ...state.records.filter((record) => record.id !== id)].slice(
				0,
				100,
			),
		);
		return updated;
	}

	find(id: string): AgentRunRecord | undefined {
		return this.load().records.find((record) => record.id === id);
	}

	private write(records: AgentRunRecord[]): void {
		writeFileSync(
			this.getStatePath(),
			JSON.stringify({ records }, null, 2),
			"utf-8",
		);
	}
}

export const runHistoryService = new RunHistoryService();

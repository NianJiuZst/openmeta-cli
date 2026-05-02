import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
	ensureDirectory,
	getOpenMetaStateDir,
	getLocalDateStamp,
} from "../infra/index.js";
import type { ProofOfWorkRecord } from "../types/index.js";

interface ProofOfWorkState {
	records: ProofOfWorkRecord[];
}

function defaultState(): ProofOfWorkState {
	return { records: [] };
}

export class ProofOfWorkService {
	private getStatePath(): string {
		return join(ensureDirectory(getOpenMetaStateDir()), "proof-of-work.json");
	}

	getPath(): string {
		return this.getStatePath();
	}

	load(): ProofOfWorkState {
		const path = this.getStatePath();

		if (!existsSync(path)) {
			return defaultState();
		}

		const raw = JSON.parse(
			readFileSync(path, "utf-8"),
		) as Partial<ProofOfWorkState>;
		return {
			records: raw.records ?? [],
		};
	}

	record(entry: ProofOfWorkRecord): ProofOfWorkRecord[] {
		const current = this.load();
		const records = [entry, ...current.records].slice(0, 100);
		writeFileSync(
			this.getStatePath(),
			JSON.stringify({ records }, null, 2),
			"utf-8",
		);
		return records;
	}

	renderMarkdown(records: ProofOfWorkRecord[]): string {
		const total = records.length;
		const published = records.filter((item) => item.published).length;
		const topRepositories = [
			...new Set(records.map((item) => item.repoFullName)),
		].slice(0, 10);

		const lines = [
			"# Proof of Work",
			"",
			`- Total Draft Contributions: ${total}`,
			`- Published Runs: ${published}`,
			`- Unique Repositories: ${topRepositories.length}`,
			"",
			"## Top Repositories",
			"",
			...(topRepositories.length > 0
				? topRepositories.map((repo) => `- ${repo}`)
				: ["- None yet"]),
			"",
			"## Recent Activity",
			"",
			...(records.slice(0, 10).length > 0
				? records
						.slice(0, 10)
						.map(
							(record) =>
								`- ${record.repoFullName}#${record.issueNumber} | overall ${record.overallScore} | published=${record.published}${record.pullRequestUrl ? ` | pr=${record.pullRequestUrl}` : ""}`,
						)
				: ["- No activity recorded"]),
			"",
			`_Snapshot Date: ${getLocalDateStamp()}_`,
			"",
		];

		return lines.join("\n");
	}
}

export const proofOfWorkService = new ProofOfWorkService();

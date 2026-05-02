import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
	ensureDirectory,
	getOpenMetaStateDir,
	getLocalDateStamp,
} from "../infra/index.js";
import type { ContributionInboxItem } from "../types/index.js";

interface InboxState {
	items: ContributionInboxItem[];
}

function defaultState(): InboxState {
	return { items: [] };
}

export class InboxService {
	private getInboxPath(): string {
		return join(ensureDirectory(getOpenMetaStateDir()), "inbox.json");
	}

	getPath(): string {
		return this.getInboxPath();
	}

	load(): InboxState {
		const path = this.getInboxPath();

		if (!existsSync(path)) {
			return defaultState();
		}

		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<InboxState>;
		return {
			items: raw.items ?? [],
		};
	}

	saveItem(item: ContributionInboxItem): ContributionInboxItem[] {
		const state = this.load();
		const items = [
			item,
			...state.items.filter((entry) => entry.id !== item.id),
		].sort((left, right) => right.overallScore - left.overallScore);

		writeFileSync(
			this.getInboxPath(),
			JSON.stringify({ items }, null, 2),
			"utf-8",
		);
		return items;
	}

	renderMarkdown(items: ContributionInboxItem[]): string {
		const lines = [
			"# Contribution Inbox",
			"",
			...(items.length > 0
				? items.map(
						(item) =>
							`- [${item.status.toUpperCase()}] ${item.repoFullName}#${item.issueNumber} | overall ${item.overallScore} | ${item.summary}`,
					)
				: ["- Inbox is empty"]),
			"",
			`_Snapshot Date: ${getLocalDateStamp()}_`,
			"",
		];

		return lines.join("\n");
	}
}

export const inboxService = new InboxService();

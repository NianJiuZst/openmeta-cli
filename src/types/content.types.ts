import type { MatchedIssue } from "./github.types.js";

export type ContentType = "research_note" | "development_diary";

export interface GeneratedContent {
	type: ContentType;
	title: string;
	content: string;
	relatedIssues: MatchedIssue[];
	generatedAt: string;
}

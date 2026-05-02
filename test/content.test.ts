import { describe, expect, test } from "bun:test";
import { contentService } from "../src/services/content.js";
import {
	createInboxItem,
	createMatchedIssue,
	createMemory,
	createPatchDraft,
	createProofRecord,
	createPullRequestDraft,
	createRankedIssue,
	createWorkspace,
} from "./helpers/factories.js";

describe("contentService", () => {
	test("formats generated research notes as markdown with related issues", () => {
		const issue = createMatchedIssue();
		const content = contentService.generateResearchNote(
			[issue],
			"Body content",
		);
		const markdown = contentService.formatAsMarkdown(content);

		expect(markdown).toContain("# Daily Open Source Issue Research Notes");
		expect(markdown).toContain("Body content");
		expect(markdown).toContain(
			"### [acme/demo#42] Add accessible labels to icon buttons",
		);
		expect(markdown).toContain("- Match Score: 86/100");
	});

	test("formats contribution dossier with enriched issue and workspace context", () => {
		const markdown = contentService.formatContributionDossier(
			createRankedIssue(),
			createWorkspace(),
			createMemory(),
			createPatchDraft(),
			createPullRequestDraft(),
		);

		expect(markdown).toContain("## Opportunity Snapshot");
		expect(markdown).toContain("- Repo Stars: 240");
		expect(markdown).toContain(
			"- Issue Link: https://github.com/acme/demo/issues/42",
		);
		expect(markdown).toContain("- Labels: good first issue, help wanted");
		expect(markdown).toContain(
			"- `bun test` | Detected Bun tests | repo-script",
		);
		expect(markdown).toContain("## Runnable Validation Commands");
		expect(markdown).toContain("## Validation Safety Notes");
		expect(markdown).toContain("## Patch Draft");
		expect(markdown).toContain("## Goal");
		expect(markdown).toContain("Add accessible labels to icon-only buttons");
		expect(markdown).toContain(
			"Title: Add aria-label handling to icon-only buttons",
		);
	});

	test("renders structured patch drafts as markdown", () => {
		const markdown = contentService.formatPatchDraftMarkdown(
			createPatchDraft(),
		);

		expect(markdown).toContain("# Patch Draft");
		expect(markdown).toContain("## Target Files");
		expect(markdown).toContain("`src/components/IconButton.tsx`");
		expect(markdown).toContain("### Update button API");
		expect(markdown).toContain("## Validation Notes");
	});

	test("renders structured pull request drafts as markdown", () => {
		const markdown = contentService.formatPullRequestDraftMarkdown(
			createPullRequestDraft(),
		);

		expect(markdown).toContain(
			"Title: Add aria-label handling to icon-only buttons",
		);
		expect(markdown).toContain("## Summary");
		expect(markdown).toContain("## Changes");
		expect(markdown).toContain("## Validation");
	});

	test("formats inbox and proof-of-work markdown summaries", () => {
		const inboxMarkdown = contentService.formatInboxMarkdown([
			createInboxItem(),
		]);
		const proofMarkdown = contentService.formatProofOfWorkMarkdown([
			createProofRecord(),
		]);

		expect(inboxMarkdown).toContain("[READY] acme/demo#42 | overall 84");
		expect(proofMarkdown).toContain(
			"acme/demo#42 | overall 84 | published=true",
		);
	});

	test("formats commit messages using the configured template", () => {
		const content = contentService.generateDiary(
			[createMatchedIssue()],
			"Diary body",
		);
		const commitMessage = contentService.formatCommitMessage(
			content,
			"feat: {{title}}\n\n{{content}}",
		);

		expect(commitMessage).toContain("feat: Development Diary -");
		expect(commitMessage).toContain("Daily open source contribution log");
	});
});

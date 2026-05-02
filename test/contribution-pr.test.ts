import { describe, expect, test } from "bun:test";
import { contributionPrService } from "../src/services/index.js";
import {
	createPullRequestDraft,
	createRankedIssue,
} from "./helpers/factories.js";

describe("ContributionPrService", () => {
	test("builds a real pull request payload from the structured draft", () => {
		const parsed = contributionPrService.buildDraftPullRequest(
			createPullRequestDraft(),
		);

		expect(parsed.title).toBe("Add aria-label handling to icon-only buttons");
		expect(parsed.body).toContain("## Summary");
		expect(parsed.body).not.toContain("Title:");
	});

	test("builds bounded branch names and commit messages for generated contribution PRs", () => {
		const issue = createRankedIssue({
			repoFullName: "acme/widgets",
			number: 42,
			title:
				"Fix keyboard focus in icon-only widgets with an intentionally long title",
		});

		const branchName = contributionPrService.buildPublishBranchName(issue);
		const commitMessage =
			contributionPrService.buildContributionCommitMessage(issue);

		expect(branchName).toMatch(
			/^openmeta\/agent-42-fix-keyboard-focus-in-icon-only-+\d+$/,
		);
		expect(commitMessage).toStartWith(
			"feat: address acme/widgets#42 Fix keyboard focus",
		);
		expect(commitMessage.length).toBeLessThanOrEqual(120);
	});
});

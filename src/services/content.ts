import type { PatchDraft, PullRequestDraft } from "../contracts/index.js";
import type {
	ContentType,
	ContributionInboxItem,
	GeneratedContent,
	ProofOfWorkRecord,
	RankedIssue,
	RepoMemory,
	RepoWorkspaceContext,
	MatchedIssue,
} from "../types/index.js";
import { getLocalDateStamp } from "../infra/date.js";

export class ContentService {
	generateResearchNote(
		issues: MatchedIssue[],
		reportContent: string,
	): GeneratedContent {
		const title = `Daily Open Source Issue Research Notes - ${getLocalDateStamp()}`;

		return {
			type: "research_note",
			title,
			content: reportContent,
			relatedIssues: issues,
			generatedAt: new Date().toISOString(),
		};
	}

	generateDiary(
		issues: MatchedIssue[],
		diaryContent: string,
	): GeneratedContent {
		const title = `Daily Development Diary - ${getLocalDateStamp()}`;

		return {
			type: "development_diary",
			title,
			content: diaryContent,
			relatedIssues: issues,
			generatedAt: new Date().toISOString(),
		};
	}

	formatAsMarkdown(content: GeneratedContent): string {
		let md = `# ${content.title}\n\n`;
		md += `Generated at: ${content.generatedAt}\n\n`;
		md += `---\n\n`;
		md += content.content;
		md += `\n\n---\n\n`;
		md += `## Related Issues\n\n`;

		for (const issue of content.relatedIssues) {
			md += `### [${issue.repoFullName}#${issue.number}] ${issue.title}\n`;
			md += `- Match Score: ${issue.matchScore}/100\n`;
			md += `- Labels: ${issue.labels.join(", ")}\n`;
			md += `- Link: ${issue.htmlUrl}\n`;
			md += `- Core Demand: ${issue.analysis.coreDemand}\n`;
			md += `- Tech Requirements: ${issue.analysis.techRequirements.join(", ")}\n`;
			md += `- Solution Suggestion: ${issue.analysis.solutionSuggestion}\n`;
			md += `- Estimated Workload: ${issue.analysis.estimatedWorkload}\n\n`;
		}

		return md;
	}

	formatCommitMessage(content: GeneratedContent, template: string): string {
		const typeLabel =
			content.type === "research_note" ? "Research Notes" : "Development Diary";
		const date = getLocalDateStamp();
		return template
			.replace("{{title}}", `${typeLabel} - ${date}`)
			.replace("{{content}}", `Daily open source contribution log for ${date}`);
	}

	getContentTypeLabel(type: ContentType): string {
		return type === "research_note" ? "Research Notes" : "Development Diary";
	}

	formatPatchDraftMarkdown(draft: PatchDraft): string {
		const lines = [
			"# Patch Draft",
			"",
			"## Goal",
			"",
			draft.goal,
			"",
			"## Target Files",
			"",
			...draft.targetFiles.map((file) => `- \`${file.path}\` | ${file.reason}`),
			"",
			"## Proposed Changes",
			"",
			...draft.proposedChanges.flatMap((change) => [
				`### ${change.title}`,
				"",
				change.details,
				...(change.files.length > 0
					? ["", `Files: ${change.files.join(", ")}`]
					: []),
				"",
			]),
			"## Risks",
			"",
			...(draft.risks.length > 0
				? draft.risks.map((risk) => `- ${risk}`)
				: ["- None"]),
			"",
			"## Validation Notes",
			"",
			...(draft.validationNotes.length > 0
				? draft.validationNotes.map((note) => `- ${note}`)
				: ["- None"]),
			"",
		];

		return lines.join("\n");
	}

	formatPullRequestDraftBody(draft: PullRequestDraft): string {
		const lines = [
			"## Summary",
			"",
			draft.summary,
			"",
			"## Changes",
			"",
			...draft.changes.map((change) => `- ${change}`),
			"",
			"## Validation",
			"",
			...(draft.validation.length > 0
				? draft.validation.map((item) => `- ${item}`)
				: ["- Not run"]),
			"",
			"## Risks",
			"",
			...(draft.risks.length > 0
				? draft.risks.map((item) => `- ${item}`)
				: ["- None"]),
			"",
		];

		return lines.join("\n");
	}

	formatPullRequestDraftMarkdown(draft: PullRequestDraft): string {
		return [
			`Title: ${draft.title}`,
			"",
			this.formatPullRequestDraftBody(draft),
		].join("\n");
	}

	formatContributionDossier(
		issue: RankedIssue,
		workspace: RepoWorkspaceContext,
		memory: RepoMemory,
		patchDraft: PatchDraft,
		prDraft: PullRequestDraft,
	): string {
		const lines = [
			`# OpenMeta Contribution Dossier - ${issue.repoFullName}#${issue.number}`,
			"",
			"## Opportunity Snapshot",
			"",
			`- Overall Score: ${issue.opportunity.overallScore}/100`,
			`- Technical Match: ${issue.matchScore}/100`,
			`- Opportunity Score: ${issue.opportunity.score}/100`,
			`- Summary: ${issue.opportunity.summary}`,
			"",
			"## Breakdown",
			"",
			`- Technical Fit: ${issue.opportunity.breakdown.technicalFit}`,
			`- Freshness: ${issue.opportunity.breakdown.freshness}`,
			`- Onboarding Clarity: ${issue.opportunity.breakdown.onboardingClarity}`,
			`- Merge Potential: ${issue.opportunity.breakdown.mergePotential}`,
			`- Impact: ${issue.opportunity.breakdown.impact}`,
			"",
			"## Workspace",
			"",
			`- Workspace Path: ${workspace.workspacePath}`,
			`- Default Branch: ${workspace.defaultBranch}`,
			`- Agent Branch: ${workspace.branchName || "not created"}`,
			`- Workspace Dirty: ${workspace.workspaceDirty}`,
			`- Issue Link: ${issue.htmlUrl}`,
			`- Repo Stars: ${issue.repoStars}`,
			`- Created At: ${issue.createdAt}`,
			`- Updated At: ${issue.updatedAt}`,
			`- Labels: ${issue.labels.join(", ") || "none"}`,
			`- Repo Description: ${issue.repoDescription || "n/a"}`,
			`- Issue Excerpt: ${(issue.body || "").replace(/\s+/g, " ").trim().slice(0, 280) || "n/a"}`,
			`- Core Demand: ${issue.analysis.coreDemand || "n/a"}`,
			`- Tech Requirements: ${issue.analysis.techRequirements.join(", ") || "n/a"}`,
			`- Estimated Workload: ${issue.analysis.estimatedWorkload || "n/a"}`,
			"",
			"## Detected Test Commands",
			"",
			...(workspace.testCommands.length > 0
				? workspace.testCommands.map(
						(item) => `- \`${item.command}\` | ${item.reason} | ${item.source}`,
					)
				: ["- None detected"]),
			"",
			"## Runnable Validation Commands",
			"",
			...(workspace.validationCommands.length > 0
				? workspace.validationCommands.map(
						(item) => `- \`${item.command}\` | ${item.source}`,
					)
				: ["- None selected"]),
			"",
			"## Validation Safety Notes",
			"",
			...(workspace.validationWarnings.length > 0
				? workspace.validationWarnings.map((warning) => `- ${warning}`)
				: ["- None"]),
			"",
			"## Baseline Test Results",
			"",
			...(workspace.testResults.length > 0
				? workspace.testResults.map(
						(result) =>
							`- \`${result.command}\` | ${result.passed ? "passed" : `failed (${result.exitCode ?? "n/a"})`}`,
					)
				: ["- Not executed"]),
			"",
			"## Repo Memory",
			"",
			`- Generated Dossiers: ${memory.generatedDossiers}`,
			`- Last Selected Issue: ${memory.lastSelectedIssue || "n/a"}`,
			`- Preferred Paths: ${memory.preferredPaths.join(", ") || "none"}`,
			"",
			"## Patch Draft",
			"",
			this.formatPatchDraftMarkdown(patchDraft),
			"",
			"## PR Draft",
			"",
			this.formatPullRequestDraftMarkdown(prDraft),
			"",
			`_Generated at ${new Date().toISOString()}_`,
			"",
		];

		return lines.join("\n");
	}

	formatInboxMarkdown(items: ContributionInboxItem[]): string {
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
		];

		return lines.join("\n");
	}

	formatProofOfWorkMarkdown(records: ProofOfWorkRecord[]): string {
		const lines = [
			"# Proof of Work",
			"",
			...(records.length > 0
				? records
						.slice(0, 20)
						.map(
							(record) =>
								`- ${record.repoFullName}#${record.issueNumber} | overall ${record.overallScore} | published=${record.published}`,
						)
				: ["- No activity recorded"]),
			"",
		];

		return lines.join("\n");
	}
}

export const contentService = new ContentService();

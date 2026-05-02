import type {
	PatchDraft,
	PullRequestDraft,
} from "../../src/contracts/index.js";
import type {
	ContributionInboxItem,
	GitHubIssue,
	MatchedIssue,
	ProofOfWorkRecord,
	RankedIssue,
	RepoMemory,
	RepoWorkspaceContext,
} from "../../src/types/index.js";

export function createIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
	const issue = createMatchedIssue(overrides);
	return {
		id: issue.id,
		number: issue.number,
		title: issue.title,
		body: issue.body,
		htmlUrl: issue.htmlUrl,
		repoName: issue.repoName,
		repoFullName: issue.repoFullName,
		repoDescription: issue.repoDescription,
		repoStars: issue.repoStars,
		labels: issue.labels,
		createdAt: issue.createdAt,
		updatedAt: issue.updatedAt,
	};
}

export function createMatchedIssue(
	overrides: Partial<MatchedIssue> = {},
): MatchedIssue {
	return {
		id: 1,
		number: 42,
		title: "Add accessible labels to icon buttons",
		body: "Icon-only buttons are currently missing accessible names. Add aria-label attributes and update related tests.",
		htmlUrl: "https://github.com/acme/demo/issues/42",
		repoName: "demo",
		repoFullName: "acme/demo",
		repoDescription: "Demo repository for contribution workflows",
		repoStars: 240,
		labels: ["good first issue", "help wanted"],
		createdAt: "2026-04-01T08:00:00.000Z",
		updatedAt: "2026-04-18T08:00:00.000Z",
		matchScore: 86,
		analysis: {
			coreDemand: "Add accessible names to icon-only buttons.",
			techRequirements: ["react", "accessibility", "typescript"],
			solutionSuggestion: "Update shared button components and tests.",
			estimatedWorkload: "1-2 hours",
		},
		...overrides,
	};
}

export function createRankedIssue(
	overrides: Partial<RankedIssue> = {},
): RankedIssue {
	const matchedIssue = createMatchedIssue(overrides);

	return {
		...matchedIssue,
		opportunity: {
			score: 82,
			overallScore: 84,
			summary: "Strongest signal: freshness (92). Main risk: impact (58).",
			breakdown: {
				technicalFit: matchedIssue.matchScore,
				freshness: 92,
				onboardingClarity: 85,
				mergePotential: 79,
				impact: 58,
			},
		},
		...overrides,
	};
}

export function createWorkspace(
	overrides: Partial<RepoWorkspaceContext> = {},
): RepoWorkspaceContext {
	return {
		workspacePath: "/tmp/openmeta-demo",
		workspaceDirty: false,
		defaultBranch: "main",
		branchName: "openmeta/42-accessibility",
		topLevelFiles: ["package.json", "src"],
		candidateFiles: [
			"src/components/IconButton.tsx",
			"src/components/IconButton.test.tsx",
		],
		snippets: [
			{
				path: "src/components/IconButton.tsx",
				content: "export function IconButton() { return <button />; }",
			},
		],
		testCommands: [
			{
				command: "bun test",
				reason: "Detected Bun tests",
				source: "repo-script",
			},
			{
				command: "bun run lint",
				reason: "Detected lint script",
				source: "repo-script",
			},
		],
		validationCommands: [],
		validationWarnings: [
			"Skipped bun test during headless validation because it comes from repository-defined scripts.",
		],
		testResults: [
			{ command: "bun test", exitCode: 0, passed: true, output: "2 passed" },
		],
		...overrides,
	};
}

export function createMemory(overrides: Partial<RepoMemory> = {}): RepoMemory {
	return {
		repoFullName: "acme/demo",
		firstSeenAt: "2026-04-01T00:00:00.000Z",
		lastUpdatedAt: "2026-04-18T08:00:00.000Z",
		lastSelectedIssue: "acme/demo#42",
		workspacePath: "/tmp/openmeta-demo",
		lastBranchName: "openmeta/42-accessibility",
		detectedTestCommands: ["bun test"],
		preferredPaths: ["src/components/IconButton.tsx"],
		generatedDossiers: 3,
		runStats: {
			totalRuns: 2,
			publishedRuns: 1,
			realPrRuns: 1,
			reviewRequiredRuns: 0,
			successfulValidationRuns: 1,
			failedValidationRuns: 1,
		},
		pathSignals: [
			{
				path: "src/components/IconButton.tsx",
				candidateCount: 3,
				changedCount: 2,
				successfulValidationCount: 1,
				publishedCount: 1,
				lastSeenAt: "2026-04-18T08:00:00.000Z",
			},
		],
		validationSignals: [
			{
				command: "bun test",
				failureCount: 1,
				lastExitCode: 1,
				lastSeenAt: "2026-04-17T08:00:00.000Z",
				sampleOutput: "Expected aria-label to be present",
			},
		],
		recentIssues: [
			{
				reference: "acme/demo#42",
				title: "Add accessible labels to icon buttons",
				overallScore: 84,
				generatedAt: "2026-04-18T08:00:00.000Z",
				status: "published",
				changedFiles: ["src/components/IconButton.tsx"],
				published: true,
				reviewRequired: false,
				validationSummary: "bun test=passed",
				pullRequestUrl: "https://github.com/acme/demo/pull/123",
			},
		],
		...overrides,
	};
}

export function createPatchDraft(
	overrides: Partial<PatchDraft> = {},
): PatchDraft {
	return {
		goal: "Add accessible labels to icon-only buttons",
		targetFiles: [
			{
				path: "src/components/IconButton.tsx",
				reason: "Primary component logic for icon-only buttons",
			},
			{
				path: "src/components/IconButton.test.tsx",
				reason: "Coverage for accessibility behavior",
			},
		],
		proposedChanges: [
			{
				title: "Update button API",
				details:
					"Require an accessible label when the button is rendered without visible text.",
				files: ["src/components/IconButton.tsx"],
			},
			{
				title: "Expand test coverage",
				details:
					"Add coverage for icon-only button rendering and label propagation.",
				files: ["src/components/IconButton.test.tsx"],
			},
		],
		risks: [
			"Consumer code may rely on the previous unlabeled icon-only behavior",
		],
		validationNotes: ["Run bun test after updating the component and tests"],
		...overrides,
	};
}

export function createPullRequestDraft(
	overrides: Partial<PullRequestDraft> = {},
): PullRequestDraft {
	return {
		title: "Add aria-label handling to icon-only buttons",
		summary:
			"Ensure icon-only buttons expose accessible names and document the updated behavior.",
		changes: [
			"Add aria-label handling to the shared IconButton component",
			"Expand component tests for icon-only button accessibility",
		],
		validation: ["bun test (pending)"],
		risks: [
			"Consumers may need to update snapshots that cover button rendering",
		],
		...overrides,
	};
}

export function createInboxItem(
	overrides: Partial<ContributionInboxItem> = {},
): ContributionInboxItem {
	return {
		id: "acme/demo#42",
		repoFullName: "acme/demo",
		issueNumber: 42,
		issueTitle: "Add accessible labels to icon buttons",
		summary: "Strongest signal: freshness (92). Main risk: impact (58).",
		overallScore: 84,
		opportunityScore: 82,
		status: "ready",
		artifactDir: "/tmp/openmeta-artifacts/42",
		generatedAt: "2026-04-18T08:00:00.000Z",
		...overrides,
	};
}

export function createProofRecord(
	overrides: Partial<ProofOfWorkRecord> = {},
): ProofOfWorkRecord {
	return {
		id: "acme/demo#42@1",
		repoFullName: "acme/demo",
		issueNumber: 42,
		issueTitle: "Add accessible labels to icon buttons",
		overallScore: 84,
		opportunityScore: 82,
		branchName: "openmeta/42-accessibility",
		artifactDir: "/tmp/openmeta-artifacts/42",
		generatedAt: "2026-04-18T08:00:00.000Z",
		published: true,
		pullRequestUrl: "https://github.com/acme/demo/pull/123",
		pullRequestNumber: 123,
		...overrides,
	};
}

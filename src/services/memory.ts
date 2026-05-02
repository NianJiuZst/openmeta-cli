import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
	ensureDirectory,
	getOpenMetaStateDir,
	getLocalDateStamp,
} from "../infra/index.js";
import type {
	RankedIssue,
	RepoMemory,
	RepoWorkspaceContext,
	TestResult,
} from "../types/index.js";

function sanitizeRepoName(repoFullName: string): string {
	return repoFullName.replace(/\//g, "__");
}

function defaultMemory(repoFullName: string): RepoMemory {
	return {
		repoFullName,
		firstSeenAt: new Date().toISOString(),
		lastUpdatedAt: new Date().toISOString(),
		detectedTestCommands: [],
		preferredPaths: [],
		generatedDossiers: 0,
		runStats: {
			totalRuns: 0,
			publishedRuns: 0,
			realPrRuns: 0,
			reviewRequiredRuns: 0,
			successfulValidationRuns: 0,
			failedValidationRuns: 0,
		},
		pathSignals: [],
		validationSignals: [],
		recentIssues: [],
	};
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function summarizeValidationResults(results: TestResult[]): string {
	if (results.length === 0) {
		return "not run";
	}

	return results
		.map(
			(result) =>
				`${result.command}=${result.passed ? "passed" : `failed (${result.exitCode ?? "n/a"})`}`,
		)
		.join("; ");
}

export class MemoryService {
	private getMemoryDir(): string {
		return ensureDirectory(join(getOpenMetaStateDir(), "repo-memory"));
	}

	private getMemoryPath(repoFullName: string): string {
		return join(this.getMemoryDir(), `${sanitizeRepoName(repoFullName)}.json`);
	}

	getPath(repoFullName: string): string {
		return this.getMemoryPath(repoFullName);
	}

	load(repoFullName: string): RepoMemory {
		const path = this.getMemoryPath(repoFullName);

		if (!existsSync(path)) {
			return defaultMemory(repoFullName);
		}

		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<RepoMemory>;
		return {
			...defaultMemory(repoFullName),
			...raw,
			detectedTestCommands: raw.detectedTestCommands ?? [],
			preferredPaths: raw.preferredPaths ?? [],
			runStats: {
				...defaultMemory(repoFullName).runStats,
				...raw.runStats,
			},
			pathSignals: raw.pathSignals ?? [],
			validationSignals: raw.validationSignals ?? [],
			recentIssues: (raw.recentIssues ?? []).map((issue) => ({
				...issue,
				changedFiles: issue.changedFiles ?? [],
				published: issue.published ?? false,
				reviewRequired: issue.reviewRequired ?? false,
				status: issue.status ?? "selected",
				validationSummary: issue.validationSummary ?? "not run",
			})),
		};
	}

	update(issue: RankedIssue, workspace: RepoWorkspaceContext): RepoMemory {
		const current = this.load(issue.repoFullName);
		const now = new Date().toISOString();
		const pathSignals = this.bumpCandidatePaths(
			current.pathSignals,
			workspace.candidateFiles,
			now,
		);
		const next: RepoMemory = {
			...current,
			lastUpdatedAt: now,
			lastSelectedIssue: `${issue.repoFullName}#${issue.number}`,
			workspacePath: workspace.workspacePath,
			lastBranchName: workspace.branchName,
			detectedTestCommands: uniqueStrings([
				...workspace.testCommands.map((item) => item.command),
				...current.detectedTestCommands,
			]).slice(0, 12),
			generatedDossiers: current.generatedDossiers + 1,
			pathSignals,
			preferredPaths: this.derivePreferredPaths(pathSignals),
			recentIssues: [
				{
					reference: `${issue.repoFullName}#${issue.number}`,
					title: issue.title,
					overallScore: issue.opportunity.overallScore,
					generatedAt: now,
					status: "selected" as const,
					changedFiles: [],
					published: false,
					reviewRequired: false,
					validationSummary: "not run",
				},
				...current.recentIssues.filter(
					(item) => item.reference !== `${issue.repoFullName}#${issue.number}`,
				),
			].slice(0, 10),
		};

		writeFileSync(
			this.getMemoryPath(issue.repoFullName),
			JSON.stringify(next, null, 2),
			"utf-8",
		);
		return next;
	}

	recordOutcome(input: {
		issue: RankedIssue;
		workspace: RepoWorkspaceContext;
		changedFiles: string[];
		validationResults: TestResult[];
		published: boolean;
		pullRequestUrl?: string;
		reviewRequired: boolean;
	}): RepoMemory {
		const current = this.load(input.issue.repoFullName);
		const now = new Date().toISOString();
		const validationSucceeded =
			input.validationResults.length > 0 &&
			input.validationResults.every((result) => result.passed);
		const validationFailed = input.validationResults.some(
			(result) => !result.passed,
		);
		const issueReference = `${input.issue.repoFullName}#${input.issue.number}`;
		const validationSummary = summarizeValidationResults(
			input.validationResults,
		);
		const pathSignals = this.recordChangedPaths(
			current.pathSignals,
			input.changedFiles,
			{
				now,
				validationSucceeded,
				published: input.published,
			},
		);
		const validationSignals = this.recordValidationFailures(
			current.validationSignals,
			input.validationResults,
			now,
		);

		const next: RepoMemory = {
			...current,
			lastUpdatedAt: now,
			workspacePath: input.workspace.workspacePath,
			lastBranchName: input.workspace.branchName,
			preferredPaths: this.derivePreferredPaths(pathSignals),
			pathSignals,
			validationSignals,
			runStats: {
				totalRuns: current.runStats.totalRuns + 1,
				publishedRuns:
					current.runStats.publishedRuns + (input.published ? 1 : 0),
				realPrRuns:
					current.runStats.realPrRuns + (input.pullRequestUrl ? 1 : 0),
				reviewRequiredRuns:
					current.runStats.reviewRequiredRuns + (input.reviewRequired ? 1 : 0),
				successfulValidationRuns:
					current.runStats.successfulValidationRuns +
					(validationSucceeded ? 1 : 0),
				failedValidationRuns:
					current.runStats.failedValidationRuns + (validationFailed ? 1 : 0),
			},
			recentIssues: [
				{
					reference: issueReference,
					title: input.issue.title,
					overallScore: input.issue.opportunity.overallScore,
					generatedAt: now,
					status: this.resolveIssueStatus({
						changedFiles: input.changedFiles,
						published: input.published,
						pullRequestUrl: input.pullRequestUrl,
						reviewRequired: input.reviewRequired,
						validationSucceeded,
					}),
					changedFiles: input.changedFiles,
					published: input.published,
					reviewRequired: input.reviewRequired,
					validationSummary,
					pullRequestUrl: input.pullRequestUrl,
				},
				...current.recentIssues.filter(
					(item) => item.reference !== issueReference,
				),
			].slice(0, 10),
		};

		writeFileSync(
			this.getMemoryPath(input.issue.repoFullName),
			JSON.stringify(next, null, 2),
			"utf-8",
		);
		return next;
	}

	renderMarkdown(memory: RepoMemory): string {
		const lines = [
			`# Repo Memory: ${memory.repoFullName}`,
			"",
			`- First Seen: ${memory.firstSeenAt}`,
			`- Last Updated: ${memory.lastUpdatedAt}`,
			`- Generated Dossiers: ${memory.generatedDossiers}`,
			`- Last Selected Issue: ${memory.lastSelectedIssue || "n/a"}`,
			`- Workspace Path: ${memory.workspacePath || "n/a"}`,
			`- Last Branch: ${memory.lastBranchName || "n/a"}`,
			"",
			"## Run Stats",
			"",
			`- Total Runs: ${memory.runStats.totalRuns}`,
			`- Published Runs: ${memory.runStats.publishedRuns}`,
			`- Draft PR Runs: ${memory.runStats.realPrRuns}`,
			`- Review Required Runs: ${memory.runStats.reviewRequiredRuns}`,
			`- Successful Validation Runs: ${memory.runStats.successfulValidationRuns}`,
			`- Failed Validation Runs: ${memory.runStats.failedValidationRuns}`,
			"",
			"## Preferred Paths",
			"",
			...(memory.preferredPaths.length > 0
				? memory.preferredPaths.map((path) => `- ${path}`)
				: ["- None recorded"]),
			"",
			"## Path Signals",
			"",
			...(memory.pathSignals.length > 0
				? memory.pathSignals
						.slice(0, 10)
						.map(
							(signal) =>
								`- ${signal.path} | candidate ${signal.candidateCount} | changed ${signal.changedCount} | validation ${signal.successfulValidationCount} | published ${signal.publishedCount}`,
						)
				: ["- No path history recorded"]),
			"",
			"## Detected Test Commands",
			"",
			...(memory.detectedTestCommands.length > 0
				? memory.detectedTestCommands.map((command) => `- \`${command}\``)
				: ["- None detected"]),
			"",
			"## Validation Failure Signals",
			"",
			...(memory.validationSignals.length > 0
				? memory.validationSignals
						.slice(0, 10)
						.map(
							(signal) =>
								`- \`${signal.command}\` | failures ${signal.failureCount} | last exit ${signal.lastExitCode ?? "n/a"}${signal.sampleOutput ? ` | sample ${signal.sampleOutput}` : ""}`,
						)
				: ["- No validation failures recorded"]),
			"",
			"## Recent Issues",
			"",
			...(memory.recentIssues.length > 0
				? memory.recentIssues.map(
						(issue) =>
							`- ${issue.reference} | score ${issue.overallScore} | status ${issue.status} | changed ${issue.changedFiles.length} | published ${issue.published ? "yes" : "no"} | validation ${issue.validationSummary}`,
					)
				: ["- No issues recorded"]),
			"",
			`_Snapshot Date: ${getLocalDateStamp()}_`,
			"",
		];

		return lines.join("\n");
	}

	private derivePreferredPaths(
		pathSignals: RepoMemory["pathSignals"],
	): string[] {
		return [...pathSignals]
			.sort(
				(left, right) =>
					right.publishedCount - left.publishedCount ||
					right.successfulValidationCount - left.successfulValidationCount ||
					right.changedCount - left.changedCount ||
					right.candidateCount - left.candidateCount ||
					right.lastSeenAt.localeCompare(left.lastSeenAt),
			)
			.map((signal) => signal.path)
			.slice(0, 12);
	}

	private bumpCandidatePaths(
		currentSignals: RepoMemory["pathSignals"],
		candidateFiles: string[],
		now: string,
	): RepoMemory["pathSignals"] {
		const nextSignals = new Map(
			currentSignals.map((signal) => [signal.path, { ...signal }]),
		);

		for (const path of candidateFiles) {
			const current = nextSignals.get(path) ?? {
				path,
				candidateCount: 0,
				changedCount: 0,
				successfulValidationCount: 0,
				publishedCount: 0,
				lastSeenAt: now,
			};

			nextSignals.set(path, {
				...current,
				candidateCount: current.candidateCount + 1,
				lastSeenAt: now,
			});
		}

		return [...nextSignals.values()]
			.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
			.slice(0, 50);
	}

	private recordChangedPaths(
		currentSignals: RepoMemory["pathSignals"],
		changedFiles: string[],
		input: { now: string; validationSucceeded: boolean; published: boolean },
	): RepoMemory["pathSignals"] {
		const nextSignals = new Map(
			currentSignals.map((signal) => [signal.path, { ...signal }]),
		);

		for (const path of changedFiles) {
			const current = nextSignals.get(path) ?? {
				path,
				candidateCount: 0,
				changedCount: 0,
				successfulValidationCount: 0,
				publishedCount: 0,
				lastSeenAt: input.now,
			};

			nextSignals.set(path, {
				...current,
				changedCount: current.changedCount + 1,
				successfulValidationCount:
					current.successfulValidationCount +
					(input.validationSucceeded ? 1 : 0),
				publishedCount: current.publishedCount + (input.published ? 1 : 0),
				lastSeenAt: input.now,
			});
		}

		return [...nextSignals.values()]
			.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
			.slice(0, 50);
	}

	private recordValidationFailures(
		currentSignals: RepoMemory["validationSignals"],
		validationResults: TestResult[],
		now: string,
	): RepoMemory["validationSignals"] {
		const nextSignals = new Map(
			currentSignals.map((signal) => [signal.command, { ...signal }]),
		);

		for (const result of validationResults.filter((result) => !result.passed)) {
			const current = nextSignals.get(result.command) ?? {
				command: result.command,
				failureCount: 0,
				lastExitCode: null,
				lastSeenAt: now,
			};

			nextSignals.set(result.command, {
				...current,
				failureCount: current.failureCount + 1,
				lastExitCode: result.exitCode,
				lastSeenAt: now,
				sampleOutput:
					result.output.trim().replace(/\s+/g, " ").slice(0, 180) ||
					current.sampleOutput,
			});
		}

		return [...nextSignals.values()]
			.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
			.slice(0, 20);
	}

	private resolveIssueStatus(input: {
		changedFiles: string[];
		published: boolean;
		pullRequestUrl?: string;
		reviewRequired: boolean;
		validationSucceeded: boolean;
	}): RepoMemory["recentIssues"][number]["status"] {
		if (input.published) {
			return "published";
		}

		if (input.pullRequestUrl) {
			return "pr_opened";
		}

		if (input.reviewRequired) {
			return "review_required";
		}

		if (input.changedFiles.length > 0 && input.validationSucceeded) {
			return "validated";
		}

		return "draft_only";
	}
}

export const memoryService = new MemoryService();

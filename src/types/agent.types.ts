import type { PatchDraft, PullRequestDraft } from "../contracts/index.js";
import type { MatchedIssue } from "./github.types.js";

export interface OpportunityBreakdown {
	technicalFit: number;
	freshness: number;
	onboardingClarity: number;
	mergePotential: number;
	impact: number;
}

export interface OpportunityAnalysis {
	score: number;
	overallScore: number;
	summary: string;
	breakdown: OpportunityBreakdown;
}

export interface RankedIssue extends MatchedIssue {
	opportunity: OpportunityAnalysis;
}

export interface TestCommand {
	command: string;
	reason: string;
	source: "tool-default" | "repo-script";
}

export interface TestResult {
	command: string;
	exitCode: number | null;
	passed: boolean;
	output: string;
}

export interface RepoFileSnippet {
	path: string;
	content: string;
}

export interface GeneratedFileChange {
	path: string;
	reason: string;
	content: string;
}

export interface SkippedGeneratedFileChange {
	path: string;
	reason: string;
}

export interface GeneratedChangeApplyResult {
	appliedFiles: string[];
	skippedFiles: SkippedGeneratedFileChange[];
	reviewRequired: boolean;
	reviewReason?: string;
}

export interface ImplementationDraft {
	summary: string;
	fileChanges: GeneratedFileChange[];
}

export interface RepoWorkspaceContext {
	workspacePath: string;
	workspaceDirty: boolean;
	defaultBranch: string;
	branchName?: string;
	topLevelFiles: string[];
	candidateFiles: string[];
	snippets: RepoFileSnippet[];
	testCommands: TestCommand[];
	validationCommands: TestCommand[];
	validationWarnings: string[];
	testResults: TestResult[];
}

export interface RepoMemoryIssueRecord {
	reference: string;
	title: string;
	overallScore: number;
	generatedAt: string;
	status:
		| "selected"
		| "draft_only"
		| "review_required"
		| "validated"
		| "published"
		| "pr_opened";
	changedFiles: string[];
	published: boolean;
	reviewRequired: boolean;
	validationSummary: string;
	pullRequestUrl?: string;
}

export interface RepoMemoryRunStats {
	totalRuns: number;
	publishedRuns: number;
	realPrRuns: number;
	reviewRequiredRuns: number;
	successfulValidationRuns: number;
	failedValidationRuns: number;
}

export interface RepoMemoryPathSignal {
	path: string;
	candidateCount: number;
	changedCount: number;
	successfulValidationCount: number;
	publishedCount: number;
	lastSeenAt: string;
}

export interface RepoMemoryValidationSignal {
	command: string;
	failureCount: number;
	lastExitCode: number | null;
	lastSeenAt: string;
	sampleOutput?: string;
}

export interface RepoMemory {
	repoFullName: string;
	firstSeenAt: string;
	lastUpdatedAt: string;
	lastSelectedIssue?: string;
	workspacePath?: string;
	lastBranchName?: string;
	detectedTestCommands: string[];
	preferredPaths: string[];
	generatedDossiers: number;
	runStats: RepoMemoryRunStats;
	pathSignals: RepoMemoryPathSignal[];
	validationSignals: RepoMemoryValidationSignal[];
	recentIssues: RepoMemoryIssueRecord[];
}

export type InboxStatus = "scouted" | "drafted" | "ready";

export interface ContributionInboxItem {
	id: string;
	repoFullName: string;
	issueNumber: number;
	issueTitle: string;
	summary: string;
	overallScore: number;
	opportunityScore: number;
	status: InboxStatus;
	artifactDir: string;
	generatedAt: string;
}

export interface ProofOfWorkRecord {
	id: string;
	repoFullName: string;
	issueNumber: number;
	issueTitle: string;
	overallScore: number;
	opportunityScore: number;
	branchName?: string;
	artifactDir: string;
	generatedAt: string;
	published: boolean;
	pullRequestUrl?: string;
	pullRequestNumber?: number;
}

export interface ContributionArtifacts {
	artifactDir: string;
	dossierPath: string;
	patchDraftPath: string;
	prDraftPath: string;
	memoryPath: string;
	inboxPath: string;
	proofOfWorkPath: string;
}

export interface ContributionAgentResult {
	issue: RankedIssue;
	workspace: RepoWorkspaceContext;
	memory: RepoMemory;
	patchDraft: PatchDraft;
	prDraft: PullRequestDraft;
	dossier: string;
	artifacts: ContributionArtifacts;
	inboxItem: ContributionInboxItem;
	proofRecord: ProofOfWorkRecord;
	changedFiles?: string[];
	pullRequestUrl?: string;
}

export type AgentRunStatus = "running" | "success" | "failed" | "cancelled";

export interface AgentRunRecord {
	id: string;
	commandName: string;
	args: string[];
	status: AgentRunStatus;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	error?: string;
}

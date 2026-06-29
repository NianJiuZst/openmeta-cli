import type { PatchDraft, PullRequestDraft } from '../contracts/index.js';
import type { MatchedIssue } from './github.types.js';

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

export type ScoutFeasibilityLevel = 'ready' | 'likely_fixable' | 'risky' | 'likely_blocked' | 'unknown';
export type ScoutIssueScope =
  | 'docs_only'
  | 'config_only'
  | 'test_only'
  | 'small_code_change'
  | 'runtime_bug'
  | 'performance'
  | 'hardware_specific'
  | 'unknown';

export interface ScoutFeasibilityHint {
  level: ScoutFeasibilityLevel;
  issueScope: ScoutIssueScope;
  repoRisks: string[];
  issueRisks: string[];
  missingLocalCapabilities: string[];
  mitigations: string[];
  confidence: 'low' | 'medium' | 'high';
  scoreAdjustment: number;
  adjustedOverallScore: number;
  explanation: string;
}

export interface RankedIssue extends MatchedIssue {
  opportunity: OpportunityAnalysis;
  scoutFeasibility?: ScoutFeasibilityHint;
}

export interface TestCommand {
  command: string;
  reason: string;
  source: 'tool-default' | 'repo-script';
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

export interface RepositoryRuleFile {
  path: string;
  content: string;
}

export interface RepositoryContributionRules {
  detectedFiles: string[];
  summary: string[];
  prTemplateBody?: string;
  prTitleRule?: string;
  commitMessageRule?: string;
  branchNamingRule?: string;
  requiredChecklistItems: string[];
  requiredValidationNotes: string[];
  requiredIssueLinking?: string;
  allowsDraftPr?: boolean;
  requiresPriorDiscussion: boolean;
  missingRequirements: string[];
  blockingRequirements: string[];
  requiredReleaseNotes: boolean;
  requiredDiscussionEvidence: boolean;
}

export interface RepositoryRulesSnapshot {
  repoFullName: string;
  cacheKey: string;
  cachedAt: string;
  detectedFiles: Array<{
    path: string;
    mtimeMs: number;
    size: number;
  }>;
  rules: RepositoryContributionRules;
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
  repositoryRules?: RepositoryContributionRules;
}

export interface RepoMemoryIssueRecord {
  reference: string;
  title: string;
  overallScore: number;
  generatedAt: string;
  status: 'selected' | 'draft_only' | 'review_required' | 'validated' | 'published' | 'pr_opened';
  changedFiles: string[];
  published: boolean;
  reviewRequired: boolean;
  validationSummary: string;
  pullRequestUrl?: string;
  reviewReason?: string;
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

export type InboxStatus = 'scouted' | 'drafted' | 'ready';

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
  reviewReason?: string;
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

export type AgentRunStatus = 'running' | 'success' | 'failed' | 'cancelled';

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

export type AgentEventType = 'run_started' | 'run_finished' | 'run_cancelled' | 'run_failed' | 'permission_decision';

export interface AgentEventLogEntry {
  version: 1;
  id: string;
  runId: string;
  type: AgentEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export type PermissionDecisionOutcome = 'allow' | 'deny' | 'ask' | 'review';
export type PermissionRiskLevel = 'low' | 'medium' | 'high';

export interface PermissionDecision {
  outcome: PermissionDecisionOutcome;
  action: string;
  riskLevel: PermissionRiskLevel;
  reason: string;
  details?: Record<string, unknown>;
}

export interface AgentCapability<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  riskLevel: PermissionRiskLevel;
  inputSchemaName: string;
  outputSchemaName: string;
  execute?: (input: Input) => Promise<Output> | Output;
}

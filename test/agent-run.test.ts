import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as infra from '../src/infra/index.js';
import { AgentOrchestrator } from '../src/orchestration/agent.js';
import { AnalyzeOrchestrator } from '../src/orchestration/analyze.js';
import {
	contentService,
	inboxService,
	issueRankingService,
	llmService,
	memoryService,
	proofOfWorkService,
	workspaceService,
} from '../src/services/index.js';
import type { AppConfig, ContributionAgentResult, RankedIssue } from '../src/types/index.js';
import {
	createInboxItem,
	createMemory,
	createPatchDraft,
	createProofRecord,
	createPullRequestDraft,
	createRankedIssue,
	createRepositorySuggestion,
	createWorkspace,
} from './helpers/factories.js';

interface AgentRunInternals {
	run(options?: {
		headless?: boolean;
		force?: boolean;
		schedulerRun?: boolean;
		runChecks?: boolean;
		draftOnly?: boolean;
		refresh?: boolean;
		repo?: string;
		issue?: string;
		dryRun?: boolean;
	}): Promise<void>;
	confirmManualHeadlessRun(config: AppConfig): Promise<void>;
	initializeClients(config: AppConfig, options?: { validateLlm?: boolean }): Promise<void>;
	promptForIssue(issues: RankedIssue[]): Promise<RankedIssue>;
	generateConcretePatch(
		issue: RankedIssue,
		workspace: ReturnType<typeof createWorkspace>,
		patchDraft: ReturnType<typeof createPatchDraft>,
		runChecks: boolean,
		draftOnly?: boolean,
	): Promise<{
		changedFiles: string[];
		validationResults: ReturnType<typeof createWorkspace>['testResults'];
		reviewRequired: boolean;
	}>;
	submitContributionPullRequestIfPossible(input: unknown): Promise<{
		branchName?: string;
		url?: string;
		number?: number;
		changedFiles: string[];
		validationResults: ReturnType<typeof createWorkspace>['testResults'];
	}>;
	publishArtifactsIfNeeded(input: unknown): Promise<{ published: boolean }>;
	prepareLocalArtifactPaths(issue: RankedIssue): ContributionAgentResult['artifacts'];
	writeLocalArtifacts(input: unknown): void;
	showResult(result: ContributionAgentResult): void;
	showStructuredReviewNotice(input: { title: string; subtitle: string; lines?: string[] }): void;
}

interface AnalyzeRunInternals {
	run(options: {
		repo?: string;
		headless?: boolean;
		runChecks?: boolean;
		dryRun?: boolean;
	}): Promise<void>;
	initializeClients(config: AppConfig): Promise<void>;
	promptForSuggestion<T>(suggestions: T[]): Promise<T>;
	prepareArtifactPaths(
		repoFullName: string,
		suggestionId: string,
	): {
		artifactDir: string;
		analysisPath: string;
		patchDraftPath: string;
		prDraftPath: string;
	};
	writeLocalArtifacts(input: unknown): void;
	showResult(input: unknown): void;
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		userProfile: {
			techStack: ['typescript', 'react'],
			proficiency: 'intermediate',
			focusAreas: ['frontend'],
		},
		github: {
			pat: 'ghp_test_token',
			username: 'octocat',
		},
		llm: {
			provider: 'custom',
			apiBaseUrl: 'https://example.com/v1',
			apiKey: 'sk-test',
			modelName: 'test-model',
			apiHeaders: {},
		},
		automation: {
			enabled: true,
			scheduleTime: '09:00',
			timezone: 'UTC',
			contentType: 'research_note',
			scheduler: 'manual',
			minMatchScore: 75,
			skipIfAlreadyGeneratedToday: false,
		},
		scoring: {
			weights: {
				freshness: 0.25,
				onboardingClarity: 0.25,
				mergePotential: 0.3,
				impact: 0.2,
				riskPenalty: 0.35,
			},
			overallWeights: { technicalMatch: 0.45, opportunityScore: 0.55 },
			preset: 'balanced',
		},
		commitTemplate: 'feat: {title}',
		...overrides,
	};
}

function createArtifacts(): ContributionAgentResult['artifacts'] {
	return {
		artifactDir: '/tmp/openmeta/artifacts',
		dossierPath: '/tmp/openmeta/artifacts/dossier.md',
		patchDraftPath: '/tmp/openmeta/artifacts/patch-draft.md',
		prDraftPath: '/tmp/openmeta/artifacts/pr-draft.md',
		memoryPath: '/tmp/openmeta/artifacts/repo-memory.md',
		inboxPath: '/tmp/openmeta/artifacts/inbox.md',
		proofOfWorkPath: '/tmp/openmeta/artifacts/proof-of-work.md',
	};
}

function muteUi(): void {
	spyOn(infra.ui, 'hero').mockImplementation(() => {});
	spyOn(infra.ui, 'stepper').mockImplementation(() => {});
	spyOn(infra.ui, 'section').mockImplementation(() => {});
	spyOn(infra.ui, 'recordList').mockImplementation(() => {});
	spyOn(infra.ui, 'card').mockImplementation(() => {});
	spyOn(infra.ui, 'stats').mockImplementation(() => {});
	spyOn(infra.ui, 'keyValues').mockImplementation(() => {});
	spyOn(infra.ui, 'callout').mockImplementation(() => {});
	spyOn(infra.ui, 'emptyState').mockImplementation(() => {});
	spyOn(infra.ui, 'banner').mockImplementation(() => {});
	spyOn(infra.ui, 'timeline').mockImplementation(() => {});
	spyOn(infra.ui, 'task').mockImplementation(async (_options, task) =>
		task({
			setMessage() {},
		} as never),
	);
}

beforeEach(() => {
	muteUi();
});

afterEach(() => {
	mock.restore();
});

describe('AgentOrchestrator run flow', () => {
	test('confirms manual headless runs before returning when no ranked issues are found', async () => {
		const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
		const config = createConfig();
		const emptyStateSpy = spyOn(infra.ui, 'emptyState').mockImplementation(() => {});
		const confirmSpy = spyOn(
			orchestrator as object as {
				confirmManualHeadlessRun: AgentRunInternals['confirmManualHeadlessRun'];
			},
			'confirmManualHeadlessRun',
		).mockResolvedValue(undefined);
		spyOn(infra.configService, 'get').mockResolvedValue(config);
		spyOn(
			orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
			'initializeClients',
		).mockResolvedValue(undefined);
		spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([]);

		await orchestrator.run({ headless: true });

		expect(confirmSpy).toHaveBeenCalledWith(config);
		expect(emptyStateSpy).toHaveBeenCalledWith(
			'OpenMeta Agent',
			'No viable issues found',
			'No issues met the current technical match threshold. Broaden your profile or try again later.',
		);
	});

	test('returns early when automation cannot select an issue above the threshold', async () => {
		const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
		const issue = createRankedIssue();
		const emptyStateSpy = spyOn(infra.ui, 'emptyState').mockImplementation(() => {});
		spyOn(infra.configService, 'get').mockResolvedValue(createConfig());
		spyOn(
			orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
			'initializeClients',
		).mockResolvedValue(undefined);
		spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([issue]);
		spyOn(issueRankingService, 'selectIssueForAutomation').mockReturnValue(undefined);

		await orchestrator.run({ headless: true, schedulerRun: true });

		expect(emptyStateSpy).toHaveBeenCalledWith(
			'OpenMeta Agent',
			'No issue met the automation threshold',
			'Top opportunities were below 75/100. Lower the threshold or widen your profile.',
		);
	});

	test('runs the full interactive flow and records a published outcome', async () => {
		const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
		const config = createConfig();
		const issue = createRankedIssue({ repoFullName: 'acme/demo', number: 42 });
		const memory = createMemory();
		const workspace = createWorkspace({
			workspacePath: '/tmp/openmeta-demo',
			branchName: 'openmeta/42-accessibility',
		});
		const patchDraft = createPatchDraft();
		const prDraft = createPullRequestDraft();
		const validationResults = [
			{ command: 'bun test', exitCode: 0, passed: true, output: '1 passed' },
		];
		const artifacts = createArtifacts();
		const showResultSpy = spyOn(
			orchestrator as object as { showResult: AgentRunInternals['showResult'] },
			'showResult',
		).mockImplementation(() => {});

		spyOn(infra.configService, 'get').mockResolvedValue(config);
		spyOn(
			orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
			'initializeClients',
		).mockResolvedValue(undefined);
		spyOn(
			orchestrator as object as { promptForIssue: AgentRunInternals['promptForIssue'] },
			'promptForIssue',
		).mockResolvedValue(issue);
		spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([issue]);
		spyOn(memoryService, 'load').mockReturnValue(memory);
		spyOn(workspaceService, 'prepareWorkspace').mockResolvedValue(workspace);
		spyOn(memoryService, 'update').mockReturnValue(memory);
		spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
			version: '1',
			kind: 'patch_draft',
			status: 'success',
			data: patchDraft,
		});
		spyOn(
			orchestrator as object as {
				generateConcretePatch: AgentRunInternals['generateConcretePatch'];
			},
			'generateConcretePatch',
		).mockResolvedValue({
			changedFiles: ['src/app.ts'],
			validationResults,
			reviewRequired: false,
		});
		spyOn(llmService, 'generatePrDraft').mockResolvedValue({
			version: '1',
			kind: 'pull_request_draft',
			status: 'success',
			data: prDraft,
		});
		spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
		spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
		spyOn(contentService, 'formatContributionDossier').mockReturnValue('# Dossier');
		spyOn(
			orchestrator as object as {
				submitContributionPullRequestIfPossible: AgentRunInternals['submitContributionPullRequestIfPossible'];
			},
			'submitContributionPullRequestIfPossible',
		).mockResolvedValue({
			branchName: 'openmeta/agent-42',
			url: 'https://github.com/acme/demo/pull/42',
			number: 42,
			changedFiles: ['src/app.ts'],
			validationResults,
		});
		spyOn(
			orchestrator as object as {
				prepareLocalArtifactPaths: AgentRunInternals['prepareLocalArtifactPaths'];
			},
			'prepareLocalArtifactPaths',
		).mockReturnValue(artifacts);
		spyOn(
			orchestrator as object as { writeLocalArtifacts: AgentRunInternals['writeLocalArtifacts'] },
			'writeLocalArtifacts',
		).mockImplementation(() => {});
		spyOn(
			orchestrator as object as {
				publishArtifactsIfNeeded: AgentRunInternals['publishArtifactsIfNeeded'];
			},
			'publishArtifactsIfNeeded',
		).mockResolvedValue({
			published: true,
		});
		spyOn(inboxService, 'saveItem').mockReturnValue([createInboxItem()]);
		spyOn(inboxService, 'renderMarkdown').mockReturnValue('# Inbox');
		spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
		spyOn(proofOfWorkService, 'renderMarkdown').mockReturnValue('# Proof');
		spyOn(proofOfWorkService, 'record').mockReturnValue([createProofRecord()]);
		spyOn(memoryService, 'renderMarkdown').mockReturnValue('# Memory');
		spyOn(memoryService, 'recordOutcome').mockReturnValue(memory);

		await orchestrator.run();

		expect(showResultSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				issue,
				workspace: expect.objectContaining({ workspacePath: workspace.workspacePath }),
				patchDraft,
				prDraft,
				pullRequestUrl: 'https://github.com/acme/demo/pull/42',
				changedFiles: ['src/app.ts'],
			}),
		);
	});

	test('runs against an explicitly targeted issue without discovery selection', async () => {
		const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
		const config = createConfig();
		const issue = createRankedIssue({
			repoFullName: 'Wei-Shaw/sub2api',
			repoName: 'sub2api',
			number: 3014,
		});
		const memory = createMemory({ repoFullName: 'Wei-Shaw/sub2api' });
		const workspace = createWorkspace({
			workspacePath: '/tmp/openmeta-sub2api',
			branchName: 'openmeta/3014-openai-compat',
		});
		const patchDraft = createPatchDraft();
		const prDraft = createPullRequestDraft();
		const artifacts = createArtifacts();
		const showResultSpy = spyOn(
			orchestrator as object as { showResult: AgentRunInternals['showResult'] },
			'showResult',
		).mockImplementation(() => {});
		const loadTargetIssueSpy = spyOn(issueRankingService, 'loadTargetIssue').mockResolvedValue([
			issue,
		]);
		const loadRankedIssuesSpy = spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue(
			[],
		);
		const promptForIssueSpy = spyOn(
			orchestrator as object as { promptForIssue: AgentRunInternals['promptForIssue'] },
			'promptForIssue',
		).mockResolvedValue(issue);

		spyOn(infra.configService, 'get').mockResolvedValue(config);
		spyOn(
			orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
			'initializeClients',
		).mockResolvedValue(undefined);
		spyOn(memoryService, 'load').mockReturnValue(memory);
		spyOn(workspaceService, 'prepareWorkspace').mockResolvedValue(workspace);
		spyOn(memoryService, 'update').mockReturnValue(memory);
		spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
			version: '1',
			kind: 'patch_draft',
			status: 'success',
			data: patchDraft,
		});
		spyOn(
			orchestrator as object as {
				generateConcretePatch: AgentRunInternals['generateConcretePatch'];
			},
			'generateConcretePatch',
		).mockResolvedValue({
			changedFiles: ['src/openai.ts'],
			validationResults: [],
			reviewRequired: false,
		});
		spyOn(llmService, 'generatePrDraft').mockResolvedValue({
			version: '1',
			kind: 'pull_request_draft',
			status: 'success',
			data: prDraft,
		});
		spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
		spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
		spyOn(contentService, 'formatContributionDossier').mockReturnValue('# Dossier');
		spyOn(
			orchestrator as object as {
				submitContributionPullRequestIfPossible: AgentRunInternals['submitContributionPullRequestIfPossible'];
			},
			'submitContributionPullRequestIfPossible',
		).mockResolvedValue({
			branchName: 'openmeta/agent-3014',
			url: 'https://github.com/Wei-Shaw/sub2api/pull/3015',
			number: 3015,
			changedFiles: ['src/openai.ts'],
			validationResults: [],
		});
		spyOn(
			orchestrator as object as {
				prepareLocalArtifactPaths: AgentRunInternals['prepareLocalArtifactPaths'];
			},
			'prepareLocalArtifactPaths',
		).mockReturnValue(artifacts);
		spyOn(
			orchestrator as object as { writeLocalArtifacts: AgentRunInternals['writeLocalArtifacts'] },
			'writeLocalArtifacts',
		).mockImplementation(() => {});
		spyOn(
			orchestrator as object as {
				publishArtifactsIfNeeded: AgentRunInternals['publishArtifactsIfNeeded'];
			},
			'publishArtifactsIfNeeded',
		).mockResolvedValue({
			published: false,
		});
		spyOn(inboxService, 'saveItem').mockReturnValue([createInboxItem()]);
		spyOn(inboxService, 'renderMarkdown').mockReturnValue('# Inbox');
		spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
		spyOn(proofOfWorkService, 'renderMarkdown').mockReturnValue('# Proof');
		spyOn(proofOfWorkService, 'record').mockReturnValue([createProofRecord()]);
		spyOn(memoryService, 'renderMarkdown').mockReturnValue('# Memory');
		spyOn(memoryService, 'recordOutcome').mockReturnValue(memory);

		await orchestrator.run({ issue: 'https://github.com/Wei-Shaw/sub2api/issues/3014' });

		expect(loadTargetIssueSpy).toHaveBeenCalledWith(config, {
			repoFullName: 'Wei-Shaw/sub2api',
			issueNumber: 3014,
		});
		expect(loadRankedIssuesSpy).not.toHaveBeenCalled();
		expect(promptForIssueSpy).not.toHaveBeenCalled();
		expect(showResultSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				issue,
				pullRequestUrl: 'https://github.com/Wei-Shaw/sub2api/pull/3015',
				changedFiles: ['src/openai.ts'],
			}),
		);
	});

	test('keeps the run in review mode when patch and PR drafts require review', async () => {
		const orchestrator = new AgentOrchestrator() as unknown as AgentRunInternals;
		const issue = createRankedIssue();
		const memory = createMemory();
		const workspace = createWorkspace({
			testResults: [],
		});
		const patchDraft = createPatchDraft({ goal: 'Needs review goal' });
		const prDraft = createPullRequestDraft({ title: 'Needs review title' });
		const reviewNoticeSpy = spyOn(
			orchestrator as object as {
				showStructuredReviewNotice: AgentRunInternals['showStructuredReviewNotice'];
			},
			'showStructuredReviewNotice',
		).mockImplementation(() => {});
		const generateConcretePatchSpy = spyOn(
			orchestrator as object as {
				generateConcretePatch: AgentRunInternals['generateConcretePatch'];
			},
			'generateConcretePatch',
		).mockResolvedValue({
			changedFiles: [],
			validationResults: [],
			reviewRequired: false,
		});

		spyOn(infra.configService, 'get').mockResolvedValue(createConfig());
		spyOn(
			orchestrator as object as { initializeClients: AgentRunInternals['initializeClients'] },
			'initializeClients',
		).mockResolvedValue(undefined);
		spyOn(
			orchestrator as object as { promptForIssue: AgentRunInternals['promptForIssue'] },
			'promptForIssue',
		).mockResolvedValue(issue);
		spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([issue]);
		spyOn(memoryService, 'load').mockReturnValue(memory);
		spyOn(workspaceService, 'prepareWorkspace').mockResolvedValue(workspace);
		spyOn(memoryService, 'update').mockReturnValue(memory);
		spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
			version: '1',
			kind: 'patch_draft',
			status: 'needs_review',
			data: patchDraft,
		});
		spyOn(llmService, 'generatePrDraft').mockResolvedValue({
			version: '1',
			kind: 'pull_request_draft',
			status: 'needs_review',
			data: prDraft,
		});
		spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
		spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
		spyOn(contentService, 'formatContributionDossier').mockReturnValue('# Dossier');
		spyOn(
			orchestrator as object as {
				submitContributionPullRequestIfPossible: AgentRunInternals['submitContributionPullRequestIfPossible'];
			},
			'submitContributionPullRequestIfPossible',
		).mockResolvedValue({
			changedFiles: [],
			validationResults: [],
		});
		spyOn(
			orchestrator as object as {
				prepareLocalArtifactPaths: AgentRunInternals['prepareLocalArtifactPaths'];
			},
			'prepareLocalArtifactPaths',
		).mockReturnValue(createArtifacts());
		spyOn(
			orchestrator as object as { writeLocalArtifacts: AgentRunInternals['writeLocalArtifacts'] },
			'writeLocalArtifacts',
		).mockImplementation(() => {});
		spyOn(
			orchestrator as object as {
				publishArtifactsIfNeeded: AgentRunInternals['publishArtifactsIfNeeded'];
			},
			'publishArtifactsIfNeeded',
		).mockResolvedValue({
			published: false,
		});
		spyOn(inboxService, 'saveItem').mockReturnValue([createInboxItem()]);
		spyOn(inboxService, 'renderMarkdown').mockReturnValue('# Inbox');
		spyOn(proofOfWorkService, 'load').mockReturnValue({ records: [] });
		spyOn(proofOfWorkService, 'renderMarkdown').mockReturnValue('# Proof');
		spyOn(proofOfWorkService, 'record').mockReturnValue([createProofRecord()]);
		spyOn(memoryService, 'renderMarkdown').mockReturnValue('# Memory');
		const recordOutcomeSpy = spyOn(memoryService, 'recordOutcome').mockReturnValue(memory);
		const showResultSpy = spyOn(
			orchestrator as object as { showResult: AgentRunInternals['showResult'] },
			'showResult',
		).mockImplementation(() => {});

		await orchestrator.run();

		expect(generateConcretePatchSpy).not.toHaveBeenCalled();
		expect(reviewNoticeSpy).toHaveBeenCalledTimes(2);
		expect(recordOutcomeSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				published: false,
				reviewRequired: true,
			}),
		);
		expect(showResultSpy).toHaveBeenCalled();
	});
});

describe('AnalyzeOrchestrator run flow', () => {
	test('analyzes a repository, selects the top suggestion in headless mode, and writes draft artifacts', async () => {
		const orchestrator = new AnalyzeOrchestrator() as unknown as AnalyzeRunInternals;
		const config = createConfig();
		const workspace = createWorkspace({
			workspacePath: '/tmp/openmeta-demo',
			branchName: 'openmeta/analyze-acme-demo',
			candidateFiles: ['README.md', 'src/index.ts'],
		});
		const memory = createMemory({ repoFullName: 'acme/demo' });
		const topSuggestion = createRepositorySuggestion({
			id: 'config-validation',
			title: 'Add config validation tests',
			summary: 'Cover malformed provider config normalization.',
			targetFiles: [{ path: 'src/infra/config.ts', reason: 'Normalization logic' }],
			prPotentialScore: 93,
		});
		const lowerSuggestion = createRepositorySuggestion({
			id: 'docs-install',
			title: 'Document local install',
			prPotentialScore: 75,
		});
		const patchDraft = createPatchDraft();
		const prDraft = createPullRequestDraft();
		const artifacts = {
			artifactDir: '/tmp/openmeta/artifacts/analyze',
			analysisPath: '/tmp/openmeta/artifacts/analyze/repository-analysis.md',
			patchDraftPath: '/tmp/openmeta/artifacts/analyze/patch-draft.md',
			prDraftPath: '/tmp/openmeta/artifacts/analyze/pr-draft.md',
		};
		const writeArtifactsSpy = spyOn(
			orchestrator as object as { writeLocalArtifacts: AnalyzeRunInternals['writeLocalArtifacts'] },
			'writeLocalArtifacts',
		).mockImplementation(() => {});
		const showResultSpy = spyOn(
			orchestrator as object as { showResult: AnalyzeRunInternals['showResult'] },
			'showResult',
		).mockImplementation(() => {});
		const promptForSuggestionSpy = spyOn(
			orchestrator as object as { promptForSuggestion: AnalyzeRunInternals['promptForSuggestion'] },
			'promptForSuggestion',
		).mockResolvedValue(lowerSuggestion);

		spyOn(infra.configService, 'get').mockResolvedValue(config);
		spyOn(
			orchestrator as object as { initializeClients: AnalyzeRunInternals['initializeClients'] },
			'initializeClients',
		).mockResolvedValue(undefined);
		spyOn(memoryService, 'load').mockReturnValue(memory);
		spyOn(workspaceService, 'prepareRepositoryWorkspace').mockResolvedValue(workspace);
		spyOn(llmService, 'analyzeRepository').mockResolvedValue({
			version: '1',
			kind: 'repository_suggestion_list',
			status: 'success',
			data: [lowerSuggestion, topSuggestion],
		});
		spyOn(llmService, 'generatePatchDraft').mockResolvedValue({
			version: '1',
			kind: 'patch_draft',
			status: 'success',
			data: patchDraft,
		});
		spyOn(llmService, 'generatePrDraft').mockResolvedValue({
			version: '1',
			kind: 'pull_request_draft',
			status: 'success',
			data: prDraft,
		});
		spyOn(contentService, 'formatRepositoryAnalysisMarkdown').mockReturnValue(
			'# Repository Analysis',
		);
		spyOn(contentService, 'formatPatchDraftMarkdown').mockReturnValue('# Patch');
		spyOn(contentService, 'formatPullRequestDraftMarkdown').mockReturnValue('# PR');
		spyOn(
			orchestrator as object as {
				prepareArtifactPaths: AnalyzeRunInternals['prepareArtifactPaths'];
			},
			'prepareArtifactPaths',
		).mockReturnValue(artifacts);

		await orchestrator.run({ repo: 'https://github.com/acme/demo', headless: true });

		expect(promptForSuggestionSpy).not.toHaveBeenCalled();
		expect(workspaceService.prepareRepositoryWorkspace).toHaveBeenCalledWith(
			'acme/demo',
			memory,
			false,
			'headless',
		);
		expect(llmService.generatePatchDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				repoFullName: 'acme/demo',
				number: 0,
				title: 'Add config validation tests',
				analysis: expect.objectContaining({
					coreDemand: 'Cover malformed provider config normalization.',
				}),
			}),
			workspace,
			memory,
		);
		expect(writeArtifactsSpy).toHaveBeenCalledWith({
			artifacts,
			analysisMarkdown: '# Repository Analysis',
			patchDraftMarkdown: '# Patch',
			prDraftMarkdown: '# PR',
		});
		expect(showResultSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				repoFullName: 'acme/demo',
				selectedSuggestion: topSuggestion,
				artifacts,
			}),
		);
	});
});

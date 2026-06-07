import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type {
	PatchDraft,
	PullRequestDraft,
	RepositoryImprovementSuggestion,
} from '../contracts/index.js';
import {
	configService,
	ensureDirectory,
	getLocalDateStamp,
	getOpenMetaArtifactRoot,
	logger,
	parseGitHubRepoFullName,
	selectPrompt,
	ui,
} from '../infra/index.js';
import {
	contentService,
	githubService,
	llmService,
	memoryService,
	workspaceService,
} from '../services/index.js';
import type { AppConfig, RankedIssue, RepoWorkspaceContext } from '../types/index.js';

export interface AnalyzeRunOptions {
	repo?: string;
	headless?: boolean;
	runChecks?: boolean;
	dryRun?: boolean;
}

interface AnalyzeArtifacts {
	artifactDir: string;
	analysisPath: string;
	patchDraftPath: string;
	prDraftPath: string;
}

interface AnalyzeResult {
	repoFullName: string;
	workspace: RepoWorkspaceContext;
	selectedSuggestion: RepositoryImprovementSuggestion;
	patchDraft: PatchDraft;
	prDraft: PullRequestDraft;
	artifacts: AnalyzeArtifacts;
}

export class AnalyzeOrchestrator {
	async run(options: AnalyzeRunOptions = {}): Promise<void> {
		if (!options.repo) {
			throw new Error(
				'Repository analysis requires --repo, for example: openmeta analyze --repo owner/name.',
			);
		}

		const repoFullName = parseGitHubRepoFullName(options.repo);
		const config = await configService.get();
		const headless = Boolean(options.headless);
		const runChecks = Boolean(options.runChecks);

		ui.hero({
			label: 'OpenMeta Analyze',
			title: 'Find a contribution path even when the issue tracker is quiet',
			subtitle:
				'OpenMeta will inspect the repository, ask the model for grounded improvement ideas, and draft PR-ready artifacts for the strongest suggestion.',
			lines: [
				`Repository: ${repoFullName}`,
				runChecks
					? 'Detected validation commands may run during workspace preparation.'
					: 'This analysis will skip baseline validation commands.',
				headless
					? 'Headless mode will select the highest-scoring suggestion automatically.'
					: 'You can choose which suggestion should become the draft target.',
			],
		});

		await this.validateConfig(config);
		await this.initializeClients(config);

		const memory = memoryService.load(repoFullName);
		const workspace = await ui.task(
			{
				title: `Preparing repository workspace for ${repoFullName}`,
				doneMessage: 'Repository workspace prepared',
				failedMessage: 'Repository workspace preparation failed',
				tone: 'info',
			},
			async () =>
				workspaceService.prepareRepositoryWorkspace(
					repoFullName,
					memory,
					runChecks,
					headless ? 'headless' : 'interactive',
				),
		);

		this.showWorkspaceSummary(workspace);

		const suggestionsResult = await ui.task(
			{
				title: 'Analyzing repository contribution paths',
				doneMessage: 'Repository suggestions generated',
				failedMessage: 'Repository analysis failed',
				tone: 'info',
			},
			async () => llmService.analyzeRepository(repoFullName, workspace, memory),
		);
		const suggestions = suggestionsResult.data;
		if (suggestions.length === 0) {
			ui.emptyState(
				'OpenMeta Analyze',
				'No repository suggestions generated',
				'The model did not find a grounded contribution path from the current repository context.',
			);
			return;
		}

		this.showSuggestions(suggestions);
		const selectedSuggestion = headless
			? this.selectTopSuggestion(suggestions)
			: await this.promptForSuggestion(suggestions);
		const syntheticIssue = this.buildSyntheticIssue(repoFullName, selectedSuggestion);

		const patchDraftResult = await ui.task(
			{
				title: 'Generating patch strategy for selected suggestion',
				doneMessage: 'Patch strategy generated',
				failedMessage: 'Patch strategy generation failed',
				tone: 'info',
			},
			async () => llmService.generatePatchDraft(syntheticIssue, workspace, memory),
		);
		const patchDraft = patchDraftResult.data;

		const prDraftResult = await ui.task(
			{
				title: 'Generating PR narrative',
				doneMessage: 'PR narrative generated',
				failedMessage: 'PR narrative generation failed',
				tone: 'info',
			},
			async () => llmService.generatePrDraft(syntheticIssue, patchDraft, workspace),
		);
		const prDraft = prDraftResult.data;

		const artifacts = this.prepareArtifactPaths(repoFullName, selectedSuggestion.id);
		const analysisMarkdown = contentService.formatRepositoryAnalysisMarkdown(
			repoFullName,
			workspace,
			suggestions,
			selectedSuggestion,
		);
		const patchDraftMarkdown = contentService.formatPatchDraftMarkdown(patchDraft);
		const prDraftMarkdown = contentService.formatPullRequestDraftMarkdown(prDraft);

		if (options.dryRun) {
			ui.callout({
				label: 'OpenMeta Analyze',
				title: 'Dry-run artifact preview',
				subtitle: 'No repository analysis files were written.',
				lines: [artifacts.analysisPath, artifacts.patchDraftPath, artifacts.prDraftPath],
				tone: 'info',
			});
		} else {
			await ui.task(
				{
					title: 'Writing repository analysis artifacts',
					doneMessage: 'Repository analysis artifacts written',
					failedMessage: 'Repository analysis artifact write failed',
					tone: 'info',
				},
				async () => {
					this.writeLocalArtifacts({
						artifacts,
						analysisMarkdown,
						patchDraftMarkdown,
						prDraftMarkdown,
					});
				},
			);
		}

		this.showResult({
			repoFullName,
			workspace,
			selectedSuggestion,
			patchDraft,
			prDraft,
			artifacts,
		});
	}

	private async validateConfig(config: AppConfig): Promise<void> {
		if (!config.github.pat || !config.github.username) {
			throw new Error('GitHub configuration is incomplete. Please run "openmeta init" first.');
		}

		if (!config.llm.apiKey) {
			throw new Error('LLM API configuration is incomplete. Please run "openmeta init" first.');
		}
	}

	private async initializeClients(config: AppConfig): Promise<void> {
		githubService.initialize(config.github.pat, config.github.username);
		const ghValid = await ui.task(
			{
				title: 'Validating GitHub access',
				doneMessage: 'GitHub access verified',
				failedMessage: 'GitHub access failed',
				tone: 'info',
			},
			async () => {
				const valid = await githubService.validateCredentials();
				if (!valid) {
					throw new Error('GitHub validation failed');
				}
				return true;
			},
		);
		if (!ghValid) {
			throw new Error(
				'GitHub credentials validation failed. Run "openmeta init" to refresh your token.',
			);
		}
		llmService.initialize(
			config.llm.apiKey,
			config.llm.apiBaseUrl,
			config.llm.modelName,
			config.llm.apiHeaders,
			config.llm.provider,
			config.llm.reasoningEffort,
			config.llm.stream === true,
		);
		const llmValid = await ui.task(
			{
				title: 'Validating LLM provider',
				doneMessage: 'LLM provider verified',
				failedMessage: 'LLM provider failed',
				tone: 'info',
			},
			async () => {
				const valid = await llmService.validateConnection();
				if (!valid) {
					const detail = llmService.getLastValidationError();
					throw new Error(`LLM validation failed${detail ? `: ${detail}` : ''}`);
				}
				return true;
			},
		);
		if (!llmValid) {
			throw new Error(
				'LLM API connection failed. Run "openmeta init" to update your provider settings.',
			);
		}
	}

	private showWorkspaceSummary(workspace: RepoWorkspaceContext): void {
		ui.stats('Repository workspace', [
			{ label: 'Candidate files', value: String(workspace.candidateFiles.length), tone: 'success' },
			{
				label: 'Detected checks',
				value: String(workspace.testCommands.length),
				tone: workspace.testCommands.length > 0 ? 'info' : 'muted',
			},
			{
				label: 'Runnable checks',
				value: String(workspace.validationCommands.length),
				tone: workspace.validationCommands.length > 0 ? 'accent' : 'muted',
			},
			{
				label: 'Dirty workspace',
				value: workspace.workspaceDirty ? 'YES' : 'NO',
				tone: workspace.workspaceDirty ? 'warning' : 'success',
			},
		]);
		ui.keyValues('Repository context', [
			{ label: 'Path', value: workspace.workspacePath, tone: 'info' },
			{ label: 'Default branch', value: workspace.defaultBranch, tone: 'info' },
			{
				label: 'Analysis branch',
				value: workspace.branchName || 'workspace already dirty',
				tone: 'info',
			},
			{
				label: 'Candidate files',
				value: workspace.candidateFiles.slice(0, 8).join(', ') || 'n/a',
				tone: 'info',
			},
		]);
	}

	private showSuggestions(suggestions: RepositoryImprovementSuggestion[]): void {
		ui.recordList(
			'Repository suggestions',
			suggestions.slice(0, 5).map((suggestion) => ({
				title: suggestion.title,
				subtitle: suggestion.summary,
				meta: [
					`score ${suggestion.prPotentialScore}`,
					`workload ${suggestion.estimatedWorkload}`,
					`id ${suggestion.id}`,
				],
				lines: [
					`Files: ${suggestion.targetFiles.map((file) => file.path).join(', ')}`,
					`Validation: ${suggestion.validationPlan.join('; ') || 'not specified'}`,
				],
				tone: suggestion.prPotentialScore >= 80 ? 'success' : 'info',
			})),
		);
	}

	private selectTopSuggestion(
		suggestions: RepositoryImprovementSuggestion[],
	): RepositoryImprovementSuggestion {
		const [selected] = [...suggestions].sort(
			(left, right) => right.prPotentialScore - left.prPotentialScore,
		);
		if (!selected) {
			throw new Error('No repository suggestions are available to select.');
		}

		return selected;
	}

	private async promptForSuggestion(
		suggestions: RepositoryImprovementSuggestion[],
	): Promise<RepositoryImprovementSuggestion> {
		return selectPrompt<RepositoryImprovementSuggestion>({
			message: 'Select a repository suggestion to draft:',
			pageSize: Math.min(10, suggestions.length),
			choices: suggestions.slice(0, 5).map((suggestion) => ({
				name: suggestion.title,
				description: `score ${suggestion.prPotentialScore} | ${suggestion.summary.slice(0, 72)}`,
				value: suggestion,
			})),
		});
	}

	private buildSyntheticIssue(
		repoFullName: string,
		suggestion: RepositoryImprovementSuggestion,
	): RankedIssue {
		const now = new Date().toISOString();
		const repoName = repoFullName.split('/').at(-1) || repoFullName;

		return {
			id: 0,
			number: 0,
			title: suggestion.title,
			body: [
				suggestion.summary,
				'',
				suggestion.rationale,
				'',
				'Target files:',
				...suggestion.targetFiles.map((file) => `- ${file.path}: ${file.reason}`),
				'',
				'Proposed changes:',
				...suggestion.proposedChanges.map((change) => `- ${change}`),
				'',
				'Validation plan:',
				...suggestion.validationPlan.map((step) => `- ${step}`),
			].join('\n'),
			htmlUrl: `https://github.com/${repoFullName}`,
			repoName,
			repoFullName,
			repoDescription: 'Repository analysis suggestion generated by OpenMeta.',
			repoStars: 0,
			labels: ['openmeta-analysis'],
			createdAt: now,
			updatedAt: now,
			matchScore: suggestion.prPotentialScore,
			analysis: {
				coreDemand: suggestion.summary,
				techRequirements: suggestion.targetFiles.map((file) => file.path),
				solutionSuggestion: suggestion.proposedChanges.join(' '),
				estimatedWorkload: suggestion.estimatedWorkload,
			},
			opportunity: {
				score: suggestion.prPotentialScore,
				overallScore: suggestion.prPotentialScore,
				summary: suggestion.rationale,
				breakdown: {
					technicalFit: suggestion.prPotentialScore,
					freshness: 70,
					onboardingClarity: 70,
					mergePotential: suggestion.prPotentialScore,
					impact: suggestion.prPotentialScore,
				},
			},
		};
	}

	private prepareArtifactPaths(repoFullName: string, suggestionId: string): AnalyzeArtifacts {
		const dirName = `${repoFullName.replace(/\//g, '__')}__${suggestionId}`;
		const artifactDir = ensureDirectory(
			join(getOpenMetaArtifactRoot(), getLocalDateStamp(), 'analysis', dirName),
		);
		return {
			artifactDir,
			analysisPath: join(artifactDir, 'repository-analysis.md'),
			patchDraftPath: join(artifactDir, 'patch-draft.md'),
			prDraftPath: join(artifactDir, 'pr-draft.md'),
		};
	}

	private writeLocalArtifacts(input: {
		artifacts: AnalyzeArtifacts;
		analysisMarkdown: string;
		patchDraftMarkdown: string;
		prDraftMarkdown: string;
	}): void {
		mkdirSync(input.artifacts.artifactDir, { recursive: true });
		writeFileSync(input.artifacts.analysisPath, input.analysisMarkdown, 'utf-8');
		writeFileSync(input.artifacts.patchDraftPath, input.patchDraftMarkdown, 'utf-8');
		writeFileSync(input.artifacts.prDraftPath, input.prDraftMarkdown, 'utf-8');
	}

	private showResult(result: AnalyzeResult): void {
		logger.success(`Repository analysis artifacts written to ${result.artifacts.artifactDir}`);
		ui.hero({
			label: 'OpenMeta Analyze',
			title: 'Repository analysis produced a contribution-ready draft',
			subtitle:
				'The selected improvement now has analysis notes, a patch strategy, and a PR narrative saved locally.',
			lines: [
				`Repository: ${result.repoFullName}`,
				`Suggestion: ${result.selectedSuggestion.title}`,
				`Artifacts: ${result.artifacts.artifactDir}`,
			],
			tone: 'success',
		});
		ui.keyValues('Analysis result', [
			{ label: 'Workspace', value: result.workspace.workspacePath, tone: 'info' },
			{ label: 'Patch goal', value: result.patchDraft.goal, tone: 'info' },
			{ label: 'PR title', value: result.prDraft.title, tone: 'info' },
			{ label: 'Analysis artifact', value: result.artifacts.analysisPath, tone: 'info' },
		]);
	}
}

export const analyzeOrchestrator = new AnalyzeOrchestrator();

import { describe, expect, test } from 'bun:test';
import { githubService, issueRankingService, llmService } from '../src/services/index.js';
import { createIssue, createMatchedIssue, createRankedIssue } from './helpers/factories.js';

describe('IssueRankingService', () => {
	test('selects the first issue that meets the automation threshold', () => {
		const issues = [
			createRankedIssue({ opportunity: { ...createRankedIssue().opportunity, overallScore: 68 } }),
			createRankedIssue({
				repoFullName: 'acme/high',
				repoName: 'high',
				number: 77,
				opportunity: { ...createRankedIssue().opportunity, overallScore: 81 },
			}),
		];

		const selected = issueRankingService.selectIssueForAutomation(issues, 70);
		expect(selected?.repoFullName).toBe('acme/high');
	});

	test('diversifies scout display across repositories before filling repeats', () => {
		const issues = [
			createRankedIssue({ repoFullName: 'acme/a', repoName: 'a', number: 1 }),
			createRankedIssue({ repoFullName: 'acme/a', repoName: 'a', number: 2 }),
			createRankedIssue({ repoFullName: 'acme/b', repoName: 'b', number: 3 }),
			createRankedIssue({ repoFullName: 'acme/c', repoName: 'c', number: 4 }),
		];

		const visible = issueRankingService.diversifyScoutIssues(issues, 3);

		expect(visible.map((issue) => `${issue.repoFullName}#${issue.number}`)).toEqual([
			'acme/a#1',
			'acme/b#3',
			'acme/c#4',
		]);
	});

	test('pre-ranks issue discovery candidates against the saved profile', () => {
		const ranked = issueRankingService.rankIssuesForProfile(
			[
				createIssue({
					repoFullName: 'acme/python-tool',
					repoName: 'python-tool',
					number: 1,
					title: 'Add pytest coverage for serializers',
					body: 'Fresh issue with unrelated Python testing work.',
					repoDescription: 'Python API utilities',
					updatedAt: new Date().toISOString(),
				}),
				createIssue({
					repoFullName: 'acme/react-ui',
					repoName: 'react-ui',
					number: 2,
					title: 'Fix React keyboard focus in dropdown',
					body: 'The issue is in `src/components/Dropdown.tsx`. Steps to reproduce: tab into the menu. Expected focus moves to the first item.',
					repoDescription: 'Accessible TypeScript React components',
					updatedAt: '2026-03-01T08:00:00.000Z',
				}),
			],
			{
				techStack: ['TypeScript', 'React'],
				proficiency: 'intermediate',
				focusAreas: ['web-dev'],
			},
		);

		expect(ranked[0]?.repoFullName).toBe('acme/react-ui');
	});

	test('scores all candidate batches instead of stopping after the first matching batch', async () => {
		const originalScoreIssues = llmService.scoreIssues;
		const batches: number[][] = [];
		const issues = Array.from({ length: 25 }, (_, index) =>
			createIssue({
				id: index + 1,
				number: index + 1,
				repoFullName: `acme/repo-${index + 1}`,
				repoName: `repo-${index + 1}`,
				title: `React issue ${index + 1}`,
			}),
		);

		try {
			llmService.scoreIssues = async (_profile, batch) => {
				batches.push(batch.map((issue) => issue.number));
				return {
					version: '1',
					kind: 'issue_match_list',
					status: 'success',
					data: batch.map((issue) =>
						createMatchedIssue({
							...issue,
							matchScore: 72,
						}),
					),
				};
			};

			const matches = await issueRankingService.scoreIssuesInBatches(
				{
					techStack: ['React'],
					proficiency: 'intermediate',
					focusAreas: ['web-dev'],
				},
				issues,
			);

			expect(batches).toHaveLength(2);
			expect(matches).toHaveLength(25);
		} finally {
			llmService.scoreIssues = originalScoreIssues;
		}
	});

	test('builds local heuristic issue matches without LLM scoring', () => {
		const matches = issueRankingService.buildLocalIssueMatches(
			[
				createIssue({
					repoFullName: 'acme/react-ui',
					repoName: 'react-ui',
					number: 12,
					title: 'Fix React focus trap in menu',
					body: 'The bug is in `src/Menu.tsx`. Steps to reproduce: tab through the menu. Expected focus stays inside.',
					labels: ['good first issue', 'accessibility'],
					repoDescription: 'TypeScript React component library',
					repoStars: 420,
				}),
			],
			{
				techStack: ['TypeScript', 'React'],
				proficiency: 'intermediate',
				focusAreas: ['web-dev'],
			},
		);

		expect(matches).toHaveLength(1);
		expect(matches[0]?.matchScore).toBeGreaterThan(60);
		expect(matches[0]?.analysis.techRequirements).toContain('TypeScript');
		expect(matches[0]?.analysis.techRequirements).toContain('React');
		expect(matches[0]?.analysis.estimatedWorkload).toBe('1-3 hours');
		expect(matches[0]?.analysis.solutionSuggestion).toContain('Local scout mode');
	});

	test('builds a ranked target issue without batch discovery', async () => {
		const originalFetchIssue = githubService.fetchIssue;
		const originalScoreIssues = llmService.scoreIssues;
		const observedFetches: unknown[] = [];

		try {
			githubService.fetchIssue = async (repoFullName, issueNumber) => {
				observedFetches.push({ repoFullName, issueNumber });
				return createIssue({
					repoFullName: 'Wei-Shaw/sub2api',
					repoName: 'sub2api',
					number: 3014,
					title: 'bug(openai): codex_cli_only 未拦截 /v1/chat/completions 兼容入口',
					body: 'The issue points to src/openai.ts and includes steps to reproduce.',
					labels: [],
				});
			};
			llmService.scoreIssues = async (_profile, issues) => ({
				version: '1',
				kind: 'issue_match_list',
				status: 'success',
				data: issues.map((issue) =>
					createMatchedIssue({
						...issue,
						matchScore: 77,
						analysis: {
							coreDemand: issue.title,
							techRequirements: ['TypeScript', 'OpenAI API'],
							solutionSuggestion: 'Inspect the compatibility route and add a guard.',
							estimatedWorkload: '1-2 hours',
						},
					}),
				),
			});

			const [ranked] = await issueRankingService.loadTargetIssue(
				{
					userProfile: {
						techStack: ['TypeScript'],
						proficiency: 'intermediate',
						focusAreas: ['backend'],
					},
					github: {
						pat: 'ghp-test',
						username: 'octocat',
						targetRepoPath: '',
					},
					llm: {
						provider: 'openai',
						apiBaseUrl: 'https://api.openai.com/v1',
						apiKey: 'sk-test',
						modelName: 'gpt-5.5',
						reasoningEffort: 'none',
					},
					automation: {
						enabled: false,
						scheduleTime: '09:00',
						timezone: 'UTC',
						contentType: 'research_note',
						scheduler: 'manual',
						minMatchScore: 70,
						skipIfAlreadyGeneratedToday: true,
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
					commitTemplate: '{{content}}',
				},
				{
					repoFullName: 'Wei-Shaw/sub2api',
					issueNumber: 3014,
				},
			);

			expect(observedFetches).toEqual([
				{
					repoFullName: 'Wei-Shaw/sub2api',
					issueNumber: 3014,
				},
			]);
			expect(ranked?.repoFullName).toBe('Wei-Shaw/sub2api');
			expect(ranked?.number).toBe(3014);
			expect(ranked?.matchScore).toBe(77);
			expect(ranked?.opportunity.overallScore).toBeGreaterThan(0);
		} finally {
			githubService.fetchIssue = originalFetchIssue;
			llmService.scoreIssues = originalScoreIssues;
		}
	});

	test('passes repository scope to GitHub issue discovery', async () => {
		const originalFetchTrendingIssues = githubService.fetchTrendingIssues;
		const observedOptions: unknown[] = [];

		try {
			githubService.fetchTrendingIssues = async (options) => {
				observedOptions.push(options);
				return [];
			};

			await issueRankingService.loadRankedIssues(
				{
					userProfile: {
						techStack: ['TypeScript'],
						proficiency: 'intermediate',
						focusAreas: ['web-dev'],
					},
					github: {
						pat: 'ghp-test',
						username: 'octocat',
						targetRepoPath: '',
					},
					llm: {
						provider: 'openai',
						apiBaseUrl: 'https://api.openai.com/v1',
						apiKey: 'sk-test',
						modelName: 'gpt-5.5',
						reasoningEffort: 'none',
					},
					automation: {
						enabled: false,
						scheduleTime: '09:00',
						timezone: 'UTC',
						contentType: 'research_note',
						scheduler: 'manual',
						minMatchScore: 70,
						skipIfAlreadyGeneratedToday: true,
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
					commitTemplate: '{{content}}',
				},
				{
					repoFullName: 'vercel/next.js',
					localOnly: true,
				},
			);

			expect(observedOptions[0]).toMatchObject({
				repoFullName: 'vercel/next.js',
			});
		} finally {
			githubService.fetchTrendingIssues = originalFetchTrendingIssues;
		}
	});
});

import { describe, expect, test } from 'bun:test';
import { githubService, issueRankingService, llmService } from '../src/services/index.js';
import type { EnvironmentInfo } from '../src/types/index.js';
import { createIssue, createMatchedIssue, createRankedIssue } from './helpers/factories.js';

const testEnvironment: EnvironmentInfo = {
  os: {
    platform: 'linux',
    arch: 'x64',
    distro: 'Linux',
    version: 'test',
    isWSL: false,
    wslDistros: [],
    hypervisor: {
      isVM: false,
      type: 'none',
      isContainer: false,
      isCI: true,
    },
  },
  cpu: { model: 'Test CPU', cores: 4, threads: 8 },
  gpu: [],
  totalRAMGB: 16,
  disks: [{ mountPoint: '/', totalGB: 256, freeGB: 128 }],
  tools: [
    { name: 'git', available: true, version: 'git version 2.45.0' },
    { name: 'node', available: true, version: 'v22.0.0' },
    { name: 'docker', available: false },
    { name: 'nvidia-smi', available: false },
  ],
};

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
    expect(matches[0]?.analysis.solutionSuggestion).toContain('OpenMeta can shortlist this issue heuristically');
  });

  test('builds a ranked target issue without batch discovery', async () => {
    const originalFetchIssue = githubService.fetchIssue;
    const originalFetchIssueClaimContext = githubService.fetchIssueClaimContext;
    const originalFetchRepositoryProbe = githubService.fetchRepositoryProbe;
    const originalScoreIssues = llmService.scoreIssues;
    const rankingServiceState = issueRankingService as unknown as {
      cachedEnvironment: EnvironmentInfo | null;
      detectionPromise: Promise<EnvironmentInfo> | null;
    };
    const originalCachedEnvironment = rankingServiceState.cachedEnvironment;
    const originalDetectionPromise = rankingServiceState.detectionPromise;
    const observedFetches: unknown[] = [];
    const observedClaimChecks: unknown[] = [];

    try {
      rankingServiceState.cachedEnvironment = testEnvironment;
      rankingServiceState.detectionPromise = null;
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
      githubService.fetchIssueClaimContext = async (repoFullName, issueNumber) => {
        observedClaimChecks.push({ repoFullName, issueNumber });
        return {
          recentComments: [
            {
              author: 'alice',
              authorAssociation: 'CONTRIBUTOR',
              body: "I'd like to work on this.",
              createdAt: new Date().toISOString(),
              htmlUrl: 'https://github.com/Wei-Shaw/sub2api/issues/3014#issuecomment-1',
            },
          ],
          claimAssessment: {
            status: 'likely',
            evidence: ["alice: I'd like to work on this."],
            checkedAt: new Date().toISOString(),
          },
        };
      };
      githubService.fetchRepositoryProbe = async (repoFullName) => ({
        repoFullName,
        files: {
          packageJson: '{"dependencies":{"typescript":"latest"}}',
          pyprojectToml: undefined,
          requirementsTxt: undefined,
          cargoToml: undefined,
          goMod: undefined,
          dockerCompose: undefined,
          dockerfile: undefined,
          readme: '# sub2api\n\nTypeScript API project.',
          workflows: [],
        },
        missingPaths: [],
      });
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
          repositoryTargeting: {
            activePreset: '',
            presets: {},
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
            weights: { freshness: 0.25, onboardingClarity: 0.25, mergePotential: 0.3, impact: 0.2, riskPenalty: 0.35 },
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
      expect(observedClaimChecks).toEqual([
        {
          repoFullName: 'Wei-Shaw/sub2api',
          issueNumber: 3014,
        },
      ]);
      expect(ranked?.repoFullName).toBe('Wei-Shaw/sub2api');
      expect(ranked?.number).toBe(3014);
      expect(ranked?.matchScore).toBe(77);
      expect(ranked?.claimAssessment?.status).toBe('likely');
      expect(ranked?.opportunity.overallScore).toBeGreaterThan(0);
    } finally {
      rankingServiceState.cachedEnvironment = originalCachedEnvironment;
      rankingServiceState.detectionPromise = originalDetectionPromise;
      githubService.fetchIssue = originalFetchIssue;
      githubService.fetchIssueClaimContext = originalFetchIssueClaimContext;
      githubService.fetchRepositoryProbe = originalFetchRepositoryProbe;
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
          repositoryTargeting: {
            activePreset: '',
            presets: {},
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
            weights: { freshness: 0.25, onboardingClarity: 0.25, mergePotential: 0.3, impact: 0.2, riskPenalty: 0.35 },
            overallWeights: { technicalMatch: 0.45, opportunityScore: 0.55 },
            preset: 'balanced',
          },
          commitTemplate: '{{content}}',
        },
        {
          repoFullName: 'vercel/next.js',
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

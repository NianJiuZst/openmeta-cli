import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as infra from '../src/infra/index.js';
import { AgentOrchestrator } from '../src/orchestration/agent.js';
import { issueRankingService } from '../src/services/index.js';
import type { AppConfig } from '../src/types/index.js';
import { createRankedIssue } from './helpers/factories.js';

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    userProfile: {
      techStack: ['typescript', 'react'],
      proficiency: 'intermediate',
      focusAreas: ['frontend'],
    },
    github: {
      pat: 'ghp_test_token',
      username: 'octocat',
    },
    repositoryTargeting: {
      activePreset: '',
      presets: {},
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
    commitTemplate: 'feat: {{title}}',
  };

  return {
    ...base,
    ...overrides,
    github: {
      ...base.github,
      ...overrides.github,
    },
    repositoryTargeting: {
      ...base.repositoryTargeting,
      ...overrides.repositoryTargeting,
      presets: {
        ...base.repositoryTargeting.presets,
        ...overrides.repositoryTargeting?.presets,
      },
    },
    llm: {
      ...base.llm,
      ...overrides.llm,
    },
    automation: {
      ...base.automation,
      ...overrides.automation,
    },
  };
}

beforeEach(() => {
  spyOn(infra.ui, 'hero').mockImplementation(() => {});
  spyOn(infra.ui, 'stats').mockImplementation(() => {});
  spyOn(infra.ui, 'recordList').mockImplementation(() => {});
  spyOn(infra.ui, 'emptyState').mockImplementation(() => {});
  spyOn(infra.ui, 'task').mockImplementation(async (_options, task) =>
    task({
      setMessage() {},
    } as never),
  );
});

afterEach(() => {
  mock.restore();
});

describe('AgentOrchestrator scout targeting', () => {
  test('auto-applies the active preset during scout discovery', async () => {
    const orchestrator = new AgentOrchestrator();
    const config = createConfig({
      repositoryTargeting: {
        activePreset: 'frontend',
        presets: {
          frontend: {
            repos: ['vercel/next.js', 'facebook/react'],
          },
        },
      },
    });
    const loadRankedIssuesSpy = spyOn(issueRankingService, 'loadRankedIssues')
      .mockResolvedValueOnce([createRankedIssue({ repoFullName: 'vercel/next.js', number: 1 })])
      .mockResolvedValueOnce([createRankedIssue({ repoFullName: 'facebook/react', number: 2 })]);

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as unknown as {
        validateConfig(config: AppConfig, options?: { requireLlm?: boolean }): Promise<void>;
      },
      'validateConfig',
    ).mockResolvedValue(undefined);
    spyOn(
      orchestrator as unknown as {
        initializeClients(config: AppConfig, options?: { validateLlm?: boolean }): Promise<void>;
      },
      'initializeClients',
    ).mockResolvedValue(undefined);

    await orchestrator.scout({ limit: 5 });

    expect(loadRankedIssuesSpy).toHaveBeenNthCalledWith(
      1,
      config,
      expect.objectContaining({
        repoFullName: 'vercel/next.js',
      }),
    );
    expect(loadRankedIssuesSpy).toHaveBeenNthCalledWith(
      2,
      config,
      expect.objectContaining({
        repoFullName: 'facebook/react',
      }),
    );
  });

  test('bypasses the active preset when scout runs with --all-repos', async () => {
    const orchestrator = new AgentOrchestrator();
    const config = createConfig({
      repositoryTargeting: {
        activePreset: 'frontend',
        presets: {
          frontend: {
            repos: ['vercel/next.js', 'facebook/react'],
          },
        },
      },
    });
    const loadRankedIssuesSpy = spyOn(issueRankingService, 'loadRankedIssues').mockResolvedValue([createRankedIssue()]);

    spyOn(infra.configService, 'get').mockResolvedValue(config);
    spyOn(
      orchestrator as unknown as {
        validateConfig(config: AppConfig, options?: { requireLlm?: boolean }): Promise<void>;
      },
      'validateConfig',
    ).mockResolvedValue(undefined);
    spyOn(
      orchestrator as unknown as {
        initializeClients(config: AppConfig, options?: { validateLlm?: boolean }): Promise<void>;
      },
      'initializeClients',
    ).mockResolvedValue(undefined);

    await orchestrator.scout({ allRepos: true, limit: 5 });

    expect(loadRankedIssuesSpy).toHaveBeenCalledTimes(1);
    expect(loadRankedIssuesSpy).toHaveBeenCalledWith(
      config,
      expect.not.objectContaining({
        repoFullName: 'vercel/next.js',
      }),
    );
  });
});

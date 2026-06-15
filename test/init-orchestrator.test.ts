import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as infra from '../src/infra/index.js';
import { InitOrchestrator } from '../src/orchestration/init.js';
import type { LLMReasoningEffort } from '../src/types/index.js';

interface InitOrchestratorInternals {
  promptReasoningEffort(defaultValue?: LLMReasoningEffort): Promise<LLMReasoningEffort>;
  promptLlmStreaming(defaultValue?: boolean): Promise<boolean>;
}

describe('InitOrchestrator LLM reasoning setup', () => {
  afterEach(() => {
    mock.restore();
  });

  test('defaults reasoning effort selection to none during init', async () => {
    const orchestrator = new InitOrchestrator() as unknown as InitOrchestratorInternals;
    const selectSpy = spyOn(infra, 'selectPrompt').mockResolvedValue('none');

    try {
      const selected = await orchestrator.promptReasoningEffort();

      expect(selected).toBe('none');
      expect(selectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Select reasoning effort:',
          default: 'none',
          choices: expect.arrayContaining([
            expect.objectContaining({ name: 'none', value: 'none' }),
            expect.objectContaining({ name: 'high', value: 'high' }),
          ]),
        }),
      );
    } finally {
      selectSpy.mockRestore();
    }
  });

  test('defaults streaming selection to false during init', async () => {
    const orchestrator = new InitOrchestrator() as unknown as InitOrchestratorInternals;
    const promptSpy = spyOn(infra, 'prompt').mockResolvedValue({ stream: false });

    try {
      const selected = await orchestrator.promptLlmStreaming();

      expect(selected).toBe(false);
      expect(promptSpy).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'confirm',
          name: 'stream',
          message: 'Use streaming LLM responses?',
          default: false,
        }),
      ]);
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('prompts for a first repository preset during init before artifact repository setup', async () => {
    const orchestrator = new InitOrchestrator();
    spyOn(infra.configService, 'get').mockResolvedValue({
      userProfile: {
        techStack: [],
        proficiency: 'beginner',
        focusAreas: [],
      },
      github: {
        pat: 'ghp_test',
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
        modelName: 'gpt-4o-mini',
        apiHeaders: {},
        reasoningEffort: 'none',
        stream: false,
        activeProfile: '',
        profiles: {},
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
      commitTemplate: 'feat: {{title}}',
    });
    const saveSpy = spyOn(infra.configService, 'save').mockResolvedValue(undefined);
    spyOn(infra.ui, 'hero').mockImplementation(() => {});
    spyOn(infra.ui, 'section').mockImplementation(() => {});
    spyOn(infra.ui, 'keyValues').mockImplementation(() => {});
    spyOn(infra.ui, 'stats').mockImplementation(() => {});
    spyOn(infra.ui, 'callout').mockImplementation(() => {});
    spyOn(infra.ui, 'task').mockImplementation(async (_options, task) => task({ setMessage() {} } as never));
    spyOn(infra, 'selectPrompt').mockResolvedValueOnce('beginner').mockResolvedValueOnce('research_note');
    const promptSpy = spyOn(infra, 'prompt')
      .mockResolvedValueOnce({ techStack: ['TypeScript'] })
      .mockResolvedValueOnce({ focusAreas: ['open-source'] })
      .mockResolvedValueOnce({ createPreset: true })
      .mockResolvedValueOnce({ presetName: 'default' })
      .mockResolvedValueOnce({ presetRepos: 'vercel/next.js, facebook/react' })
      .mockResolvedValueOnce({ activatePreset: true })
      .mockResolvedValueOnce({ artifactRepoPath: '' })
      .mockResolvedValueOnce({ automationEnabled: false });
    await orchestrator.execute();

    expect(promptSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'createPreset',
          message: 'Create a reusable repository preset now?',
        }),
      ]),
    );
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryTargeting: {
          activePreset: 'default',
          presets: {
            default: {
              repos: ['vercel/next.js', 'facebook/react'],
            },
          },
        },
      }),
    );
  });
});

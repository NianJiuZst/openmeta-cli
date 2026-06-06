import { describe, expect, spyOn, test } from 'bun:test';
import * as infra from '../src/infra/index.js';
import { InitOrchestrator } from '../src/orchestration/init.js';
import type { LLMReasoningEffort } from '../src/types/index.js';

interface InitOrchestratorInternals {
  promptReasoningEffort(defaultValue?: LLMReasoningEffort): Promise<LLMReasoningEffort>;
  promptLlmStreaming(defaultValue?: boolean): Promise<boolean>;
  promptLlmInteractionOutput(defaultValue?: boolean): Promise<boolean>;
}

describe('InitOrchestrator LLM reasoning setup', () => {
  test('defaults reasoning effort selection to none during init', async () => {
    const orchestrator = new InitOrchestrator() as unknown as InitOrchestratorInternals;
    const selectSpy = spyOn(infra, 'selectPrompt').mockResolvedValue('none');

    try {
      const selected = await orchestrator.promptReasoningEffort();

      expect(selected).toBe('none');
      expect(selectSpy).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Select reasoning effort:',
        default: 'none',
        choices: expect.arrayContaining([
          expect.objectContaining({ name: 'none', value: 'none' }),
          expect.objectContaining({ name: 'high', value: 'high' }),
        ]),
      }));
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

  test('defaults interaction output selection to false during init', async () => {
    const orchestrator = new InitOrchestrator() as unknown as InitOrchestratorInternals;
    const promptSpy = spyOn(infra, 'prompt').mockResolvedValue({ showInteraction: false });

    try {
      const selected = await orchestrator.promptLlmInteractionOutput();

      expect(selected).toBe(false);
      expect(promptSpy).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'confirm',
          name: 'showInteraction',
          message: 'Show detailed LLM interaction output?',
          default: false,
        }),
      ]);
    } finally {
      promptSpy.mockRestore();
    }
  });
});

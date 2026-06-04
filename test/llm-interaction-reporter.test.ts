import { describe, expect, test } from 'bun:test';
import { BufferedLLMInteractionReporter, createLLMInteractionReporter } from '../src/infra/llm-interaction-reporter.js';

describe('BufferedLLMInteractionReporter', () => {
  test('buffers chunks and flushes readable output', () => {
    const lines: string[] = [];
    const reporter = new BufferedLLMInteractionReporter({
      write: (line) => lines.push(line),
      chunkFlushChars: 10,
    });

    reporter.onRequestStart({
      stage: 'patch_draft',
      model: 'gpt-5.5',
      provider: 'custom',
      streaming: true,
      promptChars: 1200,
      context: 'acme/demo#42',
    });
    reporter.onResponseChunk('hello');
    reporter.onResponseChunk(' world');
    reporter.onResponseComplete({
      stage: 'patch_draft',
      model: 'gpt-5.5',
      provider: 'custom',
      streaming: true,
      promptChars: 1200,
      context: 'acme/demo#42',
      responseChars: 11,
    });

    const output = lines.join('\n');
    expect(output).toContain('LLM Interaction: patch_draft');
    expect(output).toContain('Model: gpt-5.5');
    expect(output).toContain('Streaming: yes');
    expect(output).toContain('Prompt: 1,200 chars');
    expect(output).toContain('Context: acme/demo#42');
    expect(output).toContain('hello world');
  });

  test('factory returns a no-op reporter when disabled', () => {
    const lines: string[] = [];
    const reporter = createLLMInteractionReporter(false, { write: (line) => lines.push(line) });

    reporter.onRequestStart({
      stage: 'daily_report',
      model: 'gpt-5.5',
      provider: 'openai',
      streaming: false,
      promptChars: 10,
    });

    expect(lines).toEqual([]);
  });
});

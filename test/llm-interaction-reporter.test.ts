import { describe, expect, test } from 'bun:test';
import { BufferedLLMInteractionReporter, createLLMInteractionReporter } from '../src/infra/llm-interaction-reporter.js';

describe('BufferedLLMInteractionReporter', () => {
  test('summary mode suppresses raw chunks and renders parsed repository suggestions', () => {
    const lines: string[] = [];
    const reporter = new BufferedLLMInteractionReporter({
      write: (line) => lines.push(line),
      chunkFlushChars: 10,
      mode: 'summary',
    });

    reporter.onRequestStart({
      stage: 'repository_analysis',
      model: 'gpt-5.5',
      provider: 'custom',
      streaming: true,
      promptChars: 1200,
      context: 'acme/demo',
    });
    reporter.onResponseChunk('{"version":"1","kind":"repository_suggestion_list"');
    reporter.onResponseComplete({
      stage: 'repository_analysis',
      model: 'gpt-5.5',
      provider: 'custom',
      streaming: true,
      promptChars: 1200,
      context: 'acme/demo',
      responseChars: 5000,
    });
    reporter.onParseComplete({
      stage: 'repository_analysis',
      model: 'gpt-5.5',
      provider: 'custom',
      streaming: true,
      promptChars: 1200,
      context: 'acme/demo',
      kind: 'repository_suggestion_list',
      status: 'success',
      parsed: {
        version: '1',
        kind: 'repository_suggestion_list',
        status: 'success',
        data: [
          {
            id: 'docs-install',
            title: 'Document local install',
            summary: 'Clarify setup docs.',
            targetFiles: [{ path: 'README.md', reason: 'Setup docs' }],
            prPotentialScore: 82,
          },
        ],
      },
    });

    const output = lines.join('\n');
    expect(output).toContain('LLM Interaction: repository_analysis');
    expect(output).toContain('Model: gpt-5.5');
    expect(output).toContain('Streaming: yes');
    expect(output).toContain('Prompt: 1,200 chars');
    expect(output).toContain('Context: acme/demo');
    expect(output).toContain('Assistant response received: 5,000 chars');
    expect(output).toContain('Repository suggestions: 1');
    expect(output).toContain('Document local install');
    expect(output).toContain('score 82');
    expect(output).toContain('README.md');
    expect(output).not.toContain('{"version"');
  });

  test('raw mode buffers chunks and flushes original assistant output', () => {
    const lines: string[] = [];
    const reporter = new BufferedLLMInteractionReporter({
      write: (line) => lines.push(line),
      chunkFlushChars: 10,
      mode: 'raw',
    });

    reporter.onRequestStart({
      stage: 'patch_draft',
      model: 'gpt-5.5',
      provider: 'custom',
      streaming: true,
      promptChars: 1200,
      context: 'acme/demo#42',
    });
    reporter.onResponseChunk('{"hello":');
    reporter.onResponseChunk('"world"}');
    reporter.onResponseComplete({
      stage: 'patch_draft',
      model: 'gpt-5.5',
      provider: 'custom',
      streaming: true,
      promptChars: 1200,
      context: 'acme/demo#42',
      responseChars: 17,
    });

    const output = lines.join('\n');
    expect(output).toContain('Assistant:');
    expect(output).toContain('{"hello":"world"}');
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

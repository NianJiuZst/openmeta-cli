import type { LLMProvider } from '../types/index.js';

export type LLMInteractionStage =
  | 'validate'
  | 'issue_scoring'
  | 'repository_analysis'
  | 'patch_draft'
  | 'implementation_draft'
  | 'validation_repair'
  | 'pull_request_draft'
  | 'daily_report'
  | 'daily_diary';

export interface LLMInteractionEvent {
  stage: LLMInteractionStage;
  model: string;
  provider: LLMProvider;
  streaming: boolean;
  promptChars: number;
  context?: string;
}

export interface LLMInteractionReporter {
  onRequestStart(event: LLMInteractionEvent): void;
  onResponseChunk(chunk: string): void;
  onResponseComplete(event: LLMInteractionEvent & { responseChars: number }): void;
  onParseComplete(event: LLMInteractionEvent & { kind: string; status: string }): void;
  onRepairStart(event: LLMInteractionEvent & { error: string }): void;
}

export interface BufferedLLMInteractionReporterOptions {
  write?: (line: string) => void;
  chunkFlushChars?: number;
}

export class NoopLLMInteractionReporter implements LLMInteractionReporter {
  onRequestStart(): void {}
  onResponseChunk(): void {}
  onResponseComplete(): void {}
  onParseComplete(): void {}
  onRepairStart(): void {}
}

export class BufferedLLMInteractionReporter implements LLMInteractionReporter {
  private readonly write: (line: string) => void;
  private readonly chunkFlushChars: number;
  private chunkBuffer = '';
  private wroteAssistantHeader = false;

  constructor(options: BufferedLLMInteractionReporterOptions = {}) {
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.chunkFlushChars = options.chunkFlushChars ?? 500;
  }

  onRequestStart(event: LLMInteractionEvent): void {
    this.chunkBuffer = '';
    this.wroteAssistantHeader = false;
    this.write('');
    this.write(`LLM Interaction: ${event.stage}`);
    this.write(`Model: ${event.model}`);
    this.write(`Provider: ${event.provider}`);
    this.write(`Streaming: ${event.streaming ? 'yes' : 'no'}`);
    this.write(`Prompt: ${event.promptChars.toLocaleString()} chars`);
    if (event.context) {
      this.write(`Context: ${event.context}`);
    }
  }

  onResponseChunk(chunk: string): void {
    if (!chunk) {
      return;
    }

    this.chunkBuffer += chunk;
    if (this.chunkBuffer.length >= this.chunkFlushChars) {
      this.flushChunks();
    }
  }

  onResponseComplete(event: LLMInteractionEvent & { responseChars: number }): void {
    this.flushChunks();
    if (!event.streaming) {
      this.write(`Assistant response received: ${event.responseChars.toLocaleString()} chars`);
      return;
    }
    this.write(`Assistant response complete: ${event.responseChars.toLocaleString()} chars`);
  }

  onParseComplete(event: LLMInteractionEvent & { kind: string; status: string }): void {
    this.write(`Parsed: ${event.kind} / ${event.status}`);
  }

  onRepairStart(event: LLMInteractionEvent & { error: string }): void {
    this.write(`Structured output parse failed; requesting repair. ${event.error}`);
  }

  private flushChunks(): void {
    if (!this.chunkBuffer) {
      return;
    }

    if (!this.wroteAssistantHeader) {
      this.write('Assistant:');
      this.wroteAssistantHeader = true;
    }

    this.write(this.chunkBuffer);
    this.chunkBuffer = '';
  }
}

export function createLLMInteractionReporter(
  enabled: boolean,
  options?: BufferedLLMInteractionReporterOptions,
): LLMInteractionReporter {
  if (!enabled) {
    return new NoopLLMInteractionReporter();
  }

  return new BufferedLLMInteractionReporter(options);
}

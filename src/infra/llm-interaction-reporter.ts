import type { LLMInteractionMode, LLMProvider } from '../types/index.js';

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
  onParseComplete(event: LLMInteractionEvent & { kind: string; status: string; parsed?: unknown }): void;
  onRepairStart(event: LLMInteractionEvent & { error: string }): void;
}

export interface BufferedLLMInteractionReporterOptions {
  write?: (line: string) => void;
  chunkFlushChars?: number;
  mode?: LLMInteractionMode;
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
  private readonly mode: LLMInteractionMode;
  private chunkBuffer = '';
  private wroteAssistantHeader = false;

  constructor(options: BufferedLLMInteractionReporterOptions = {}) {
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.chunkFlushChars = options.chunkFlushChars ?? 500;
    this.mode = options.mode ?? 'summary';
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
    if (this.mode !== 'raw') {
      return;
    }

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
    this.write(`Assistant response received: ${event.responseChars.toLocaleString()} chars`);
  }

  onParseComplete(event: LLMInteractionEvent & { kind: string; status: string; parsed?: unknown }): void {
    this.write(`Parsed: ${event.kind} / ${event.status}`);
    if (this.mode !== 'summary') {
      return;
    }

    for (const line of this.describeParsedOutput(event.kind, event.parsed)) {
      this.write(line);
    }
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

  private describeParsedOutput(kind: string, parsed: unknown): string[] {
    const data = this.getEnvelopeData(parsed);

    if (kind === 'repository_suggestion_list' && Array.isArray(data)) {
      return [
        `Repository suggestions: ${data.length}`,
        ...data.slice(0, 5).map((item) => {
          const record = this.asRecord(item);
          const title = this.asString(record?.['title'], 'Untitled suggestion');
          const score = this.asNumber(record?.['prPotentialScore']);
          const files = this.formatTargetFiles(record?.['targetFiles']);
          return `- ${title}${score === undefined ? '' : ` | score ${score}`}${files ? ` | files ${files}` : ''}`;
        }),
      ];
    }

    if (kind === 'patch_draft' && data) {
      const record = this.asRecord(data);
      return [
        `Patch goal: ${this.asString(record?.['goal'], 'Not provided')}`,
        `Target files: ${this.formatTargetFiles(record?.['targetFiles']) || 'none'}`,
        `Changes: ${this.countArray(record?.['proposedChanges'])}`,
        `Risks: ${this.countArray(record?.['risks'])}`,
      ];
    }

    if (kind === 'implementation_draft' && data) {
      const record = this.asRecord(data);
      return [
        `Implementation summary: ${this.asString(record?.['summary'], 'Not provided')}`,
        `File changes: ${this.formatFileChanges(record?.['fileChanges']) || 'none'}`,
      ];
    }

    if (kind === 'pull_request_draft' && data) {
      const record = this.asRecord(data);
      return [
        `PR title: ${this.asString(record?.['title'], 'Not provided')}`,
        `Changes: ${this.countArray(record?.['changes'])}`,
        `Validation notes: ${this.countArray(record?.['validation'])}`,
        `Risks: ${this.countArray(record?.['risks'])}`,
      ];
    }

    if (kind === 'issue_match_list' && Array.isArray(data)) {
      return [
        `Matched issues: ${data.length}`,
        ...data.slice(0, 5).map((item) => {
          const record = this.asRecord(item);
          const reference = `${this.asString(record?.['repoFullName'], 'unknown')}#${this.asString(record?.['number'], '?')}`;
          const title = this.asString(record?.['title'], 'Untitled issue');
          const score = this.asNumber(record?.['matchScore']);
          return `- ${reference} | ${title}${score === undefined ? '' : ` | score ${score}`}`;
        }),
      ];
    }

    return [];
  }

  private getEnvelopeData(value: unknown): unknown {
    const record = this.asRecord(value);
    return record?.['data'];
  }

  private formatTargetFiles(value: unknown): string {
    if (!Array.isArray(value)) {
      return '';
    }
    return value
      .slice(0, 5)
      .map((item) => this.asString(this.asRecord(item)?.['path'], ''))
      .filter(Boolean)
      .join(', ');
  }

  private formatFileChanges(value: unknown): string {
    if (!Array.isArray(value)) {
      return '';
    }
    return value
      .slice(0, 5)
      .map((item) => this.asString(this.asRecord(item)?.['path'], ''))
      .filter(Boolean)
      .join(', ');
  }

  private countArray(value: unknown): string {
    return Array.isArray(value) ? String(value.length) : '0';
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
  }

  private asString(value: unknown, fallback: string): string {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return String(value);
    }
    return fallback;
  }

  private asNumber(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
  }
}

export function createLLMInteractionReporter(
  enabled: boolean,
  modeOrOptions?: LLMInteractionMode | BufferedLLMInteractionReporterOptions,
  options?: BufferedLLMInteractionReporterOptions,
): LLMInteractionReporter {
  if (!enabled) {
    return new NoopLLMInteractionReporter();
  }

  if (typeof modeOrOptions === 'string') {
    return new BufferedLLMInteractionReporter({ ...options, mode: modeOrOptions });
  }

  return new BufferedLLMInteractionReporter(modeOrOptions);
}

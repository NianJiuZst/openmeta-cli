import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ensureDirectory, getOpenMetaStateDir } from '../infra/index.js';
import type { AgentEventLogEntry, AgentEventType } from '../types/index.js';

function createEventId(timestamp: string): string {
  const stamp = timestamp.replace(/[-:T.Z]/g, '').slice(0, 17);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `evt_${stamp}_${suffix}`;
}

function parseEventLogEntries(content: string): AgentEventLogEntry[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries: AgentEventLogEntry[] = [];

  for (const [index, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line) as AgentEventLogEntry);
    } catch (error) {
      if (index === lines.length - 1) {
        break;
      }
      throw error;
    }
  }

  return entries;
}

export class AgentEventLogService {
  private getRootPath(): string {
    return ensureDirectory(join(getOpenMetaStateDir(), 'run-events'));
  }

  getPath(runId: string): string {
    return join(this.getRootPath(), `${runId}.jsonl`);
  }

  record(runId: string, type: AgentEventType, data: Record<string, unknown> = {}): AgentEventLogEntry {
    const timestamp = new Date().toISOString();
    const entry: AgentEventLogEntry = {
      version: 1,
      id: createEventId(timestamp),
      runId,
      type,
      timestamp,
      data,
    };

    mkdirSync(this.getRootPath(), { recursive: true });
    appendFileSync(this.getPath(runId), `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 });
    return entry;
  }

  load(runId: string): AgentEventLogEntry[] {
    const path = this.getPath(runId);
    if (!existsSync(path)) {
      return [];
    }

    return parseEventLogEntries(readFileSync(path, 'utf-8'));
  }
}

export const agentEventLogService = new AgentEventLogService();

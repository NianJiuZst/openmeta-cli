import { describe, expect, test } from 'bun:test';
import { LLMService } from '../src/services/llm.js';
import type { StructuredOutputStatus } from '../src/contracts/index.js';
import type { ImplementationDraft, MatchedIssue } from '../src/types/index.js';
import { createIssue } from './helpers/factories.js';

interface LLMServiceInternals {
  parseImplementationDraft(content: string): {
    status: StructuredOutputStatus;
    data: ImplementationDraft;
  };
  parsePatchDraft(content: string): {
    status: StructuredOutputStatus;
    data: {
      goal: string;
      targetFiles: Array<{ path: string; reason: string }>;
      proposedChanges: Array<{ title: string; details: string; files: string[] }>;
      risks: string[];
      validationNotes: string[];
    };
  };
  parsePullRequestDraft(content: string): {
    status: StructuredOutputStatus;
    data: {
      title: string;
      summary: string;
      changes: string[];
      validation: string[];
      risks: string[];
    };
  };
  parseLLMResponse(content: string, originalIssues: ReturnType<typeof createIssue>[]): {
    status: StructuredOutputStatus;
    data: MatchedIssue[];
  };
}

describe('LLMService implementation draft parsing', () => {
  test('parses raw JSON responses into file change drafts', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const draft = service.parseImplementationDraft(`
      {
        "version": "1",
        "kind": "implementation_draft",
        "status": "success",
        "data": {
          "summary": "Update the button label",
          "fileChanges": [
            {
              "path": "src/button.tsx",
              "reason": "Add aria-label",
              "content": "export const Button = () => <button aria-label=\\"Open\\" />;"
            }
          ]
        }
      }
    `);

    expect(draft.status).toBe('success');
    expect(draft.data.summary).toBe('Update the button label');
    expect(draft.data.fileChanges).toHaveLength(1);
    expect(draft.data.fileChanges[0]?.path).toBe('src/button.tsx');
  });

  test('rejects fenced JSON responses that fail schema validation', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    expect(() => service.parseImplementationDraft(`
      \`\`\`json
      {
        "version": "1",
        "kind": "implementation_draft",
        "status": "success",
        "data": {
          "summary": "Mixed output",
          "fileChanges": [
            {
              "path": "src/app.ts",
              "reason": "Valid",
              "content": "console.log('ok');"
            },
            {
              "path": "",
              "reason": "Missing path",
              "content": "ignored"
            }
          ]
        }
      }
      \`\`\`
    `)).toThrow('LLM output failed schema validation.');
  });

  test('parses fenced JSON responses with raw tsx content', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const draft = service.parseImplementationDraft(`
      \`\`\`json
      {
        "version": "1",
        "kind": "implementation_draft",
        "status": "success",
        "data": {
          "summary": "Add aria-label support",
          "fileChanges": [
            {
              "path": "src/components/IconButton.tsx",
              "reason": "Add accessible label handling for icon-only buttons",
              "content": "export function IconButton() {\\n  return <button aria-label=\\"Open menu\\" />;\\n}"
            }
          ]
        }
      }
      \`\`\`
    `);

    expect(draft.status).toBe('success');
    expect(draft.data.summary).toBe('Add aria-label support');
    expect(draft.data.fileChanges).toHaveLength(1);
    expect(draft.data.fileChanges[0]?.path).toBe('src/components/IconButton.tsx');
    expect(draft.data.fileChanges[0]?.content).toContain('aria-label="Open menu"');
  });

  test('deduplicates repeated file changes by path and keeps the latest version', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const draft = service.parseImplementationDraft(`
      {
        "version": "1",
        "kind": "implementation_draft",
        "status": "success",
        "data": {
          "summary": "Repeated output",
          "fileChanges": [
            {
              "path": "src/button.tsx",
              "reason": "First attempt",
              "content": "export const Button = () => null;"
            },
            {
              "path": "src/button.tsx",
              "reason": "Final attempt",
              "content": "export const Button = () => <button />;"
            }
          ]
        }
      }
    `);

    expect(draft.status).toBe('success');
    expect(draft.data.fileChanges).toHaveLength(1);
    expect(draft.data.fileChanges[0]?.reason).toBe('Final attempt');
    expect(draft.data.fileChanges[0]?.content).toContain('<button />');
  });

  test('throws when implementation output is not parseable', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    expect(() => service.parseImplementationDraft('unstructured output')).toThrow(
      'LLM did not return a parseable JSON object.',
    );
  });
});

describe('LLMService issue scoring response parsing', () => {
  test('parses structured matched issues and sorts by score descending', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const issues = [
      createIssue({ repoFullName: 'acme/demo', repoName: 'demo', number: 42 }),
      createIssue({ repoFullName: 'acme/web', repoName: 'web', number: 7, title: 'Improve docs' }),
      createIssue({ repoFullName: 'acme/ignored', repoName: 'ignored', number: 11 }),
    ];

    const parsed = service.parseLLMResponse(`
      {
        "version": "1",
        "kind": "issue_match_list",
        "status": "success",
        "data": {
          "matches": [
            {
              "issueReference": "acme/demo#42",
              "score": 100,
              "coreDemand": "Add accessible labels",
              "techRequirements": ["react", "typescript", "accessibility"],
              "estimatedWorkload": "1-2 hours"
            },
            {
              "issueReference": "acme/web#7",
              "score": 61,
              "coreDemand": "Improve documentation clarity",
              "techRequirements": ["markdown", "docs"],
              "estimatedWorkload": "30 minutes"
            },
            {
              "issueReference": "acme/ignored#11",
              "score": 40,
              "coreDemand": "Ignore this issue",
              "techRequirements": ["none"],
              "estimatedWorkload": "1 hour"
            }
          ]
        }
      }
    `, issues);

    expect(parsed.status).toBe('success');
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0]?.repoFullName).toBe('acme/demo');
    expect(parsed.data[0]?.matchScore).toBe(100);
    expect(parsed.data[0]?.analysis.techRequirements).toEqual(['react', 'typescript', 'accessibility']);
    expect(parsed.data[1]?.repoFullName).toBe('acme/web');
    expect(parsed.data[1]?.analysis.estimatedWorkload).toBe('30 minutes');
  });
});

describe('LLMService pull request draft parsing', () => {
  test('parses structured patch drafts wrapped in envelopes', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const draft = service.parsePatchDraft(`
      {
        "version": "1",
        "kind": "patch_draft",
        "status": "success",
        "data": {
          "goal": "Add accessible labels to icon-only buttons",
          "targetFiles": [
            {
              "path": "src/components/IconButton.tsx",
              "reason": "Primary component logic"
            }
          ],
          "proposedChanges": [
            {
              "title": "Update button API",
              "details": "Require an accessible label for icon-only rendering.",
              "files": ["src/components/IconButton.tsx"]
            }
          ],
          "risks": ["Consumer code may rely on current behavior"],
          "validationNotes": ["Run bun test after the patch"]
        }
      }
    `);

    expect(draft.status).toBe('success');
    expect(draft.data.goal).toBe('Add accessible labels to icon-only buttons');
    expect(draft.data.targetFiles[0]?.path).toBe('src/components/IconButton.tsx');
  });

  test('parses structured pull request drafts', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const draft = service.parsePullRequestDraft(`
      {
        "version": "1",
        "kind": "pull_request_draft",
        "status": "success",
        "data": {
          "title": "Add aria-label handling to icon-only buttons",
          "summary": "Ensure icon-only buttons expose accessible names.",
          "changes": ["Update the shared IconButton component"],
          "validation": ["bun test (pending)"],
          "risks": ["Snapshot updates may be required"]
        }
      }
    `);

    expect(draft.status).toBe('success');
    expect(draft.data.title).toBe('Add aria-label handling to icon-only buttons');
    expect(draft.data.changes).toEqual(['Update the shared IconButton component']);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  ImplementationDraftEnvelopeSchema,
  ImplementationDraftSchema,
  IssueMatchListEnvelopeSchema,
  IssueMatchListSchema,
  PatchDraftEnvelopeSchema,
  PatchDraftSchema,
  PullRequestDraftEnvelopeSchema,
  PullRequestDraftSchema,
} from '../src/contracts/index.js';

describe('agent contracts', () => {
  test('normalizes and deduplicates issue matches', () => {
    const parsed = IssueMatchListSchema.parse({
      matches: [
        {
          issueReference: ' acme/demo#42 ',
          score: '72',
          coreDemand: ' Add aria-label support ',
          techRequirements: ['react', ' react ', 'accessibility'],
          estimatedWorkload: ' 1-2 hours ',
        },
        {
          issueReference: 'acme/demo#42',
          score: 88,
          coreDemand: 'Add aria-label support',
          techRequirements: ['typescript'],
          estimatedWorkload: '1-2 hours',
        },
      ],
    });

    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0]?.score).toBe(88);
    expect(parsed.matches[0]?.techRequirements).toEqual(['typescript']);
  });

  test('deduplicates repeated implementation file changes by path', () => {
    const parsed = ImplementationDraftSchema.parse({
      summary: ' Update button labels ',
      fileChanges: [
        {
          path: ' src/button.tsx ',
          reason: 'First attempt',
          content: 'export const Button = () => null;\n',
        },
        {
          path: 'src/button.tsx',
          reason: 'Final attempt',
          content: 'export const Button = () => <button />;\n',
        },
      ],
    });

    expect(parsed.summary).toBe('Update button labels');
    expect(parsed.fileChanges).toHaveLength(1);
    expect(parsed.fileChanges[0]?.reason).toBe('Final attempt');
  });

  test('requires structured patch drafts with target files and change steps', () => {
    const parsed = PatchDraftSchema.parse({
      goal: 'Add accessible labels to icon-only buttons',
      targetFiles: [
        { path: 'src/components/IconButton.tsx', reason: 'Primary component logic' },
      ],
      proposedChanges: [
        {
          title: 'Update component props',
          details: 'Accept an aria-label when the button is icon-only.',
          files: ['src/components/IconButton.tsx'],
        },
      ],
      risks: ['Need to preserve existing button behavior'],
      validationNotes: ['Run bun test after the patch'],
    });

    expect(parsed.targetFiles[0]?.path).toBe('src/components/IconButton.tsx');
    expect(parsed.proposedChanges[0]?.files).toEqual(['src/components/IconButton.tsx']);
  });

  test('requires structured pull request drafts', () => {
    const parsed = PullRequestDraftSchema.parse({
      title: 'Add aria-label handling to icon buttons',
      summary: 'Ensure icon-only buttons expose accessible names.',
      changes: ['Add aria-label support to the shared button component'],
      validation: ['bun test (pending)'],
      risks: ['Dependent snapshots may need updates'],
    });

    expect(parsed.title).toBe('Add aria-label handling to icon buttons');
    expect(parsed.changes).toHaveLength(1);
  });

  test('wraps issue matches in a shared structured output envelope', () => {
    const parsed = IssueMatchListEnvelopeSchema.parse({
      version: '1',
      kind: 'issue_match_list',
      status: 'success',
      data: {
        matches: [
          {
            issueReference: 'acme/demo#42',
            score: 88,
            coreDemand: 'Add aria-label support',
            techRequirements: ['react'],
            estimatedWorkload: '1-2 hours',
          },
        ],
      },
    });

    expect(parsed.version).toBe('1');
    expect(parsed.kind).toBe('issue_match_list');
    expect(parsed.data.matches[0]?.score).toBe(88);
  });

  test('wraps implementation drafts in a shared structured output envelope', () => {
    const parsed = ImplementationDraftEnvelopeSchema.parse({
      version: '1',
      kind: 'implementation_draft',
      status: 'needs_review',
      data: {
        summary: 'Insufficient context for a safe code patch.',
        fileChanges: [],
      },
    });

    expect(parsed.status).toBe('needs_review');
    expect(parsed.data.fileChanges).toHaveLength(0);
  });

  test('wraps patch drafts in a shared structured output envelope', () => {
    const parsed = PatchDraftEnvelopeSchema.parse({
      version: '1',
      kind: 'patch_draft',
      status: 'success',
      data: {
        goal: 'Add accessible labels to icon-only buttons',
        targetFiles: [
          { path: 'src/components/IconButton.tsx', reason: 'Primary component logic' },
        ],
        proposedChanges: [
          {
            title: 'Update component props',
            details: 'Accept an aria-label when the button is icon-only.',
            files: ['src/components/IconButton.tsx'],
          },
        ],
        risks: [],
        validationNotes: [],
      },
    });

    expect(parsed.kind).toBe('patch_draft');
    expect(parsed.data.targetFiles[0]?.path).toBe('src/components/IconButton.tsx');
  });

  test('wraps pull request drafts in a shared structured output envelope', () => {
    const parsed = PullRequestDraftEnvelopeSchema.parse({
      version: '1',
      kind: 'pull_request_draft',
      status: 'success',
      data: {
        title: 'Add aria-label handling to icon buttons',
        summary: 'Ensure icon-only buttons expose accessible names.',
        changes: ['Add aria-label support to the shared button component'],
        validation: ['bun test (pending)'],
        risks: ['Dependent snapshots may need updates'],
      },
    });

    expect(parsed.kind).toBe('pull_request_draft');
    expect(parsed.data.title).toBe('Add aria-label handling to icon buttons');
  });
});

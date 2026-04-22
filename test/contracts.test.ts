import { describe, expect, test } from 'bun:test';
import {
  ImplementationDraftSchema,
  IssueMatchListSchema,
  PatchDraftSchema,
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
});

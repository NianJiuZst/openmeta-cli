import { describe, expect, test } from 'bun:test';
import { contentService } from '../src/services/content.js';
import {
  createInboxItem,
  createMatchedIssue,
  createMemory,
  createPatchDraft,
  createProofRecord,
  createPullRequestDraft,
  createRankedIssue,
  createRepositorySuggestion,
  createWorkspace,
} from './helpers/factories.js';

describe('contentService', () => {
  test('formats generated research notes as markdown with related issues', () => {
    const issue = createMatchedIssue();
    const content = contentService.generateResearchNote([issue], 'Body content');
    const markdown = contentService.formatAsMarkdown(content);

    expect(markdown).toContain('# Daily Open Source Issue Research Notes');
    expect(markdown).toContain('Body content');
    expect(markdown).toContain('### [acme/demo#42] Add accessible labels to icon buttons');
    expect(markdown).toContain('- Match Score: 86/100');
  });

  test('formats contribution dossier with enriched issue and workspace context', () => {
    const markdown = contentService.formatContributionDossier(
      createRankedIssue(),
      createWorkspace(),
      createMemory(),
      createPatchDraft(),
      createPullRequestDraft(),
    );

    expect(markdown).toContain('## Opportunity Snapshot');
    expect(markdown).toContain('- Repo Stars: 240');
    expect(markdown).toContain('- Issue Link: https://github.com/acme/demo/issues/42');
    expect(markdown).toContain('- Labels: good first issue, help wanted');
    expect(markdown).toContain('## Repository Contribution Rules');
    expect(markdown).toContain('- Detected Rule Files: none');
    expect(markdown).toContain('- `bun test` | Detected Bun tests | repo-script');
    expect(markdown).toContain('## Runnable Validation Commands');
    expect(markdown).toContain('## Validation Safety Notes');
    expect(markdown).toContain('## Patch Draft');
    expect(markdown).toContain('## Goal');
    expect(markdown).toContain('Add accessible labels to icon-only buttons');
    expect(markdown).toContain('Title: Add aria-label handling to icon-only buttons');
  });

  test('renders structured patch drafts as markdown', () => {
    const markdown = contentService.formatPatchDraftMarkdown(createPatchDraft());

    expect(markdown).toContain('# Patch Draft');
    expect(markdown).toContain('## Target Files');
    expect(markdown).toContain('`src/components/IconButton.tsx`');
    expect(markdown).toContain('### Update button API');
    expect(markdown).toContain('## Validation Notes');
  });

  test('renders structured pull request drafts as markdown', () => {
    const markdown = contentService.formatPullRequestDraftMarkdown(createPullRequestDraft());

    expect(markdown).toContain('Title: Add aria-label handling to icon-only buttons');
    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('## Changes');
    expect(markdown).toContain('## Validation');
  });

  test('formats repository analysis suggestions as markdown', () => {
    const selectedSuggestion = createRepositorySuggestion({
      id: 'config-validation',
      title: 'Add config validation tests',
      prPotentialScore: 91,
      targetFiles: [
        { path: 'src/infra/config.ts', reason: 'Config normalization logic' },
        { path: 'test/config.test.ts', reason: 'Regression coverage' },
      ],
    });
    const markdown = contentService.formatRepositoryAnalysisMarkdown(
      'acme/demo',
      createWorkspace({
        workspacePath: '/tmp/openmeta-demo',
        defaultBranch: 'main',
        candidateFiles: ['README.md', 'src/infra/config.ts'],
      }),
      [selectedSuggestion, createRepositorySuggestion()],
      selectedSuggestion,
    );

    expect(markdown).toContain('# Repository Analysis - acme/demo');
    expect(markdown).toContain('- Workspace Path: /tmp/openmeta-demo');
    expect(markdown).toContain('- Candidate Files: README.md, src/infra/config.ts');
    expect(markdown).toContain('## Selected Suggestion');
    expect(markdown).toContain('Add config validation tests');
    expect(markdown).toContain('PR Potential: 91/100');
    expect(markdown).toContain('`src/infra/config.ts` | Config normalization logic');
    expect(markdown).toContain('## Suggestions');
    expect(markdown).toContain('### Document local install');
  });

  test('formats grouped repository analysis markdown for preset-scoped multi-repo suggestions', () => {
    const markdown = contentService.formatRepositoryAnalysisMarkdown(
      'acme/demo',
      createWorkspace({
        workspacePath: '/tmp/openmeta-demo',
        defaultBranch: 'main',
        candidateFiles: ['README.md', 'src/config.ts'],
      }),
      [
        createRepositorySuggestion({
          id: 'demo-high',
          title: 'Add runtime config guard',
          prPotentialScore: 96,
          targetFiles: [{ path: 'src/config.ts', reason: 'Guard invalid config' }],
        }),
      ],
      createRepositorySuggestion({
        id: 'demo-high',
        title: 'Add runtime config guard',
        prPotentialScore: 96,
        targetFiles: [{ path: 'src/config.ts', reason: 'Guard invalid config' }],
      }),
      [
        {
          repoFullName: 'acme/demo',
          suggestions: [
            createRepositorySuggestion({
              id: 'demo-high',
              title: 'Add runtime config guard',
              prPotentialScore: 96,
              targetFiles: [{ path: 'src/config.ts', reason: 'Guard invalid config' }],
            }),
          ],
        },
        {
          repoFullName: 'acme/docs',
          suggestions: [
            createRepositorySuggestion({
              id: 'docs-setup',
              title: 'Clarify setup docs',
              prPotentialScore: 78,
              targetFiles: [{ path: 'docs/setup.md', reason: 'Onboarding docs' }],
            }),
          ],
        },
      ],
    );

    expect(markdown).toContain('## Repository Groups');
    expect(markdown).toContain('### acme/demo');
    expect(markdown).toContain('### acme/docs');
    expect(markdown).toContain('Selected across all preset repositories');
  });

  test('formats inbox and proof-of-work markdown summaries', () => {
    const inboxMarkdown = contentService.formatInboxMarkdown([createInboxItem()]);
    const proofMarkdown = contentService.formatProofOfWorkMarkdown([createProofRecord()]);

    expect(inboxMarkdown).toContain('[READY] acme/demo#42 | overall 84');
    expect(proofMarkdown).toContain('acme/demo#42 | overall 84 | published=true');
  });

  test('formats commit messages using the configured template', () => {
    const content = contentService.generateDiary([createMatchedIssue()], 'Diary body');
    const commitMessage = contentService.formatCommitMessage(content, 'feat: {{title}}\n\n{{content}}');

    expect(commitMessage).toContain('feat: Development Diary -');
    expect(commitMessage).toContain('Daily open source contribution log');
  });

  test('renders markdown fallbacks for sparse patch and pull request drafts', () => {
    const patchMarkdown = contentService.formatPatchDraftMarkdown(
      createPatchDraft({
        targetFiles: [],
        proposedChanges: [
          {
            title: 'Inspect generated output',
            details: 'Review the patch manually before applying any changes.',
            files: [],
          },
        ],
        risks: [],
        validationNotes: [],
      }),
    );
    const prMarkdown = contentService.formatPullRequestDraftMarkdown(
      createPullRequestDraft({
        validation: [],
        risks: [],
      }),
    );

    expect(contentService.getContentTypeLabel('research_note')).toBe('Research Notes');
    expect(contentService.getContentTypeLabel('development_diary')).toBe('Development Diary');
    expect(patchMarkdown).toContain('## Risks');
    expect(patchMarkdown).toContain('- None');
    expect(patchMarkdown).not.toContain('Files:');
    expect(prMarkdown).toContain('## Validation');
    expect(prMarkdown).toContain('- Not run');
    expect(prMarkdown).toContain('## Risks');
    expect(prMarkdown).toContain('- None');
  });

  test('renders contribution and summary markdown fallbacks when context is sparse', () => {
    const markdown = contentService.formatContributionDossier(
      createRankedIssue({
        body: '   ',
        repoDescription: '',
        labels: [],
        analysis: {
          coreDemand: '',
          techRequirements: [],
          solutionSuggestion: 'Investigate the issue manually.',
          estimatedWorkload: '',
        },
      }),
      createWorkspace({
        branchName: undefined,
        testCommands: [],
        validationCommands: [],
        validationWarnings: [],
        testResults: [],
      }),
      createMemory({
        lastSelectedIssue: undefined,
        preferredPaths: [],
      }),
      createPatchDraft(),
      createPullRequestDraft(),
    );
    const inboxMarkdown = contentService.formatInboxMarkdown([]);
    const proofMarkdown = contentService.formatProofOfWorkMarkdown([]);

    expect(markdown).toContain('- Agent Branch: not created');
    expect(markdown).toContain('- Labels: none');
    expect(markdown).toContain('- Repo Description: n/a');
    expect(markdown).toContain('- Issue Excerpt: n/a');
    expect(markdown).toContain('- Core Demand: n/a');
    expect(markdown).toContain('- Tech Requirements: n/a');
    expect(markdown).toContain('## Detected Test Commands');
    expect(markdown).toContain('- None detected');
    expect(markdown).toContain('## Runnable Validation Commands');
    expect(markdown).toContain('- None selected');
    expect(markdown).toContain('## Validation Safety Notes');
    expect(markdown).toContain('## Baseline Test Results');
    expect(markdown).toContain('- Not executed');
    expect(markdown).toContain('- Last Selected Issue: n/a');
    expect(markdown).toContain('- Preferred Paths: none');
    expect(inboxMarkdown).toContain('- Inbox is empty');
    expect(proofMarkdown).toContain('- No activity recorded');
  });
});

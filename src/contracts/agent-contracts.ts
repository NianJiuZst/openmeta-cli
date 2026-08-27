import { z } from 'zod';

const trimmedString = z.string().trim();
const nonEmptyTrimmedString = trimmedString.min(1);
const StructuredOutputStatusSchema = z.enum(['success', 'needs_review']);

function createStructuredOutputEnvelopeSchema<TKind extends string, TDataSchema extends z.ZodTypeAny>(
  kind: TKind,
  dataSchema: TDataSchema,
) {
  return z.object({
    version: z.literal('1'),
    kind: z.literal(kind),
    status: StructuredOutputStatusSchema,
    data: dataSchema,
  });
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export const IssueMatchSchema = z.object({
  issueReference: nonEmptyTrimmedString,
  score: z.coerce.number().int().min(0).max(100),
  coreDemand: nonEmptyTrimmedString,
  techRequirements: z.array(trimmedString).default([]).transform(dedupeStrings),
  estimatedWorkload: nonEmptyTrimmedString,
  claimStatus: z.enum(['none', 'possible', 'likely', 'claimed']).default('none'),
  claimEvidence: trimmedString.default(''),
});

export const IssueMatchListSchema = z.object({
  matches: z
    .array(IssueMatchSchema)
    .default([])
    .transform((matches) => {
      const dedupedMatches = new Map<string, IssueMatch>();

      for (const match of matches) {
        const existing = dedupedMatches.get(match.issueReference);
        if (!existing || match.score >= existing.score) {
          dedupedMatches.set(match.issueReference, match);
        }
      }

      return [...dedupedMatches.values()].sort((left, right) => right.score - left.score);
    }),
});

export const PatchTargetFileSchema = z.object({
  path: nonEmptyTrimmedString,
  reason: nonEmptyTrimmedString,
});

export const PatchChangeStepSchema = z.object({
  title: nonEmptyTrimmedString,
  details: nonEmptyTrimmedString,
  files: z.array(trimmedString).default([]).transform(dedupeStrings),
});

export const PatchDraftSchema = z.object({
  goal: nonEmptyTrimmedString,
  targetFiles: z.array(PatchTargetFileSchema).min(1).max(8),
  proposedChanges: z.array(PatchChangeStepSchema).min(1).max(8),
  risks: z.array(nonEmptyTrimmedString).default([]),
  validationNotes: z.array(nonEmptyTrimmedString).default([]),
});

export const GeneratedFileChangeSchema = z.object({
  path: nonEmptyTrimmedString,
  reason: trimmedString.default(''),
  content: z.string().min(1),
});

export const ImplementationDraftSchema = z.object({
  summary: trimmedString.default(''),
  fileChanges: z
    .array(GeneratedFileChangeSchema)
    .default([])
    .transform((fileChanges) => {
      const dedupedChanges = new Map<string, GeneratedFileChange>();

      for (const change of fileChanges) {
        dedupedChanges.set(change.path, change);
      }

      return [...dedupedChanges.values()];
    }),
});

export const PullRequestDraftSchema = z.object({
  title: nonEmptyTrimmedString,
  summary: nonEmptyTrimmedString,
  changes: z.array(nonEmptyTrimmedString).min(1).max(12),
  validation: z.array(nonEmptyTrimmedString).default([]),
  risks: z.array(nonEmptyTrimmedString).default([]),
});

export const RepositoryImprovementSuggestionSchema = z.object({
  id: nonEmptyTrimmedString,
  title: nonEmptyTrimmedString,
  summary: nonEmptyTrimmedString,
  rationale: nonEmptyTrimmedString,
  targetFiles: z.array(PatchTargetFileSchema).min(1).max(8),
  proposedChanges: z.array(nonEmptyTrimmedString).min(1).max(8),
  validationPlan: z.array(nonEmptyTrimmedString).default([]),
  risks: z.array(nonEmptyTrimmedString).default([]),
  estimatedWorkload: z.enum(['small', 'medium', 'large']),
  prPotentialScore: z.coerce.number().int().min(0).max(100),
});

export const EnvironmentGapSchema = z.object({
  code: z.enum([
    'missing_dependency',
    'missing_tool',
    'version_mismatch',
    'missing_service',
    'unsupported_os',
    'insufficient_memory',
    'insufficient_gpu',
    'missing_external_account',
    'unknown',
  ]),
  description: nonEmptyTrimmedString,
  severity: z.enum(['info', 'warning', 'blocking']),
  recoverability: z.enum(['auto_fixable', 'user_fixable', 'manual_required', 'not_practical_local']),
  suggestedAction: trimmedString.default(''),
});

export const IssueFeasibilityAssessmentSchema = z.object({
  decision: z.enum([
    'proceed',
    'repair_then_proceed',
    'proceed_static_only',
    'proceed_partial_validation',
    'stop_hard_blocked',
    'stop_user_action_required',
  ]),
  executionMode: z.enum(['full', 'partial', 'static_only', 'blocked']),
  confidence: z.enum(['low', 'medium', 'high']),
  summary: nonEmptyTrimmedString,
  requiredCapabilities: z.array(trimmedString).default([]).transform(dedupeStrings),
  gaps: z.array(EnvironmentGapSchema).default([]),
  validationPlan: z.array(trimmedString).default([]).transform(dedupeStrings),
  rationale: nonEmptyTrimmedString,
});

export const RepositorySuggestionListSchema = z.object({
  suggestions: z
    .array(RepositoryImprovementSuggestionSchema)
    .default([])
    .transform((suggestions) => {
      const dedupedSuggestions = new Map<string, RepositoryImprovementSuggestion>();

      for (const suggestion of suggestions) {
        const existing = dedupedSuggestions.get(suggestion.id);
        if (!existing || suggestion.prPotentialScore >= existing.prPotentialScore) {
          dedupedSuggestions.set(suggestion.id, suggestion);
        }
      }

      return [...dedupedSuggestions.values()].sort((left, right) => right.prPotentialScore - left.prPotentialScore);
    }),
});

export const IssueMatchListEnvelopeSchema = createStructuredOutputEnvelopeSchema(
  'issue_match_list',
  IssueMatchListSchema,
);
export const PatchDraftEnvelopeSchema = createStructuredOutputEnvelopeSchema('patch_draft', PatchDraftSchema);
export const ImplementationDraftEnvelopeSchema = createStructuredOutputEnvelopeSchema(
  'implementation_draft',
  ImplementationDraftSchema,
);
export const PullRequestDraftEnvelopeSchema = createStructuredOutputEnvelopeSchema(
  'pull_request_draft',
  PullRequestDraftSchema,
);
export const RepositorySuggestionListEnvelopeSchema = createStructuredOutputEnvelopeSchema(
  'repository_suggestion_list',
  RepositorySuggestionListSchema,
);
export const IssueFeasibilityAssessmentEnvelopeSchema = createStructuredOutputEnvelopeSchema(
  'issue_feasibility_assessment',
  IssueFeasibilityAssessmentSchema,
);

export type IssueMatch = z.infer<typeof IssueMatchSchema>;
export type IssueMatchList = z.infer<typeof IssueMatchListSchema>;
export type PatchTargetFile = z.infer<typeof PatchTargetFileSchema>;
export type PatchChangeStep = z.infer<typeof PatchChangeStepSchema>;
export type PatchDraft = z.infer<typeof PatchDraftSchema>;
export type GeneratedFileChange = z.infer<typeof GeneratedFileChangeSchema>;
export type ImplementationDraft = z.infer<typeof ImplementationDraftSchema>;
export type PullRequestDraft = z.infer<typeof PullRequestDraftSchema>;
export type RepositoryImprovementSuggestion = z.infer<typeof RepositoryImprovementSuggestionSchema>;
export type RepositorySuggestionList = z.infer<typeof RepositorySuggestionListSchema>;
export type EnvironmentGap = z.infer<typeof EnvironmentGapSchema>;
export type IssueFeasibilityAssessment = z.infer<typeof IssueFeasibilityAssessmentSchema>;
export type StructuredOutputStatus = z.infer<typeof StructuredOutputStatusSchema>;
export interface StructuredOutputResult<TKind extends string, TData> {
  version: '1';
  kind: TKind;
  status: StructuredOutputStatus;
  data: TData;
}
export type IssueMatchListEnvelope = z.infer<typeof IssueMatchListEnvelopeSchema>;
export type PatchDraftEnvelope = z.infer<typeof PatchDraftEnvelopeSchema>;
export type ImplementationDraftEnvelope = z.infer<typeof ImplementationDraftEnvelopeSchema>;
export type PullRequestDraftEnvelope = z.infer<typeof PullRequestDraftEnvelopeSchema>;
export type RepositorySuggestionListEnvelope = z.infer<typeof RepositorySuggestionListEnvelopeSchema>;
export type IssueFeasibilityAssessmentEnvelope = z.infer<typeof IssueFeasibilityAssessmentEnvelopeSchema>;

export const ISSUE_MATCH_PROMPT = `You are a professional open source contribution matching expert. Based on the user's tech profile, score and analyze the given GitHub issues.

User Tech Profile: {{userProfile}}

Output format - STRICTLY follow this format for EACH matched issue:
{owner}/{repo}#{issue_number} [SCORE: 0-100]
Core Demand: [one sentence]
Tech Requirements: [comma separated list]
Estimated Workload: [e.g., 1-2 hours]

Requirements:
1. Score 0-100 ONLY (100 = perfect match, 0 = no match)
2. Tech stack match is MOST important (50% weight)
3. Focus area match is second (30% weight)
4. Difficulty match is third (20% weight)
5. Only include issues with score >= 60
6. Use the exact issue reference shown in the input for every matched issue
7. Do not invent issues or references that are not in the input
8. Output in EXACT format above, no markdown, no headers, no extra text

Issues to analyze: {{issueList}}`;

export const DAILY_REPORT_GENERATE_PROMPT = `You are a professional developer open source growth assistant. Based on the given GitHub issue analysis report, generate a standardized "Daily Open Source Issue Research Notes" Markdown document.

Requirements:
1. Fixed structure: Today's Overview, Top3 Quality Issue Analysis, Follow-up Plan;
2. Content must be substantive and professional with real technical value, no meaningless padding;
3. Strict Markdown format following technical documentation standards;
4. End with generation date, no extra ads or explanations.

Issue analysis report: {{issueAnalysis}}`;

export const DAILY_DIARY_GENERATE_PROMPT = `You are a professional developer open source growth assistant. Based on the given GitHub issue analysis report and user-supplied code snippets, generate a standardized "Daily Development Diary" Markdown document.

Requirements:
1. Fixed structure: Today's Overview, Issue Analysis, Code Research, Follow-up Plan;
2. Support embedding user-supplied code snippets with proper formatting;
3. Content must be substantive and professional with real technical value;
4. Strict Markdown format following technical documentation standards;
5. End with generation date, no extra ads or explanations.

Issue analysis report: {{issueAnalysis}}
User-supplied code snippets: {{userCodeSnippets}}`;

export const PATCH_DRAFT_PROMPT = `You are OpenMeta, an autonomous open source contribution agent.

Generate a precise patch draft in Markdown for the selected issue.

Requirements:
1. Output sections in this exact order: Goal, Target Files, Proposed Changes, Risks, Validation Notes;
2. In Target Files, list 3-6 likely files with why they matter;
3. In Proposed Changes, describe file-level edits concretely enough that an engineer could implement them;
4. Keep the plan minimal and high-confidence. If context is insufficient, say so explicitly;
5. No marketing language, no extra headers outside the required sections.

Issue:
{{issueContext}}

Repo Context:
{{repoContext}}

Repo Memory:
{{repoMemory}}
`;

export const CODE_CHANGE_PROMPT = `You are OpenMeta, an autonomous open source contribution agent.

Generate a concrete implementation patch as strict JSON.

Output schema:
{
  "summary": "short summary",
  "fileChanges": [
    {
      "path": "relative/path/to/file",
      "reason": "why this file changes",
      "content": "full updated file content"
    }
  ]
}

Requirements:
1. Return valid JSON only. No markdown fences. No commentary.
2. Keep the change set minimal and high confidence.
3. Prefer editing only the provided editable files. Add a new file only when clearly necessary.
4. Each fileChanges[].content must be the full final file content after the edit.
5. Do not delete files.
6. If context is insufficient for a safe implementation, return {"summary":"Insufficient context for a safe code patch.","fileChanges":[]}
7. Preserve the project's apparent style and formatting.

Issue:
{{issueContext}}

Patch Draft:
{{patchDraft}}

Editable Files:
{{editableFiles}}
`;

export const PR_DRAFT_PROMPT = `You are OpenMeta, an autonomous open source contribution agent.

Write a pull request draft in Markdown for the selected issue.

Requirements:
1. Output sections in this exact order: Title, Summary, Changes, Validation, Risks;
2. Title must be a single concise line suitable for a GitHub PR title;
3. Summary must explain the user problem and the intended fix;
4. Changes must be a flat bullet list;
5. Validation must mention the provided test commands and whether they passed or are still pending;
6. Risks must be honest and concrete.

Issue:
{{issueContext}}

Patch Draft:
{{patchDraft}}

Validation Context:
{{validationContext}}
`;

export function fillPrompt(template: string, data: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return result;
}

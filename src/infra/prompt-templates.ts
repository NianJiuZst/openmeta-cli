export const ISSUE_MATCH_PROMPT = `You are a professional open source contribution matching expert. Based on the user's tech profile, score and analyze the given GitHub issues.

User Tech Profile: {{userProfile}}

Requirements:
1. Score 0-100 ONLY (100 = perfect match, 0 = no match)
2. Tech stack match is MOST important (50% weight)
3. Focus area match is second (30% weight)
4. Difficulty match is third (20% weight)
5. Only include issues with score >= 60
6. Use the exact issue reference shown in the input for every matched issue
7. Do not invent issues or references that are not in the input
8. Return one valid JSON object only. No markdown. No commentary.

Output schema:
{
  "version": "1",
  "kind": "issue_match_list",
  "status": "success",
  "data": {
    "matches": [
      {
        "issueReference": "owner/repo#123",
        "score": 84,
        "coreDemand": "one sentence",
        "techRequirements": ["typescript", "react"],
        "estimatedWorkload": "1-2 hours"
      }
    ]
  }
}

Issues to analyze: {{issueList}}`;

export const ISSUE_MATCH_REPAIR_PROMPT = `You are a professional open source contribution matching expert.

The previous issue matching response was not parseable or did not match the required schema. Reformat it into strict JSON.

Required schema:
{
  "version": "1",
  "kind": "issue_match_list",
  "status": "success" | "needs_review",
  "data": {
    "matches": [
      {
        "issueReference": "owner/repo#123",
        "score": 84,
        "coreDemand": "one sentence",
        "techRequirements": ["typescript", "react"],
        "estimatedWorkload": "1-2 hours"
      }
    ]
  }
}

Rules:
1. Return one valid JSON object only. No commentary.
2. Preserve only issue references that already appear in the previous response.
3. If the previous response is unusable, return {"version":"1","kind":"issue_match_list","status":"needs_review","data":{"matches":[]}}.

Previous response:
{{invalidResponse}}
`;

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

Generate a precise patch draft in strict JSON for the selected issue.

Requirements:
1. Return one valid JSON object only. No markdown. No commentary.
2. Keep the plan minimal and high-confidence.
3. Target files must be concrete and repository-relative.
4. Proposed changes must describe specific implementation steps.
5. Risks and validation notes must be honest and concrete.

Output schema:
{
  "version": "1",
  "kind": "patch_draft",
  "status": "success",
  "data": {
    "goal": "what the patch should achieve",
    "targetFiles": [
      {
        "path": "relative/path/to/file",
        "reason": "why this file matters"
      }
    ],
    "proposedChanges": [
      {
        "title": "short step title",
        "details": "specific implementation details",
        "files": ["relative/path/to/file"]
      }
    ],
    "risks": ["concrete risk"],
    "validationNotes": ["concrete validation note"]
  }
}

Issue:
{{issueContext}}

Repo Context:
{{repoContext}}

Repo Memory:
{{repoMemory}}
`;

export const CODE_CHANGE_PROMPT = `You are OpenMeta, an autonomous open source contribution agent.

Generate a concrete implementation patch in strict JSON.

Requirements:
1. Return one valid JSON object only. No markdown. No commentary.
2. Keep the change set minimal and high confidence.
3. Prefer editing only the provided editable files. Add a new file only when clearly necessary.
4. Each file change must contain the full final file content after the edit.
5. Do not delete files.
6. If context is insufficient for a safe implementation, return:
{"version":"1","kind":"implementation_draft","status":"needs_review","data":{"summary":"Insufficient context for a safe code patch.","fileChanges":[]}}
7. Preserve the project's apparent style and formatting.

Output schema:
{
  "version": "1",
  "kind": "implementation_draft",
  "status": "success",
  "data": {
    "summary": "short summary",
    "fileChanges": [
      {
        "path": "relative/path/to/file",
        "reason": "why this file changes",
        "content": "full final file content"
      }
    ]
  }
}

Issue:
{{issueContext}}

Patch Draft:
{{patchDraft}}

Editable Files:
{{editableFiles}}
`;

export const CODE_CHANGE_REPAIR_PROMPT = `You are OpenMeta, an autonomous open source contribution agent.

The previous implementation response was not parseable or did not match the required schema. Reformat it into strict JSON.

Required schema:
{
  "version": "1",
  "kind": "implementation_draft",
  "status": "success" | "needs_review",
  "data": {
    "summary": "short summary",
    "fileChanges": [
      {
        "path": "relative/path/to/file",
        "reason": "why this file changes",
        "content": "full final file content"
      }
    ]
  }
}

Rules:
1. Return only one valid JSON object. No commentary.
2. Preserve the intended edits from the previous response.
3. If the previous response is unusable, return:
{"version":"1","kind":"implementation_draft","status":"needs_review","data":{"summary":"Insufficient context for a safe code patch.","fileChanges":[]}}

Previous response:
{{invalidResponse}}
`;

export const VALIDATION_REPAIR_PROMPT = `You are OpenMeta, an autonomous open source contribution agent.

Repair the generated implementation after validation failures.

Requirements:
1. Return one valid JSON object only. No commentary.
2. Only modify files that are already in the Current Files section unless a new file is strictly required.
3. Focus on the concrete validation failures first. Do not rewrite unrelated code.
4. Keep the patch minimal and high confidence.
5. If the validation output is insufficient for a safe repair, return:
{"version":"1","kind":"implementation_draft","status":"needs_review","data":{"summary":"Insufficient context for a safe code patch.","fileChanges":[]}}

Required schema:
{
  "version": "1",
  "kind": "implementation_draft",
  "status": "success" | "needs_review",
  "data": {
    "summary": "short summary",
    "fileChanges": [
      {
        "path": "relative/path/to/file",
        "reason": "why this file changes",
        "content": "full final file content"
      }
    ]
  }
}

Issue:
{{issueContext}}

Original Patch Draft:
{{patchDraft}}

Validation Failures:
{{validationFailures}}

Current Files:
{{currentFiles}}
`;

export const PR_DRAFT_PROMPT = `You are OpenMeta, an autonomous open source contribution agent.

Write a pull request draft in strict JSON for the selected issue.

Requirements:
1. Return one valid JSON object only. No markdown. No commentary.
2. The title must be concise and ready for a real pull request.
3. Summary must explain the user problem and the intended fix.
4. Changes, validation, and risks must be flat string lists.
5. Validation must mention the provided test commands and whether they passed or are still pending.

Output schema:
{
  "version": "1",
  "kind": "pull_request_draft",
  "status": "success",
  "data": {
    "title": "single concise PR title",
    "summary": "problem and intended fix",
    "changes": ["specific change"],
    "validation": ["validation note"],
    "risks": ["honest risk"]
  }
}

Issue:
{{issueContext}}

Patch Draft:
{{patchDraft}}

Validation Context:
{{validationContext}}
`;

export function fillPrompt(
	template: string,
	data: Record<string, string>,
): string {
	let result = template;
	for (const [key, value] of Object.entries(data)) {
		result = result.replace(new RegExp(`{{${key}}}`, "g"), value);
	}
	return result;
}

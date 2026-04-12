export const ISSUE_MATCH_PROMPT = `You are a professional open source contribution matching expert. Based on the user's tech profile, score and analyze the given GitHub issues.

User Tech Profile: {{userProfile}}

Output format - STRICTLY follow this format for EACH issue:
#{issue_number} [SCORE: 0-100]
Core Demand: [one sentence]
Tech Requirements: [comma separated list]
Estimated Workload: [e.g., 1-2 hours]

Requirements:
1. Score 0-100 ONLY (100 = perfect match, 0 = no match)
2. Tech stack match is MOST important (50% weight)
3. Focus area match is second (30% weight)
4. Difficulty match is third (20% weight)
5. Only include issues with score >= 60
6. ALWAYS output AT LEAST 5 issues (fill to 5 if needed)
7. Output in EXACT format above, no markdown, no headers, no extra text

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

export function fillPrompt(template: string, data: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return result;
}

import OpenAI from 'openai';
import type {
  GitHubIssue,
  ImplementationDraft,
  MatchedIssue,
  RankedIssue,
  RepoMemory,
  RepoWorkspaceContext,
  UserProfile,
} from '../types/index.js';
import { logger } from '../infra/logger.js';
import {
  CODE_CHANGE_PROMPT,
  fillPrompt,
  ISSUE_MATCH_PROMPT,
  DAILY_REPORT_GENERATE_PROMPT,
  DAILY_DIARY_GENERATE_PROMPT,
  PATCH_DRAFT_PROMPT,
  PR_DRAFT_PROMPT,
} from '../infra/prompt-templates.js';

export class LLMService {
  private client: OpenAI | null = null;
  private modelName: string = 'gpt-4o-mini';

  initialize(apiKey: string, baseUrl: string, modelName?: string): void {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });
    if (modelName) {
      this.modelName = modelName;
    }
  }

  async validateConnection(): Promise<boolean> {
    if (!this.client) {
      throw new Error('LLM client not initialized');
    }

    try {
      await this.client.chat.completions.create({
        model: this.modelName,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      });
      logger.success('LLM API connection validated');
      return true;
    } catch (error) {
      logger.warn('LLM API connection check failed.');
      logger.debug('LLM API connection check failed', error);
      return false;
    }
  }

  async scoreIssues(userProfile: UserProfile, issues: GitHubIssue[]): Promise<MatchedIssue[]> {
    if (issues.length === 0) {
      return [];
    }

    const issueList = issues.map(i =>
      `Issue Reference: ${this.getIssueReference(i)}
Title: ${i.title}
Body: ${i.body.slice(0, 500)}
Labels: ${i.labels.join(', ')}
Repo Description: ${i.repoDescription}
Repo Stars: ${i.repoStars}`
    ).join('\n\n---\n\n');

    const prompt = fillPrompt(ISSUE_MATCH_PROMPT, {
      userProfile: JSON.stringify(userProfile, null, 2),
      issueList,
    });

    const content = await this.chat(prompt);

    return this.parseLLMResponse(content, issues);
  }

  async generateDailyReport(issueAnalysis: string): Promise<string> {
    const prompt = fillPrompt(DAILY_REPORT_GENERATE_PROMPT, {
      issueAnalysis,
    });

    return await this.chat(prompt);
  }

  async generateDailyDiary(issueAnalysis: string, userCodeSnippets: string): Promise<string> {
    const prompt = fillPrompt(DAILY_DIARY_GENERATE_PROMPT, {
      issueAnalysis,
      userCodeSnippets: userCodeSnippets || 'No code snippets provided.',
    });

    return await this.chat(prompt);
  }

  async generatePatchDraft(issue: RankedIssue, workspace: RepoWorkspaceContext, memory: RepoMemory): Promise<string> {
    const repoContext = [
      `Workspace Path: ${workspace.workspacePath}`,
      `Default Branch: ${workspace.defaultBranch}`,
      `Workspace Dirty: ${workspace.workspaceDirty}`,
      `Candidate Files: ${workspace.candidateFiles.join(', ') || 'none'}`,
      `Detected Test Commands: ${workspace.testCommands.map((item) => item.command).join(', ') || 'none'}`,
      'Snippets:',
      ...workspace.snippets.map((snippet) => `FILE: ${snippet.path}\n${snippet.content}`),
    ].join('\n\n');

    const repoMemory = [
      `Last Selected Issue: ${memory.lastSelectedIssue || 'n/a'}`,
      `Generated Dossiers: ${memory.generatedDossiers}`,
      `Preferred Paths: ${memory.preferredPaths.join(', ') || 'none'}`,
      `Known Test Commands: ${memory.detectedTestCommands.join(', ') || 'none'}`,
    ].join('\n');

    const prompt = fillPrompt(PATCH_DRAFT_PROMPT, {
      issueContext: this.formatRankedIssue(issue),
      repoContext,
      repoMemory,
    });

    return await this.chat(prompt);
  }

  async generateImplementationDraft(
    issue: RankedIssue,
    workspace: RepoWorkspaceContext,
    patchDraft: string,
  ): Promise<ImplementationDraft> {
    const editableFiles = workspace.snippets.length > 0
      ? workspace.snippets.map((snippet) => `FILE: ${snippet.path}\n${snippet.content}`).join('\n\n')
      : 'No editable files were detected.';

    const prompt = fillPrompt(CODE_CHANGE_PROMPT, {
      issueContext: this.formatRankedIssue(issue),
      patchDraft,
      editableFiles,
    });

    const content = await this.chat(prompt, { temperature: 0.2 });
    return this.parseImplementationDraft(content);
  }

  async generatePrDraft(
    issue: RankedIssue,
    patchDraft: string,
    workspace: RepoWorkspaceContext,
  ): Promise<string> {
    const validationContext = [
      `Detected Commands: ${workspace.testCommands.map((item) => item.command).join(', ') || 'none'}`,
      `Baseline Results: ${workspace.testResults.length > 0 ? workspace.testResults.map((result) => `${result.command} => ${result.passed ? 'passed' : `failed (${result.exitCode ?? 'n/a'})`}`).join('; ') : 'not executed'}`,
    ].join('\n');

    const prompt = fillPrompt(PR_DRAFT_PROMPT, {
      issueContext: this.formatRankedIssue(issue),
      patchDraft,
      validationContext,
    });

    return await this.chat(prompt);
  }

  private async chat(prompt: string, options: { temperature?: number } = {}): Promise<string> {
    if (!this.client) {
      throw new Error('LLM client not initialized');
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: prompt },
        ],
        temperature: options.temperature ?? 0.7,
      });

      const content = response.choices[0]?.message?.content || '';
      return content;
    } catch (error) {
      logger.debug('LLM chat failed', error);
      throw new Error('The LLM request failed. Please verify your provider, model, and API key.');
    }
  }

  private parseLLMResponse(content: string, originalIssues: GitHubIssue[]): MatchedIssue[] {
    const matchedIssues: MatchedIssue[] = [];
    const lines = content.split('\n');

    for (const issue of originalIssues) {
      const issueReference = this.getIssueReference(issue);
      const issueLinePattern = new RegExp(`^${this.escapeRegExp(issueReference)}\\b`, 'i');
      const issueLineIndex = lines.findIndex(line => issueLinePattern.test(line.trim()));
      if (issueLineIndex === -1) continue;

      const issueLine = lines[issueLineIndex];
      if (!issueLine) {
        continue;
      }

      const scoreMatch = issueLine.match(/SCORE:\s*(\d+)|Score:\s*(\d+)|#\d+\s*(\d+)/i);
      let score = 0;
      if (scoreMatch) {
        const rawScore = scoreMatch[1] || scoreMatch[2] || scoreMatch[3];
        score = rawScore ? parseInt(rawScore, 10) || 0 : 0;
      }

      score = Math.min(100, Math.max(0, score));

      if (score >= 60) {
        const context = lines.slice(issueLineIndex, issueLineIndex + 5).join('\n');

        const demandMatch = context.match(/Core Demand:\s*([^\n]+)/i);
        const techMatch = context.match(/Tech(?:nology)? Requirements?:\s*([^\n]+)/i);
        const workloadMatch = context.match(/Estimated Workload:\s*([^\n]+)/i);

        matchedIssues.push({
          ...issue,
          matchScore: score,
          analysis: {
            coreDemand: demandMatch && demandMatch[1] ? demandMatch[1].trim() : '',
            techRequirements: techMatch && techMatch[1] ? techMatch[1].split(/[,;]/).map(s => s.trim()).filter(Boolean) : [],
            solutionSuggestion: '',
            estimatedWorkload: workloadMatch && workloadMatch[1] ? workloadMatch[1].trim() : '',
          },
        });
      }
    }

    return matchedIssues.sort((a, b) => b.matchScore - a.matchScore);
  }

  private parseImplementationDraft(content: string): ImplementationDraft {
    const payload = this.extractJsonObject(content);
    const parsed = JSON.parse(payload) as Partial<ImplementationDraft>;

    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
      fileChanges: Array.isArray(parsed.fileChanges)
        ? parsed.fileChanges
          .map((item) => ({
            path: typeof item?.path === 'string' ? item.path.trim() : '',
            reason: typeof item?.reason === 'string' ? item.reason.trim() : '',
            content: typeof item?.content === 'string' ? item.content : '',
          }))
          .filter((item) => item.path.length > 0 && item.content.length > 0)
        : [],
    };
  }

  private extractJsonObject(content: string): string {
    const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim();
    }

    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1).trim();
    }

    throw new Error('LLM did not return a valid JSON object for the implementation draft.');
  }

  private getIssueReference(issue: GitHubIssue): string {
    return `${issue.repoFullName}#${issue.number}`;
  }

  private formatRankedIssue(issue: RankedIssue): string {
    return [
      `Issue: ${issue.repoFullName}#${issue.number}`,
      `Title: ${issue.title}`,
      `Body: ${issue.body}`,
      `Core Demand: ${issue.analysis.coreDemand}`,
      `Tech Requirements: ${issue.analysis.techRequirements.join(', ')}`,
      `Estimated Workload: ${issue.analysis.estimatedWorkload}`,
      `Technical Match Score: ${issue.matchScore}`,
      `Opportunity Score: ${issue.opportunity.score}`,
      `Overall Score: ${issue.opportunity.overallScore}`,
      `Opportunity Summary: ${issue.opportunity.summary}`,
    ].join('\n');
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export const llmService = new LLMService();

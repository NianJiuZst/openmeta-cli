import OpenAI from 'openai';
import { z } from 'zod';
import {
  ImplementationDraftEnvelopeSchema,
  IssueMatchListEnvelopeSchema,
  PatchDraftEnvelopeSchema,
  type StructuredOutputResult,
  type PatchDraft,
  PullRequestDraftEnvelopeSchema,
  type PullRequestDraft,
} from '../contracts/index.js';
import type {
  GitHubIssue,
  ImplementationDraft,
  MatchedIssue,
  RankedIssue,
  RepoFileSnippet,
  RepoMemory,
  RepoWorkspaceContext,
  TestResult,
  UserProfile,
} from '../types/index.js';
import { logger } from '../infra/logger.js';
import {
  CODE_CHANGE_PROMPT,
  CODE_CHANGE_REPAIR_PROMPT,
  fillPrompt,
  ISSUE_MATCH_PROMPT,
  ISSUE_MATCH_REPAIR_PROMPT,
  DAILY_REPORT_GENERATE_PROMPT,
  DAILY_DIARY_GENERATE_PROMPT,
  PATCH_DRAFT_PROMPT,
  PR_DRAFT_PROMPT,
  VALIDATION_REPAIR_PROMPT,
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

  async scoreIssues(
    userProfile: UserProfile,
    issues: GitHubIssue[],
  ): Promise<StructuredOutputResult<'issue_match_list', MatchedIssue[]>> {
    if (issues.length === 0) {
      return {
        version: '1',
        kind: 'issue_match_list',
        status: 'success',
        data: [],
      };
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

    return this.generateStructuredOutput({
      prompt,
      parser: (content) => this.parseLLMResponse(content, issues),
      repairPrompt: ISSUE_MATCH_REPAIR_PROMPT,
    });
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

  async generatePatchDraft(
    issue: RankedIssue,
    workspace: RepoWorkspaceContext,
    memory: RepoMemory,
  ): Promise<StructuredOutputResult<'patch_draft', PatchDraft>> {
    const repoContext = [
      `Workspace Path: ${workspace.workspacePath}`,
      `Default Branch: ${workspace.defaultBranch}`,
      `Workspace Dirty: ${workspace.workspaceDirty}`,
      `Candidate Files: ${workspace.candidateFiles.join(', ') || 'none'}`,
      `Detected Test Commands: ${workspace.testCommands.map((item) => item.command).join(', ') || 'none'}`,
      `Runnable Validation Commands: ${workspace.validationCommands.map((item) => item.command).join(', ') || 'none'}`,
      `Validation Safety Notes: ${workspace.validationWarnings.join(' | ') || 'none'}`,
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

    return this.generateStructuredOutput({
      prompt,
      parser: this.parsePatchDraft.bind(this),
    });
  }

  async generateImplementationDraft(
    issue: RankedIssue,
    workspace: RepoWorkspaceContext,
    patchDraft: PatchDraft,
  ): Promise<StructuredOutputResult<'implementation_draft', ImplementationDraft>> {
    const editableFiles = workspace.snippets.length > 0
      ? workspace.snippets.map((snippet) => `FILE: ${snippet.path}\n${snippet.content}`).join('\n\n')
      : 'No editable files were detected.';

    const prompt = fillPrompt(CODE_CHANGE_PROMPT, {
      issueContext: this.formatRankedIssue(issue),
      patchDraft: JSON.stringify(patchDraft, null, 2),
      editableFiles,
    });

    return this.generateStructuredOutput({
      prompt,
      parser: this.parseImplementationDraft.bind(this),
      repairPrompt: CODE_CHANGE_REPAIR_PROMPT,
      temperature: 0.1,
    });
  }

  async generatePrDraft(
    issue: RankedIssue,
    patchDraft: PatchDraft,
    workspace: RepoWorkspaceContext,
  ): Promise<StructuredOutputResult<'pull_request_draft', PullRequestDraft>> {
    const validationContext = [
      `Detected Commands: ${workspace.testCommands.map((item) => item.command).join(', ') || 'none'}`,
      `Runnable Commands: ${workspace.validationCommands.map((item) => item.command).join(', ') || 'none'}`,
      `Baseline Results: ${workspace.testResults.length > 0 ? workspace.testResults.map((result) => `${result.command} => ${result.passed ? 'passed' : `failed (${result.exitCode ?? 'n/a'})`}`).join('; ') : 'not executed'}`,
    ].join('\n');

    const prompt = fillPrompt(PR_DRAFT_PROMPT, {
      issueContext: this.formatRankedIssue(issue),
      patchDraft: JSON.stringify(patchDraft, null, 2),
      validationContext,
    });

    return this.generateStructuredOutput({
      prompt,
      parser: this.parsePullRequestDraft.bind(this),
    });
  }

  async generateImplementationRepairDraft(
    issue: RankedIssue,
    patchDraft: PatchDraft,
    validationResults: TestResult[],
    currentFiles: RepoFileSnippet[],
  ): Promise<StructuredOutputResult<'implementation_draft', ImplementationDraft>> {
    const validationFailures = validationResults.length > 0
      ? validationResults
        .filter((result) => !result.passed)
        .map((result) => `${result.command} | exit=${result.exitCode ?? 'n/a'}\n${result.output}`.trim())
        .join('\n\n---\n\n')
      : 'No validation failures were provided.';

    const prompt = fillPrompt(VALIDATION_REPAIR_PROMPT, {
      issueContext: this.formatRankedIssue(issue),
      patchDraft: JSON.stringify(patchDraft, null, 2),
      validationFailures,
      currentFiles: currentFiles.length > 0
        ? currentFiles.map((snippet) => `FILE: ${snippet.path}\n${snippet.content}`).join('\n\n')
        : 'No current files were provided.',
    });

    return this.generateStructuredOutput({
      prompt,
      parser: this.parseImplementationDraft.bind(this),
      repairPrompt: CODE_CHANGE_REPAIR_PROMPT,
      temperature: 0.1,
    });
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

  private async generateStructuredOutput<T>(input: {
    prompt: string;
    parser: (content: string) => T;
    repairPrompt?: string;
    temperature?: number;
  }): Promise<T> {
    const content = await this.chat(input.prompt, { temperature: input.temperature });

    try {
      return input.parser(content);
    } catch (error) {
      if (!input.repairPrompt) {
        throw error;
      }

      logger.debug('Structured output parsing failed, attempting repair', error);
      const repairedContent = await this.chat(fillPrompt(input.repairPrompt, {
        invalidResponse: content.slice(0, 12000),
      }), { temperature: 0 });

      return input.parser(repairedContent);
    }
  }

  private parseLLMResponse(
    content: string,
    originalIssues: GitHubIssue[],
  ): StructuredOutputResult<'issue_match_list', MatchedIssue[]> {
    const issueByReference = new Map(
      originalIssues.map((issue) => [this.getIssueReference(issue), issue]),
    );

    const parsed = this.parseStructuredJson(content, IssueMatchListEnvelopeSchema);

    return {
      version: parsed.version,
      kind: parsed.kind,
      status: parsed.status,
      data: parsed.data.matches
      .filter((match) => match.score >= 60)
      .flatMap((match) => {
        const issue = issueByReference.get(match.issueReference);
        if (!issue) {
          return [];
        }

        return [{
          ...issue,
          matchScore: match.score,
          analysis: {
            coreDemand: match.coreDemand,
            techRequirements: match.techRequirements,
            solutionSuggestion: '',
            estimatedWorkload: match.estimatedWorkload,
          },
        }];
      }),
    };
  }

  private parseImplementationDraft(
    content: string,
  ): StructuredOutputResult<'implementation_draft', ImplementationDraft> {
    return this.parseStructuredJson(content, ImplementationDraftEnvelopeSchema);
  }

  private parsePatchDraft(content: string): StructuredOutputResult<'patch_draft', PatchDraft> {
    return this.parseStructuredJson(content, PatchDraftEnvelopeSchema);
  }

  private parsePullRequestDraft(
    content: string,
  ): StructuredOutputResult<'pull_request_draft', PullRequestDraft> {
    return this.parseStructuredJson(content, PullRequestDraftEnvelopeSchema);
  }

  private parseStructuredJson<T>(content: string, schema: z.ZodType<T>): T {
    let payload: unknown;

    try {
      payload = JSON.parse(this.extractJsonObject(content));
    } catch {
      throw new Error('LLM did not return a parseable JSON object.');
    }

    const result = schema.safeParse(payload);
    if (result.success) {
      return result.data;
    }

    const issueSummary = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');

    throw new Error(`LLM output failed schema validation. ${issueSummary}`);
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

}

export const llmService = new LLMService();

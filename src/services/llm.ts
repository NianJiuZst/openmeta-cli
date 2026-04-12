import OpenAI from 'openai';
import type { GitHubIssue, MatchedIssue, UserProfile } from '../types/index.js';
import { logger } from '../infra/logger.js';
import { fillPrompt, ISSUE_MATCH_PROMPT, DAILY_REPORT_GENERATE_PROMPT, DAILY_DIARY_GENERATE_PROMPT } from '../infra/prompt-templates.js';

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
      logger.error('LLM API connection failed:', error);
      return false;
    }
  }

  async scoreIssues(userProfile: UserProfile, issues: GitHubIssue[]): Promise<MatchedIssue[]> {
    const issueList = issues.map(i =>
      `Issue #${i.number} in ${i.repoFullName}
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

    const matchedIssues = this.parseLLMResponse(content, issues);
    return matchedIssues.slice(0, 3);
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

  private async chat(prompt: string): Promise<string> {
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
        temperature: 0.7,
      });

      const content = response.choices[0]?.message?.content || '';
      return content;
    } catch (error) {
      logger.error('LLM chat failed:', error);
      throw error;
    }
  }

  private parseLLMResponse(content: string, originalIssues: GitHubIssue[]): MatchedIssue[] {
    const matchedIssues: MatchedIssue[] = [];
    const lines = content.split('\n');

    for (const issue of originalIssues) {
      // Find the line for this issue - look for "#issue_number" pattern
      const issueLineIndex = lines.findIndex(line => line.includes(`#${issue.number}`));
      if (issueLineIndex === -1) continue;

      // Extract score from format like "#123 [SCORE: 85]" or "#123 Score: 85"
      const issueLine = lines[issueLineIndex];
      const scoreMatch = issueLine.match(/SCORE:\s*(\d+)|Score:\s*(\d+)|#\d+\s*(\d+)/i);
      let score = 0;
      if (scoreMatch) {
        score = parseInt(scoreMatch[1] || scoreMatch[2] || scoreMatch[3], 10) || 0;
      }
      // Clamp score to 0-100 range
      score = Math.min(100, Math.max(0, score));

      if (score >= 60) {
        // Get context lines around the issue line for analysis
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
}

export const llmService = new LLMService();

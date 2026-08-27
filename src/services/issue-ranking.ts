import { detectEnvironment, logger } from '../infra/index.js';
import type { AppConfig, EnvironmentInfo, GitHubIssue, MatchedIssue, RankedIssue } from '../types/index.js';
import { feasibilityHintService } from './feasibility-hints.js';
import type { RepositoryProbe } from './github.js';
import { githubService } from './github.js';
import { llmService } from './llm.js';
import { opportunityService } from './opportunity.js';
import { proofOfWorkService } from './proof-of-work.js';

const ISSUE_SCORING_BATCH_SIZE = 20;
const MAX_ISSUES_FOR_LLM_SCORING = 80;
const MAX_ISSUES_FOR_FEASIBILITY_HINTS = 30;
const MAX_ISSUES_FOR_CLAIM_CHECKS = 15;
const CLAIM_CHECK_BATCH_SIZE = 5;

const PROFILE_TERM_ALIASES: Record<string, string[]> = {
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx'],
  'node js': ['node', 'nodejs', 'npm'],
  react: ['jsx', 'tsx', 'component', 'hooks'],
  vue: ['vuejs', 'component'],
  python: ['py', 'pytest'],
  django: ['python', 'orm'],
  fastapi: ['python', 'api'],
  go: ['golang'],
  rust: ['cargo'],
  docker: ['container', 'compose'],
  'c plus plus': ['cpp'],
};

const FOCUS_AREA_TERMS: Record<string, string[]> = {
  'web-dev': ['web', 'frontend', 'browser', 'react', 'vue', 'css', 'accessibility'],
  backend: ['backend', 'api', 'server', 'database', 'auth'],
  devops: ['ci', 'deploy', 'docker', 'kubernetes', 'workflow'],
  'ai-ml': ['ai', 'ml', 'model', 'prompt', 'embedding', 'inference'],
  mobile: ['mobile', 'ios', 'android', 'swift', 'kotlin', 'react native'],
  security: ['security', 'auth', 'permission', 'vulnerability', 'encryption'],
  data: ['data', 'sql', 'pipeline', 'analytics', 'warehouse'],
  'open-source': ['docs', 'contributor', 'cli', 'good first issue', 'help wanted'],
};

export class IssueRankingService {
  private cachedEnvironment: EnvironmentInfo | null = null;
  private detectionPromise: Promise<EnvironmentInfo> | null = null;
  private detectionScheduled = false;
  private repoProbeCache = new Map<string, RepositoryProbe | null>();

  ensureEnvironment(): Promise<EnvironmentInfo> {
    if (this.cachedEnvironment) {
      return Promise.resolve(this.cachedEnvironment);
    }
    if (!this.detectionPromise) {
      this.detectionPromise = Promise.resolve().then(() => {
        if (!this.cachedEnvironment) {
          this.cachedEnvironment = detectEnvironment();
        }
        return this.cachedEnvironment;
      });
    }
    return this.detectionPromise;
  }

  getEnvironmentCached(): EnvironmentInfo | null {
    // Kick off background detection if not started; don't block the caller
    this.warmEnvironmentCache();
    return this.cachedEnvironment;
  }

  warmEnvironmentCache(): void {
    if (this.cachedEnvironment || this.detectionPromise || this.detectionScheduled) {
      return;
    }

    this.detectionScheduled = true;
    setTimeout(() => {
      this.detectionScheduled = false;
      void this.ensureEnvironment();
    }, 0);
  }

  async loadRankedIssues(
    config: AppConfig,
    options: {
      refresh?: boolean;
      repoFullName?: string;
      onStatus?: (message: string) => void;
      minStars?: number;
      maxStars?: number;
    } = {},
  ): Promise<RankedIssue[]> {
    const issues = await githubService.fetchTrendingIssues({
      refresh: options.refresh,
      repoFullName: options.repoFullName,
      onStatus: options.onStatus,
      techStack: config.userProfile.techStack,
      minStars: options.minStars,
      maxStars: options.maxStars,
    });
    const rankedCandidates = this.rankIssuesForProfile(issues, config.userProfile);
    const claimAwareCandidates = await this.enrichIssueClaimContexts(rankedCandidates);
    const matched = await this.scoreIssuesInBatches(config.userProfile, claimAwareCandidates);
    return this.applyScoutFeasibilityHints(opportunityService.rankIssues(matched, config.scoring));
  }

  async loadTargetIssue(
    config: AppConfig,
    target: { repoFullName: string; issueNumber: number },
  ): Promise<RankedIssue[]> {
    const issue = await githubService.fetchIssue(target.repoFullName, target.issueNumber);
    const [claimAwareIssue] = await this.enrichIssueClaimContexts([issue]);
    const targetIssue = claimAwareIssue ?? issue;
    const [matched] = await this.scoreIssuesInBatches(config.userProfile, [targetIssue]);
    if (!matched) {
      return this.applyScoutFeasibilityHints(
        opportunityService.rankIssues(this.buildLocalIssueMatches([targetIssue], config.userProfile), config.scoring),
      );
    }

    return this.applyScoutFeasibilityHints(opportunityService.rankIssues([matched], config.scoring));
  }

  buildLocalIssueMatches(issues: GitHubIssue[], userProfile: AppConfig['userProfile']): MatchedIssue[] {
    return issues.slice(0, MAX_ISSUES_FOR_LLM_SCORING).map((issue) => {
      const matchScore = this.clampScore(this.scoreIssueForProfile(issue, userProfile));
      const techRequirements = this.inferLocalTechRequirements(issue, userProfile);

      return {
        ...issue,
        matchScore,
        analysis: {
          coreDemand: issue.title,
          techRequirements,
          solutionSuggestion:
            'OpenMeta can shortlist this issue heuristically, then run "openmeta agent" to draft a concrete patch plan.',
          estimatedWorkload: this.estimateLocalWorkload(issue),
        },
      };
    });
  }

  async scoreIssuesInBatches(userProfile: AppConfig['userProfile'], issues: GitHubIssue[]): Promise<MatchedIssue[]> {
    const matches: MatchedIssue[] = [];
    const issuesToScore = issues.slice(0, MAX_ISSUES_FOR_LLM_SCORING);

    for (let start = 0; start < issuesToScore.length; start += ISSUE_SCORING_BATCH_SIZE) {
      const batch = issuesToScore.slice(start, start + ISSUE_SCORING_BATCH_SIZE);
      const scoredBatch = await llmService.scoreIssues(userProfile, batch);
      if (scoredBatch.status !== 'success') {
        logger.warn(
          'Issue scoring returned advisory results that require review. Continuing with the parsed matches only.',
        );
      }
      matches.push(...scoredBatch.data);
    }

    return matches;
  }

  private async enrichIssueClaimContexts(issues: GitHubIssue[]): Promise<GitHubIssue[]> {
    const candidates = issues.slice(0, MAX_ISSUES_FOR_CLAIM_CHECKS);
    const enriched: GitHubIssue[] = [];

    for (let start = 0; start < candidates.length; start += CLAIM_CHECK_BATCH_SIZE) {
      const batch = candidates.slice(start, start + CLAIM_CHECK_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (issue) => {
          try {
            const context = await githubService.fetchIssueClaimContext(issue.repoFullName, issue.number);
            return { ...issue, ...context };
          } catch (error) {
            logger.debug(`Unable to enrich claim context for ${issue.repoFullName}#${issue.number}`, error);
            return issue;
          }
        }),
      );
      enriched.push(...results);
    }

    return [...enriched, ...issues.slice(MAX_ISSUES_FOR_CLAIM_CHECKS)];
  }

  rankIssuesForProfile(issues: GitHubIssue[], userProfile: AppConfig['userProfile']): GitHubIssue[] {
    const repoOrder = new Map<string, number>();

    return [...issues]
      .map((issue) => {
        const repoIdx = repoOrder.get(issue.repoFullName) ?? 0;
        repoOrder.set(issue.repoFullName, repoIdx + 1);
        const sameRepoPenalty = repoIdx >= 2 ? 20 : repoIdx >= 1 ? 10 : 0;
        return {
          issue,
          score: Math.max(0, this.scoreIssueForProfile(issue, userProfile) - sameRepoPenalty),
        };
      })
      .sort((left, right) => {
        const scoreDelta = right.score - left.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return new Date(right.issue.updatedAt).getTime() - new Date(left.issue.updatedAt).getTime();
      })
      .map((entry) => entry.issue);
  }

  selectIssueForAutomation(issues: RankedIssue[], minOverallScore: number): RankedIssue | undefined {
    const contributedIds = new Set(proofOfWorkService.load().records.map((r) => `${r.repoFullName}#${r.issueNumber}`));

    const fresh = issues.filter(
      (issue) =>
        this.getAdjustedOverallScore(issue) >= minOverallScore &&
        feasibilityHintService.isSafeForHeadless(issue) &&
        !contributedIds.has(`${issue.repoFullName}#${issue.number}`),
    );

    if (fresh.length > 0) {
      return fresh[0];
    }

    // Fallback: all above-threshold issues already attempted — pick best unattempted
    const unattempted = issues.filter(
      (issue) =>
        !contributedIds.has(`${issue.repoFullName}#${issue.number}`) && feasibilityHintService.isSafeForHeadless(issue),
    );

    return unattempted[0];
  }

  diversifyScoutIssues(issues: RankedIssue[], limit: number): RankedIssue[] {
    if (limit <= 0 || issues.length <= limit) {
      return issues.slice(0, Math.max(0, limit));
    }

    const selected: RankedIssue[] = [];
    const selectedIds = new Set<string>();
    const seenRepos = new Set<string>();

    for (const issue of issues) {
      if (selected.length >= limit) {
        break;
      }

      if (seenRepos.has(issue.repoFullName)) {
        continue;
      }

      selected.push(issue);
      selectedIds.add(`${issue.repoFullName}#${issue.number}`);
      seenRepos.add(issue.repoFullName);
    }

    for (const issue of issues) {
      if (selected.length >= limit) {
        break;
      }

      const id = `${issue.repoFullName}#${issue.number}`;
      if (!selectedIds.has(id)) {
        selected.push(issue);
      }
    }

    return selected;
  }

  private async applyScoutFeasibilityHints(issues: RankedIssue[]): Promise<RankedIssue[]> {
    if (issues.length === 0) {
      return [];
    }

    const environment = await this.ensureEnvironment();
    const hintedIssues = await Promise.all(
      issues.map(async (issue, index) => {
        if (index >= MAX_ISSUES_FOR_FEASIBILITY_HINTS) {
          return issue;
        }

        const probe = await this.loadRepositoryProbe(issue.repoFullName);
        return {
          ...issue,
          scoutFeasibility: feasibilityHintService.assess(issue, probe, environment),
        };
      }),
    );

    return hintedIssues.sort(
      (left, right) =>
        this.getAdjustedOverallScore(right) - this.getAdjustedOverallScore(left) ||
        right.opportunity.overallScore - left.opportunity.overallScore ||
        right.matchScore - left.matchScore ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private async loadRepositoryProbe(repoFullName: string): Promise<RepositoryProbe | null> {
    if (this.repoProbeCache.has(repoFullName)) {
      return this.repoProbeCache.get(repoFullName) ?? null;
    }

    try {
      const probe = await githubService.fetchRepositoryProbe(repoFullName);
      this.repoProbeCache.set(repoFullName, probe);
      return probe;
    } catch (error) {
      logger.debug(`Unable to build repository feasibility probe for ${repoFullName}`, error);
      this.repoProbeCache.set(repoFullName, null);
      return null;
    }
  }

  getAdjustedOverallScore(issue: RankedIssue | undefined): number {
    return issue?.scoutFeasibility?.adjustedOverallScore ?? issue?.opportunity.overallScore ?? 0;
  }

  private scoreIssueForProfile(issue: GitHubIssue, userProfile: AppConfig['userProfile']): number {
    const profileTerms = this.getProfileTerms(userProfile);
    const title = this.normalizeSearchText(issue.title);
    const body = this.normalizeSearchText(issue.body);
    const repoDescription = this.normalizeSearchText(issue.repoDescription);
    const repoName = this.normalizeSearchText(`${issue.repoFullName} ${issue.repoName}`);
    const labels = this.normalizeSearchText(issue.labels.join(' '));
    let score = 0;

    for (const term of profileTerms) {
      if (title.includes(term)) {
        score += 18;
      }
      if (labels.includes(term)) {
        score += 12;
      }
      if (repoDescription.includes(term)) {
        score += 8;
      }
      if (repoName.includes(term)) {
        score += 5;
      }
      if (body.includes(term)) {
        score += 4;
      }
    }

    if (labels.includes('good first issue')) {
      score += 14;
    }
    if (labels.includes('help wanted')) {
      score += 9;
    }
    if (this.hasActionableBodySignals(issue)) {
      score += 10;
    }
    if (issue.body.trim().length >= 120) {
      score += 6;
    }
    if (/\b(blocked|needs info|needs information|duplicate|invalid|question|wontfix)\b/.test(labels)) {
      score -= 28;
    }

    score += this.computeDiscoveryFreshnessBoost(issue.updatedAt);
    score += Math.min(12, Math.log10(issue.repoStars + 10) * 5);

    // Quality penalties
    if (issue.body.trim().length < 50) {
      score -= 10;
    }
    if (this.hasOnlyTitleBody(issue)) {
      score -= 6;
    }

    // Penalize stale issues — a >1yr old issue is almost certainly unmaintained
    const ageDays = (Date.now() - new Date(issue.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > 365) {
      score -= 35;
    } else if (ageDays > 180) {
      score -= 25;
    } else if (ageDays > 90) {
      score -= 12;
    }

    // Bonus for well-structured bug reports
    if (/\b(expected behavior|actual behavior|steps to reproduce|reproduction steps)\b/i.test(issue.body)) {
      score += 8;
    }

    // Bonus for issues with code snippets (concrete context)
    if (/```[\s\S]*?```/.test(issue.body)) {
      score += 5;
    }

    return score;
  }

  private getProfileTerms(userProfile: AppConfig['userProfile']): string[] {
    const terms = new Set<string>();

    for (const item of [...userProfile.techStack, ...userProfile.focusAreas]) {
      const normalized = this.normalizeSearchText(item);
      if (normalized) {
        terms.add(normalized);
      }

      for (const alias of PROFILE_TERM_ALIASES[normalized] ?? []) {
        const normalizedAlias = this.normalizeSearchText(alias);
        if (normalizedAlias) {
          terms.add(normalizedAlias);
        }
      }
    }

    for (const focusArea of userProfile.focusAreas) {
      for (const term of FOCUS_AREA_TERMS[focusArea] ?? []) {
        const normalized = this.normalizeSearchText(term);
        if (normalized) {
          terms.add(normalized);
        }
      }
    }

    return [...terms].filter((term) => term.length >= 2);
  }

  private normalizeSearchText(value: string): string {
    return value
      .toLowerCase()
      .replace(/\+\+/g, ' plus plus')
      .replace(/[#.]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private hasActionableBodySignals(issue: GitHubIssue): boolean {
    const content = `${issue.title}\n${issue.body}`;
    return (
      /(?:^|[\s`'"])(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|md|css|scss)/m.test(content) ||
      /\b(repro|steps? to reproduce|expected|actual|acceptance criteria|stack trace)\b/i.test(content)
    );
  }

  private hasOnlyTitleBody(issue: GitHubIssue): boolean {
    const cleaned = issue.body
      .trim()
      .replace(/^#{1,6}\s+.+$/gm, '')
      .trim();
    return cleaned.length < 30;
  }

  private computeDiscoveryFreshnessBoost(updatedAt: string): number {
    const ageHours = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60);

    if (ageHours <= 24) return 12;
    if (ageHours <= 72) return 10;
    if (ageHours <= 7 * 24) return 7;
    if (ageHours <= 14 * 24) return 4;
    return 0;
  }

  private inferLocalTechRequirements(issue: GitHubIssue, userProfile: AppConfig['userProfile']): string[] {
    const searchable = this.normalizeSearchText(
      [issue.repoFullName, issue.repoDescription, issue.title, issue.body, issue.labels.join(' ')].join(' '),
    );
    const inferred = new Set<string>();

    for (const item of userProfile.techStack) {
      const normalized = this.normalizeSearchText(item);
      const aliases = [
        normalized,
        ...(PROFILE_TERM_ALIASES[normalized] ?? []).map((alias) => this.normalizeSearchText(alias)),
      ];
      if (aliases.some((alias) => alias && searchable.includes(alias))) {
        inferred.add(item);
      }
    }

    if (/\btsx?|typescript\b/.test(searchable)) inferred.add('TypeScript');
    if (/\bjsx?|javascript\b/.test(searchable)) inferred.add('JavaScript');
    if (/\breact|hooks?|component\b/.test(searchable)) inferred.add('React');
    if (/\bnode|npm|bun\b/.test(searchable)) inferred.add('Node.js');
    if (/\bcss|scss|accessibility|a11y|browser\b/.test(searchable)) inferred.add('Web');
    if (/\bpython|pytest|django|fastapi\b/.test(searchable)) inferred.add('Python');
    if (/\bgo|golang\b/.test(searchable)) inferred.add('Go');
    if (/\brust|cargo\b/.test(searchable)) inferred.add('Rust');

    return [...inferred].slice(0, 6);
  }

  private estimateLocalWorkload(issue: GitHubIssue): string {
    const bodyLength = issue.body.trim().length;
    const searchable = `${issue.title}\n${issue.body}`;

    if (/\b(rewrite|migration|architecture|breaking change|refactor all|entire)\b/i.test(searchable)) {
      return 'multi-session';
    }

    if (this.hasActionableBodySignals(issue) || bodyLength >= 500) {
      return '1-3 hours';
    }

    if (bodyLength >= 120) {
      return 'under 2 hours';
    }

    return 'needs triage';
  }

  private clampScore(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
}

export const issueRankingService = new IssueRankingService();

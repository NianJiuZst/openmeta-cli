import type {
	AppConfig,
	GitHubIssue,
	MatchedIssue,
	RankedIssue,
} from "../types/index.js";
import { logger } from "../infra/index.js";
import { githubService } from "./github.js";
import { llmService } from "./llm.js";
import { opportunityService } from "./opportunity.js";

const ISSUE_SCORING_BATCH_SIZE = 20;
const MAX_ISSUES_FOR_LLM_SCORING = 80;

const PROFILE_TERM_ALIASES: Record<string, string[]> = {
	typescript: ["ts", "tsx"],
	javascript: ["js", "jsx"],
	"node js": ["node", "nodejs", "npm"],
	react: ["jsx", "tsx", "component", "hooks"],
	vue: ["vuejs", "component"],
	python: ["py", "pytest"],
	django: ["python", "orm"],
	fastapi: ["python", "api"],
	go: ["golang"],
	rust: ["cargo"],
	docker: ["container", "compose"],
	"c plus plus": ["cpp"],
};

const FOCUS_AREA_TERMS: Record<string, string[]> = {
	"web-dev": [
		"web",
		"frontend",
		"browser",
		"react",
		"vue",
		"css",
		"accessibility",
	],
	backend: ["backend", "api", "server", "database", "auth"],
	devops: ["ci", "deploy", "docker", "kubernetes", "workflow"],
	"ai-ml": ["ai", "ml", "model", "prompt", "embedding", "inference"],
	mobile: ["mobile", "ios", "android", "swift", "kotlin", "react native"],
	security: ["security", "auth", "permission", "vulnerability", "encryption"],
	data: ["data", "sql", "pipeline", "analytics", "warehouse"],
	"open-source": [
		"docs",
		"contributor",
		"cli",
		"good first issue",
		"help wanted",
	],
};

export class IssueRankingService {
	async loadRankedIssues(
		config: AppConfig,
		options: { refresh?: boolean; localOnly?: boolean } = {},
	): Promise<RankedIssue[]> {
		const issues = await githubService.fetchTrendingIssues({
			refresh: options.refresh,
		});
		const rankedCandidates = this.rankIssuesForProfile(
			issues,
			config.userProfile,
		);
		if (options.localOnly) {
			return opportunityService.rankIssues(
				this.buildLocalIssueMatches(rankedCandidates, config.userProfile),
			);
		}

		const matched = await this.scoreIssuesInBatches(
			config.userProfile,
			rankedCandidates,
		);
		return opportunityService.rankIssues(matched);
	}

	buildLocalIssueMatches(
		issues: GitHubIssue[],
		userProfile: AppConfig["userProfile"],
	): MatchedIssue[] {
		return issues.slice(0, MAX_ISSUES_FOR_LLM_SCORING).map((issue) => {
			const matchScore = this.clampScore(
				this.scoreIssueForProfile(issue, userProfile),
			);
			const techRequirements = this.inferLocalTechRequirements(
				issue,
				userProfile,
			);

			return {
				...issue,
				matchScore,
				analysis: {
					coreDemand: issue.title,
					techRequirements,
					solutionSuggestion:
						'Local scout mode can shortlist this issue, then run "openmeta agent" when the LLM provider is healthy to draft a concrete patch plan.',
					estimatedWorkload: this.estimateLocalWorkload(issue),
				},
			};
		});
	}

	async scoreIssuesInBatches(
		userProfile: AppConfig["userProfile"],
		issues: GitHubIssue[],
	): Promise<MatchedIssue[]> {
		const matches: MatchedIssue[] = [];
		const issuesToScore = issues.slice(0, MAX_ISSUES_FOR_LLM_SCORING);

		for (
			let start = 0;
			start < issuesToScore.length;
			start += ISSUE_SCORING_BATCH_SIZE
		) {
			const batch = issuesToScore.slice(
				start,
				start + ISSUE_SCORING_BATCH_SIZE,
			);
			const scoredBatch = await llmService.scoreIssues(userProfile, batch);
			if (scoredBatch.status !== "success") {
				logger.warn(
					"Issue scoring returned advisory results that require review. Continuing with the parsed matches only.",
				);
			}
			matches.push(...scoredBatch.data);
		}

		return matches;
	}

	rankIssuesForProfile(
		issues: GitHubIssue[],
		userProfile: AppConfig["userProfile"],
	): GitHubIssue[] {
		return [...issues].sort((left, right) => {
			const scoreDelta =
				this.scoreIssueForProfile(right, userProfile) -
				this.scoreIssueForProfile(left, userProfile);
			if (scoreDelta !== 0) {
				return scoreDelta;
			}

			return (
				new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
			);
		});
	}

	selectIssueForAutomation(
		issues: RankedIssue[],
		minOverallScore: number,
	): RankedIssue | undefined {
		return issues.find(
			(issue) => issue.opportunity.overallScore >= minOverallScore,
		);
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

	private scoreIssueForProfile(
		issue: GitHubIssue,
		userProfile: AppConfig["userProfile"],
	): number {
		const profileTerms = this.getProfileTerms(userProfile);
		const title = this.normalizeSearchText(issue.title);
		const body = this.normalizeSearchText(issue.body);
		const repoDescription = this.normalizeSearchText(issue.repoDescription);
		const repoName = this.normalizeSearchText(
			`${issue.repoFullName} ${issue.repoName}`,
		);
		const labels = this.normalizeSearchText(issue.labels.join(" "));
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

		if (labels.includes("good first issue")) {
			score += 14;
		}
		if (labels.includes("help wanted")) {
			score += 9;
		}
		if (this.hasActionableBodySignals(issue)) {
			score += 10;
		}
		if (issue.body.trim().length >= 120) {
			score += 6;
		}
		if (
			/\b(blocked|needs info|needs information|duplicate|invalid|question|wontfix)\b/.test(
				labels,
			)
		) {
			score -= 28;
		}

		score += this.computeDiscoveryFreshnessBoost(issue.updatedAt);
		score += Math.min(12, Math.log10(issue.repoStars + 10) * 5);

		return score;
	}

	private getProfileTerms(userProfile: AppConfig["userProfile"]): string[] {
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
			.replace(/\+\+/g, " plus plus")
			.replace(/[#.]/g, " ")
			.replace(/[^a-z0-9]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private hasActionableBodySignals(issue: GitHubIssue): boolean {
		const content = `${issue.title}\n${issue.body}`;
		return (
			/(?:^|[\s`'"])(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|md|css|scss)/m.test(
				content,
			) ||
			/\b(repro|steps? to reproduce|expected|actual|acceptance criteria|stack trace)\b/i.test(
				content,
			)
		);
	}

	private computeDiscoveryFreshnessBoost(updatedAt: string): number {
		const ageHours =
			(Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60);

		if (ageHours <= 24) return 12;
		if (ageHours <= 72) return 10;
		if (ageHours <= 7 * 24) return 7;
		if (ageHours <= 14 * 24) return 4;
		return 0;
	}

	private inferLocalTechRequirements(
		issue: GitHubIssue,
		userProfile: AppConfig["userProfile"],
	): string[] {
		const searchable = this.normalizeSearchText(
			[
				issue.repoFullName,
				issue.repoDescription,
				issue.title,
				issue.body,
				issue.labels.join(" "),
			].join(" "),
		);
		const inferred = new Set<string>();

		for (const item of userProfile.techStack) {
			const normalized = this.normalizeSearchText(item);
			const aliases = [
				normalized,
				...(PROFILE_TERM_ALIASES[normalized] ?? []).map((alias) =>
					this.normalizeSearchText(alias),
				),
			];
			if (aliases.some((alias) => alias && searchable.includes(alias))) {
				inferred.add(item);
			}
		}

		if (/\btsx?|typescript\b/.test(searchable)) inferred.add("TypeScript");
		if (/\bjsx?|javascript\b/.test(searchable)) inferred.add("JavaScript");
		if (/\breact|hooks?|component\b/.test(searchable)) inferred.add("React");
		if (/\bnode|npm|bun\b/.test(searchable)) inferred.add("Node.js");
		if (/\bcss|scss|accessibility|a11y|browser\b/.test(searchable))
			inferred.add("Web");
		if (/\bpython|pytest|django|fastapi\b/.test(searchable))
			inferred.add("Python");
		if (/\bgo|golang\b/.test(searchable)) inferred.add("Go");
		if (/\brust|cargo\b/.test(searchable)) inferred.add("Rust");

		return [...inferred].slice(0, 6);
	}

	private estimateLocalWorkload(issue: GitHubIssue): string {
		const bodyLength = issue.body.trim().length;
		const searchable = `${issue.title}\n${issue.body}`;

		if (
			/\b(rewrite|migration|architecture|breaking change|refactor all|entire)\b/i.test(
				searchable,
			)
		) {
			return "multi-session";
		}

		if (this.hasActionableBodySignals(issue) || bodyLength >= 500) {
			return "1-3 hours";
		}

		if (bodyLength >= 120) {
			return "under 2 hours";
		}

		return "needs triage";
	}

	private clampScore(value: number): number {
		return Math.max(0, Math.min(100, Math.round(value)));
	}
}

export const issueRankingService = new IssueRankingService();

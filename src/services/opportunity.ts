import type {
	MatchedIssue,
	OpportunityAnalysis,
	RankedIssue,
} from "../types/index.js";

const ACTION_RISK_LABELS = new Set([
	"blocked",
	"duplicate",
	"invalid",
	"needs info",
	"needs information",
	"question",
	"discussion",
	"stale",
	"wontfix",
]);

const LARGE_SCOPE_PATTERNS = [
	/\brewrite\b/i,
	/\brefactor (all|entire|whole)\b/i,
	/\bmigration\b/i,
	/\barchitecture\b/i,
	/\bbreaking change\b/i,
];

function clampScore(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function computeFreshnessScore(updatedAt: string): number {
	const hours = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60);

	if (hours <= 24) return 100;
	if (hours <= 72) return 92;
	if (hours <= 7 * 24) return 82;
	if (hours <= 14 * 24) return 70;
	if (hours <= 30 * 24) return 58;
	return 42;
}

function computeOnboardingClarity(issue: MatchedIssue): number {
	const labels = issue.labels.map(normalizeLabel);
	const body = issue.body.trim();
	const searchable = `${issue.title}\n${issue.body}`;
	let score = 45;

	if (
		labels.includes("good first issue") ||
		labels.includes("good-first-issue")
	) {
		score += 25;
	}

	if (labels.includes("help wanted") || labels.includes("help-wanted")) {
		score += 15;
	}

	if (body.length >= 500) {
		score += 14;
	} else if (body.length >= 120) {
		score += 10;
	} else if (body.length < 40) {
		score -= 16;
	}

	if (issue.repoDescription) {
		score += 5;
	}

	if (hasReferencedPath(searchable)) {
		score += 10;
	}

	if (mentionsReproductionSignal(searchable)) {
		score += 8;
	}

	score -= computeRiskPenalty(issue) * 0.45;

	return clampScore(score);
}

function computeMergePotential(
	issue: MatchedIssue,
	freshnessScore: number,
	riskPenalty: number,
): number {
	const starSignal = Math.min(28, Math.log10(issue.repoStars + 10) * 18);
	const labelSignal = issue.labels.length > 0 ? 10 : 0;

	return clampScore(
		35 + starSignal + labelSignal + freshnessScore * 0.25 - riskPenalty * 0.55,
	);
}

function computeImpactScore(issue: MatchedIssue): number {
	return clampScore(20 + Math.log10(issue.repoStars + 10) * 28);
}

function summarizeOpportunity(opportunity: OpportunityAnalysis): string {
	const strongest = Object.entries(opportunity.breakdown).sort(
		(left, right) => right[1] - left[1],
	)[0];

	const weakest = Object.entries(opportunity.breakdown).sort(
		(left, right) => left[1] - right[1],
	)[0];

	if (!strongest || !weakest) {
		return "Opportunity score is based on repository fit and issue freshness.";
	}

	return `Strongest signal: ${strongest[0]} (${strongest[1]}). Main risk: ${weakest[0]} (${weakest[1]}).`;
}

function normalizeLabel(label: string): string {
	return label.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasRiskLabel(issue: MatchedIssue): boolean {
	return issue.labels
		.map(normalizeLabel)
		.some(
			(label) =>
				ACTION_RISK_LABELS.has(label) ||
				[...ACTION_RISK_LABELS].some((riskLabel) =>
					label.endsWith(` ${riskLabel}`),
				),
		);
}

function hasReferencedPath(content: string): boolean {
	return /(?:^|[\s`'"])(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|md|css|scss)/m.test(
		content,
	);
}

function mentionsReproductionSignal(content: string): boolean {
	return /\b(repro|steps? to reproduce|expected|actual|acceptance criteria|screenshot|stack trace)\b/i.test(
		content,
	);
}

function computeRiskPenalty(issue: MatchedIssue): number {
	let penalty = 0;
	const content = `${issue.title}\n${issue.body}`;

	if (hasRiskLabel(issue)) {
		penalty += 28;
	}

	if (issue.body.trim().length < 40) {
		penalty += 14;
	}

	if (LARGE_SCOPE_PATTERNS.some((pattern) => pattern.test(content))) {
		penalty += 18;
	}

	if (
		/\b(needs?\s+(design|decision|discussion)|blocked by|waiting for)\b/i.test(
			content,
		)
	) {
		penalty += 16;
	}

	return Math.min(45, penalty);
}

export class OpportunityService {
	rankIssues(issues: MatchedIssue[]): RankedIssue[] {
		return issues
			.map((issue) => {
				const freshness = computeFreshnessScore(issue.updatedAt);
				const riskPenalty = computeRiskPenalty(issue);
				const onboardingClarity = computeOnboardingClarity(issue);
				const mergePotential = computeMergePotential(
					issue,
					freshness,
					riskPenalty,
				);
				const impact = computeImpactScore(issue);
				const opportunityScore = clampScore(
					freshness * 0.25 +
						onboardingClarity * 0.25 +
						mergePotential * 0.3 +
						impact * 0.2 -
						riskPenalty * 0.35,
				);
				const overallScore = clampScore(
					issue.matchScore * 0.45 + opportunityScore * 0.55,
				);

				const opportunity: OpportunityAnalysis = {
					score: opportunityScore,
					overallScore,
					summary: "",
					breakdown: {
						technicalFit: issue.matchScore,
						freshness,
						onboardingClarity,
						mergePotential,
						impact,
					},
				};

				opportunity.summary = summarizeOpportunity(opportunity);

				return {
					...issue,
					opportunity,
				};
			})
			.sort(
				(left, right) =>
					right.opportunity.overallScore - left.opportunity.overallScore,
			);
	}
}

export const opportunityService = new OpportunityService();

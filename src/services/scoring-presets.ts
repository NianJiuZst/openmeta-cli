import type { OverallWeights, ScoringConfig, ScoringPreset, ScoringWeights } from '../types/index.js';

const BALANCED_PRESET: ScoringPreset = {
  name: 'balanced',
  label: 'Balanced',
  description: 'Default balanced scoring across all dimensions',
  weights: { freshness: 0.25, onboardingClarity: 0.25, mergePotential: 0.3, impact: 0.2, riskPenalty: 0.35 },
  overallWeights: { technicalMatch: 0.45, opportunityScore: 0.55 },
};

export const SCORING_PRESETS: ScoringPreset[] = [
  BALANCED_PRESET,
  {
    name: 'impact-first',
    label: 'Impact First',
    description: 'Prioritize high-star repos for resume/portfolio visibility',
    weights: { freshness: 0.15, onboardingClarity: 0.15, mergePotential: 0.2, impact: 0.4, riskPenalty: 0.2 },
    overallWeights: { technicalMatch: 0.4, opportunityScore: 0.6 },
  },
  {
    name: 'quick-wins',
    label: 'Quick Wins',
    description: 'Prioritize fresh issues with clear descriptions for fast turnaround',
    weights: { freshness: 0.35, onboardingClarity: 0.35, mergePotential: 0.2, impact: 0.05, riskPenalty: 0.15 },
    overallWeights: { technicalMatch: 0.55, opportunityScore: 0.45 },
  },
  {
    name: 'rising-stars',
    label: 'Rising Stars',
    description: 'Discover responsive 1k-5k star projects that are actively growing',
    weights: { freshness: 0.25, onboardingClarity: 0.3, mergePotential: 0.25, impact: 0.05, riskPenalty: 0.2 },
    overallWeights: { technicalMatch: 0.5, opportunityScore: 0.5 },
  },
  {
    name: 'learning',
    label: 'Learning',
    description: 'Prioritize small, well-documented projects for learning',
    weights: { freshness: 0.2, onboardingClarity: 0.4, mergePotential: 0.25, impact: 0.05, riskPenalty: 0.1 },
    overallWeights: { technicalMatch: 0.55, opportunityScore: 0.45 },
  },
];

export const DEFAULT_SCORING: ScoringConfig = {
  weights: { ...BALANCED_PRESET.weights },
  overallWeights: { ...BALANCED_PRESET.overallWeights },
  preset: 'balanced',
};

function normalizeDistribution(values: number[]): number[] {
  const sum = values.reduce((total, value) => total + value, 0);
  const normalized = values.map((value) => value / sum);
  const rounded = normalized.map((value) => +value.toFixed(3));
  const roundingDifference = +(1 - rounded.reduce((total, value) => total + value, 0)).toFixed(3);

  let largestIndex = 0;
  let largestValue = normalized[0] ?? 0;
  for (const [index, value] of normalized.entries()) {
    if (value > largestValue) {
      largestIndex = index;
      largestValue = value;
    }
  }

  rounded[largestIndex] = +((rounded[largestIndex] ?? 0) + roundingDifference).toFixed(3);
  return rounded;
}

function isValidDistribution(values: number[]): boolean {
  return values.every((value) => Number.isFinite(value) && value >= 0) && values.some((value) => value > 0);
}

export function getPreset(name: string): ScoringPreset | undefined {
  return SCORING_PRESETS.find((p) => p.name === name);
}

export function normalizeWeights(weights: ScoringWeights): ScoringWeights {
  const values = [weights.freshness, weights.onboardingClarity, weights.mergePotential, weights.impact];
  if (!isValidDistribution(values)) {
    return { ...DEFAULT_SCORING.weights };
  }

  const [freshness = 0, onboardingClarity = 0, mergePotential = 0, impact = 0] = normalizeDistribution(values);
  return {
    freshness,
    onboardingClarity,
    mergePotential,
    impact,
    riskPenalty: weights.riskPenalty,
  };
}

export function normalizeOverallWeights(weights: OverallWeights): OverallWeights {
  const values = [weights.technicalMatch, weights.opportunityScore];
  if (!isValidDistribution(values)) {
    return { ...DEFAULT_SCORING.overallWeights };
  }

  const [technicalMatch = 0, opportunityScore = 0] = normalizeDistribution(values);
  return {
    technicalMatch,
    opportunityScore,
  };
}

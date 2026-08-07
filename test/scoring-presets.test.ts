import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SCORING,
  getPreset,
  normalizeOverallWeights,
  normalizeWeights,
  SCORING_PRESETS,
} from '../src/services/scoring-presets.js';

describe('scoring presets', () => {
  test('exposes the balanced preset as the default configuration', () => {
    expect(getPreset('balanced')?.weights).toEqual(DEFAULT_SCORING.weights);
    expect(getPreset('missing')).toBeUndefined();
    expect(SCORING_PRESETS.map((preset) => preset.name)).toContain('quick-wins');
  });

  test('keeps rounded issue weights at an exact total of one', () => {
    const normalized = normalizeWeights({
      freshness: 1,
      onboardingClarity: 1,
      mergePotential: 1,
      impact: 0,
      riskPenalty: 0.4,
    });

    expect(normalized).toEqual({
      freshness: 0.334,
      onboardingClarity: 0.333,
      mergePotential: 0.333,
      impact: 0,
      riskPenalty: 0.4,
    });
    expect(normalized.freshness + normalized.onboardingClarity + normalized.mergePotential + normalized.impact).toBe(1);
  });

  test('normalizes overall weights and falls back for invalid distributions', () => {
    expect(normalizeOverallWeights({ technicalMatch: 1, opportunityScore: 2 })).toEqual({
      technicalMatch: 0.333,
      opportunityScore: 0.667,
    });
    expect(
      normalizeWeights({ freshness: 0, onboardingClarity: 0, mergePotential: 0, impact: 0, riskPenalty: 0 }),
    ).toEqual(DEFAULT_SCORING.weights);
    expect(normalizeOverallWeights({ technicalMatch: Number.NaN, opportunityScore: 1 })).toEqual(
      DEFAULT_SCORING.overallWeights,
    );
  });
});

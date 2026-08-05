import { InvalidArgumentError } from 'commander';

interface IntegerOptionBounds {
  min: number;
  max?: number;
  message: string;
}

function parseIntegerOption(value: string, bounds: IntegerOptionBounds): number {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new InvalidArgumentError(bounds.message);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || (bounds.max !== undefined && parsed > bounds.max)) {
    throw new InvalidArgumentError(bounds.message);
  }

  return parsed;
}

export function parseStarCount(value: string): number {
  return parseIntegerOption(value, {
    min: 0,
    message: 'Expected a non-negative integer.',
  });
}

export function parseDashboardPort(value: string): number {
  return parseIntegerOption(value, {
    min: 0,
    max: 65_535,
    message: 'Expected a port between 0 and 65535.',
  });
}

export function parseListLimit(value: string): number {
  return parseIntegerOption(value, {
    min: 1,
    message: 'Expected a positive integer.',
  });
}

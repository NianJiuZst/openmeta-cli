import { describe, expect, test } from 'bun:test';
import { parseDashboardPort, parseListLimit, parseStarCount } from '../src/commands/number-options.js';

describe('numeric command options', () => {
  test('parses non-negative repository star counts as decimal integers', () => {
    expect(parseStarCount('0')).toBe(0);
    expect(parseStarCount('125')).toBe(125);
    expect(() => parseStarCount('1.5')).toThrow('Expected a non-negative integer.');
    expect(() => parseStarCount('0x10')).toThrow('Expected a non-negative integer.');
  });

  test('bounds dashboard ports to the valid TCP range', () => {
    expect(parseDashboardPort('0')).toBe(0);
    expect(parseDashboardPort('4326')).toBe(4326);
    expect(() => parseDashboardPort('4326dev')).toThrow('Expected a port between 0 and 65535.');
    expect(() => parseDashboardPort('65536')).toThrow('Expected a port between 0 and 65535.');
  });

  test('requires list limits to be positive decimal integers', () => {
    expect(parseListLimit('25')).toBe(25);
    expect(() => parseListLimit('0')).toThrow('Expected a positive integer.');
    expect(() => parseListLimit('2items')).toThrow('Expected a positive integer.');
  });
});

import { describe, expect, test } from 'bun:test';
import { getContentWidth, padLine, stripAnsi, visibleLength, wrapLine, wrapLines } from '../src/infra/ui/layout.js';
import type { UiCapabilities } from '../src/infra/ui/types.js';

const capabilities: UiCapabilities = {
  width: 100,
  isInteractive: false,
  supportsColor: true,
  supportsUnicode: true,
  mode: 'interactive-rich',
};

describe('ui layout helpers', () => {
  test('strips ANSI styling before measuring and padding text', () => {
    const styled = '\u001B[31merror\u001B[0m';

    expect(stripAnsi(styled)).toBe('error');
    expect(visibleLength(styled)).toBe(5);
    expect(padLine(styled, 8)).toBe(`${styled}   `);
  });

  test('keeps a minimum content width while honoring terminal padding', () => {
    expect(getContentWidth(capabilities)).toBe(96);
    expect(getContentWidth({ ...capabilities, width: 32 })).toBe(40);
  });

  test('wraps words, long tokens, and multiple input lines', () => {
    expect(wrapLine('', 8)).toEqual(['']);
    expect(wrapLine('alpha beta gamma', 10)).toEqual(['alpha beta', 'gamma']);
    expect(wrapLine('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl']);
    expect(wrapLines(['alpha beta', 'gamma'], 5)).toEqual(['alpha', 'beta', 'gamma']);
  });
});

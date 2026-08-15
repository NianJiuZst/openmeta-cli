import { describe, expect, test } from 'bun:test';
import { parseGitHubIssueReference, parseGitHubRepoFullName, resolveGitHubIssueTarget } from '../src/infra/index.js';

describe('parseGitHubRepoFullName', () => {
  test('accepts owner/name shorthand', () => {
    expect(parseGitHubRepoFullName('vercel/next.js')).toBe('vercel/next.js');
  });

  test('normalizes HTTPS and SSH GitHub repository URLs', () => {
    expect(parseGitHubRepoFullName('https://github.com/vercel/next.js')).toBe('vercel/next.js');
    expect(parseGitHubRepoFullName('https://github.com/vercel/next.js.git')).toBe('vercel/next.js');
    expect(parseGitHubRepoFullName('git@github.com:vercel/next.js.git')).toBe('vercel/next.js');
  });

  test('rejects non-GitHub repository addresses', () => {
    expect(() => parseGitHubRepoFullName('https://gitlab.com/vercel/next.js')).toThrow(
      'Repository must be a GitHub repository',
    );
  });
});

describe('parseGitHubIssueReference', () => {
  test('accepts positive issue numbers', () => {
    expect(parseGitHubIssueReference('3014')).toEqual({
      issueNumber: 3014,
    });
  });

  test('normalizes GitHub issue URLs', () => {
    expect(parseGitHubIssueReference('https://github.com/Wei-Shaw/sub2api/issues/3014')).toEqual({
      repoFullName: 'Wei-Shaw/sub2api',
      issueNumber: 3014,
    });
  });

  test('rejects pull request URLs and invalid numbers', () => {
    expect(() => parseGitHubIssueReference('0')).toThrow('Issue must be a positive issue number');
    expect(() => parseGitHubIssueReference('https://github.com/Wei-Shaw/sub2api/pull/3014')).toThrow(
      'Issue must be a GitHub issue URL or positive issue number',
    );
  });
});

describe('resolveGitHubIssueTarget', () => {
  test('uses --repo when the issue is provided as a number', () => {
    expect(resolveGitHubIssueTarget('3014', 'https://github.com/Wei-Shaw/sub2api')).toEqual({
      repoFullName: 'Wei-Shaw/sub2api',
      issueNumber: 3014,
    });
  });

  test('allows issue URLs without --repo', () => {
    expect(resolveGitHubIssueTarget('https://github.com/Wei-Shaw/sub2api/issues/3014')).toEqual({
      repoFullName: 'Wei-Shaw/sub2api',
      issueNumber: 3014,
    });
  });

  test('rejects repository mismatches between --repo and --issue URL', () => {
    expect(() => resolveGitHubIssueTarget('https://github.com/Wei-Shaw/sub2api/issues/3014', 'vercel/next.js')).toThrow(
      'does not match --repo',
    );
  });

  test('matches GitHub repository names without case sensitivity', () => {
    expect(resolveGitHubIssueTarget('https://github.com/Wei-Shaw/sub2api/issues/3014', 'wei-shaw/Sub2API')).toEqual({
      repoFullName: 'Wei-Shaw/sub2api',
      issueNumber: 3014,
    });
  });

  test('requires --repo for numeric issue references', () => {
    expect(() => resolveGitHubIssueTarget('3014')).toThrow('Issue number targets require --repo');
  });
});

export function parseGitHubRepoFullName(value: string): string {
  const normalized = value.trim();
  const shorthand = normalizeRepoPath(normalized);
  if (shorthand) {
    return shorthand;
  }

  const sshMatch = normalized.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (sshMatch?.[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${stripGitSuffix(sshMatch[2])}`;
  }

  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== 'github.com') {
      throw new Error('Repository must be a GitHub repository, for example: https://github.com/vercel/next.js.');
    }

    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    const fullName = owner && repo ? normalizeRepoPath(`${owner}/${stripGitSuffix(repo)}`) : null;
    if (fullName) {
      return fullName;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('GitHub repository')) {
      throw error;
    }
  }

  throw new Error(
    'Repository must be owner/name or a GitHub repository URL, for example: vercel/next.js or https://github.com/vercel/next.js.',
  );
}

export interface GitHubIssueReference {
  repoFullName?: string;
  issueNumber: number;
}

export interface GitHubIssueTarget {
  repoFullName: string;
  issueNumber: number;
}

export function parseGitHubIssueReference(value: string): GitHubIssueReference {
  const normalized = value.trim();
  const issueNumber = parsePositiveIssueNumber(normalized);
  if (issueNumber) {
    return { issueNumber };
  }

  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== 'github.com') {
      throw new Error('Issue must be a GitHub issue URL or positive issue number.');
    }

    const [owner, repo, marker, issueNumberText] = url.pathname.split('/').filter(Boolean);
    if (owner && repo && marker === 'issues') {
      const parsedIssueNumber = parsePositiveIssueNumber(issueNumberText ?? '');
      if (parsedIssueNumber) {
        return {
          repoFullName: parseGitHubRepoFullName(`${owner}/${repo}`),
          issueNumber: parsedIssueNumber,
        };
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Issue must')) {
      throw error;
    }
  }

  throw new Error('Issue must be a GitHub issue URL or positive issue number.');
}

export function resolveGitHubIssueTarget(issue: string, repo?: string): GitHubIssueTarget {
  const issueReference = parseGitHubIssueReference(issue);
  const repoFullName = repo ? parseGitHubRepoFullName(repo) : undefined;

  if (
    issueReference.repoFullName &&
    repoFullName &&
    issueReference.repoFullName.toLowerCase() !== repoFullName.toLowerCase()
  ) {
    throw new Error(`Issue URL repository ${issueReference.repoFullName} does not match --repo ${repoFullName}.`);
  }

  const resolvedRepo = issueReference.repoFullName ?? repoFullName;
  if (!resolvedRepo) {
    throw new Error('Issue number targets require --repo, for example: openmeta agent --repo owner/name --issue 123.');
  }

  return {
    repoFullName: resolvedRepo,
    issueNumber: issueReference.issueNumber,
  };
}

function normalizeRepoPath(value: string): string | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    return null;
  }

  const [owner, repo] = value.split('/');
  if (!owner || !repo) {
    return null;
  }

  return `${owner}/${stripGitSuffix(repo)}`;
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
}

function parsePositiveIssueNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Issue must be a positive issue number.');
  }

  return parsed;
}

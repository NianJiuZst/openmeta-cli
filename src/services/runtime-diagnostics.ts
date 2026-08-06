import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export interface BinaryResolution {
  onPath: boolean;
  command: string;
  version?: string;
  invokedPath?: string;
  resolvedPath?: string;
  symlinkTarget?: string;
  source: 'bun-link' | 'npm-global' | 'workspace' | 'system' | 'unknown' | 'missing';
  error?: string;
}

function isPathWithin(candidate: string, root: string): boolean {
  if (!candidate || !root) {
    return false;
  }

  const relativePath = relative(root, candidate);
  return (
    relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

export function classifyBinarySource(
  invokedPath?: string,
  resolvedPath?: string,
  symlinkTarget?: string,
): BinaryResolution['source'] {
  if (!invokedPath && !resolvedPath && !symlinkTarget) {
    return 'missing';
  }

  const normalizedInvokedPath = invokedPath ? normalize(invokedPath) : '';
  const normalizedResolvedPath = resolvedPath ? normalize(resolvedPath) : '';
  const normalizedSymlinkTarget = symlinkTarget ? normalize(resolve(symlinkTarget)) : '';
  const workspaceRoot = normalize(resolve(process.cwd()));
  const homeDir = process.env['HOME'] ? normalize(resolve(process.env['HOME'])) : '';

  if (homeDir && isPathWithin(normalizedInvokedPath, normalize(join(homeDir, '.bun', 'bin')))) {
    return 'bun-link';
  }

  if (
    homeDir &&
    isPathWithin(normalizedSymlinkTarget, normalize(join(homeDir, '.bun', 'install', 'global', 'node_modules')))
  ) {
    return 'bun-link';
  }

  if (isPathWithin(normalizedResolvedPath, workspaceRoot)) {
    return 'workspace';
  }

  if (
    homeDir &&
    isPathWithin(normalizedResolvedPath, normalize(join(homeDir, '.bun', 'install', 'global', 'node_modules')))
  ) {
    return 'bun-link';
  }

  if (/[/\\](?:lib|node_modules)[/\\].+[/\\]bin[/\\][^/\\]+(?:\.[cm]?js)?$/.test(normalizedResolvedPath)) {
    return 'npm-global';
  }

  if (
    isPathWithin(normalizedResolvedPath, normalize('/usr')) ||
    isPathWithin(normalizedResolvedPath, normalize('/opt'))
  ) {
    return 'system';
  }

  return 'unknown';
}

function resolveVersion(stdout: string, stderr: string): string | undefined {
  return (stdout || stderr)
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function resolveLinkedTarget(linkPath: string): string | undefined {
  try {
    const target = readlinkSync(linkPath);
    return isAbsolute(target) ? target : resolve(dirname(linkPath), target);
  } catch {
    return undefined;
  }
}

export function inspectBinaryOnPath(command: string): BinaryResolution {
  const lookup = spawnSync('command', ['-v', command], {
    encoding: 'utf-8',
    shell: true,
  });

  if (lookup.error || lookup.status !== 0) {
    return {
      onPath: false,
      command,
      source: 'missing',
      error:
        lookup.error?.message ||
        (lookup.stderr || lookup.stdout || '').trim() ||
        `${command} is not available on PATH.`,
    };
  }

  const invokedPath = lookup.stdout.trim().split(/\r?\n/).find(Boolean);
  const versionResult = spawnSync(command, ['--version'], { encoding: 'utf-8' });

  let symlinkTarget: string | undefined;
  let resolvedPath = invokedPath;

  if (invokedPath && existsSync(invokedPath)) {
    try {
      const stat = lstatSync(invokedPath);
      if (stat.isSymbolicLink()) {
        symlinkTarget = resolveLinkedTarget(invokedPath);
      }
      resolvedPath = realpathSync(invokedPath);
    } catch {
      resolvedPath = invokedPath;
    }
  }

  return {
    onPath: !versionResult.error && versionResult.status === 0,
    command,
    version: resolveVersion(versionResult.stdout, versionResult.stderr),
    invokedPath,
    resolvedPath,
    symlinkTarget,
    source: classifyBinarySource(invokedPath, resolvedPath, symlinkTarget),
    ...(versionResult.error
      ? { error: versionResult.error.message }
      : versionResult.status === 0
        ? {}
        : { error: (versionResult.stderr || versionResult.stdout || '').trim() || `${command} --version failed.` }),
  };
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import packageJson from '../package.json';
import { getSupportedSkillHosts, installSkillBundle, renderSkillBundle } from '../src/orchestration/skill/index.js';

let tempRoot = '';

function getBunCommand(): string {
  if (process.release?.name === 'bun') {
    return process.execPath;
  }

  if (process.platform === 'win32') {
    const resolved = execFileSync('where', ['bun'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith('.exe'));

    if (resolved) {
      return resolved;
    }
  }

  return 'bun';
}

function getNpmCommand(): string {
  if (process.platform === 'win32') {
    return 'npm.cmd';
  }

  return 'npm';
}

describe('skill bundle rendering', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'openmeta-skill-bundle-'));
  });

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  test('renders claude-code, codex, and openclaw bundles from one canonical spec', async () => {
    expect(getSupportedSkillHosts()).toEqual(['claude-code', 'codex', 'openclaw']);

    const claude = await renderSkillBundle('claude-code', tempRoot);
    const codex = await renderSkillBundle('codex', tempRoot);
    const openclaw = await renderSkillBundle('openclaw', tempRoot);

    const claudeSkill = readFileSync(claude.files[0]!, 'utf-8');
    const codexSkill = readFileSync(codex.files[0]!, 'utf-8');
    const openclawSkill = readFileSync(openclaw.files[0]!, 'utf-8');

    expect(claude.files[0]).toBe(join(tempRoot, 'claude-code', 'SKILL.md'));
    expect(claudeSkill).toStartWith('---\nname: openmeta\n');
    expect(claudeSkill).toContain('Install target: `~/.claude/skills/openmeta`');
    expect(claudeSkill).toContain('Keep the generated file at `SKILL.md`');
    expect(claudeSkill).toContain('## What OpenMeta Can Do');
    expect(claudeSkill).toContain('Discover and rank worthwhile issues');
    expect(claudeSkill).toContain('## Config Keys For `machine config set`');
    expect(claudeSkill).toContain('`executionOutcome`');
    expect(claudeSkill).toContain('"errorCodes"');
    expect(claudeSkill).toContain('openmeta machine agent');

    expect(codex.files[0]).toBe(join(tempRoot, 'codex', 'SKILL.md'));
    expect(codexSkill).toStartWith('---\nname: openmeta\n');
    expect(codexSkill).toContain('Install target: `~/.agents/skills/openmeta`');
    expect(codexSkill).toContain('personal skill directory');
    expect(codexSkill).toContain('## What OpenMeta Can Do');
    expect(codexSkill).toContain('Codex default personal install path: `~/.agents/skills/openmeta`');
    expect(codexSkill).toContain('openmeta machine doctor');

    expect(openclaw.files[0]).toBe(join(tempRoot, 'openclaw', 'skill.md'));
    expect(openclawSkill).toContain('Install target: `~/.openclaw/skills/openmeta`');
    expect(openclawSkill).toContain('## Recovery Playbook');
    expect(openclawSkill).toContain('`reviewRequired`');
    expect(openclawSkill).toContain('"openmeta machine pow"');
    expect(openclawSkill).toContain('openmeta machine doctor');
  });

  test(
    'export works from the packed CLI with runtime-resolved skill assets',
    () => {
      const packedRoot = mkdtempSync(join(tmpdir(), 'openmeta-pack-runtime-'));
      const exportRoot = join(packedRoot, 'exported');
      execFileSync(getBunCommand(), ['run', 'build'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'inherit'],
        encoding: 'utf-8',
      });
      const packed = JSON.parse(
        execFileSync(getNpmCommand(), ['pack', '--json', '--pack-destination', packedRoot], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'inherit'],
          encoding: 'utf-8',
          // Windows package managers are .cmd shims, which cannot be launched
          // directly by execFileSync under Bun.
          shell: process.platform === 'win32',
        }),
      ) as Array<{ filename: string }>;
      execFileSync('tar', ['-xzf', join(packedRoot, packed[0]!.filename), '-C', packedRoot]);
      execFileSync(
        getBunCommand(),
        [
          join(packedRoot, 'package', 'bin', 'openmeta.js'),
          'skill',
          'export',
          '--host',
          'claude-code',
          '--output',
          exportRoot,
        ],
        {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'inherit'],
          encoding: 'utf-8',
        },
      );

      expect(existsSync(join(exportRoot, 'claude-code', 'SKILL.md'))).toBe(true);
      const exportedSkill = readFileSync(join(exportRoot, 'claude-code', 'SKILL.md'), 'utf-8');
      expect(exportedSkill).toStartWith('---\nname: openmeta\n');
      expect(exportedSkill).toContain('Install target: `~/.claude/skills/openmeta`');
      expect(exportedSkill).toContain('## What OpenMeta Can Do');
      expect(exportedSkill).toContain('## Result Interpretation');
      expect(exportedSkill).toContain('"inspectFields"');
      expect(exportedSkill).toContain('openmeta machine doctor');
    },
    { timeout: 20_000 },
  );

  test('installs claude-code bundle at the Claude Code skill discovery entrypoint', async () => {
    const homeRoot = join(tempRoot, 'home');

    const result = await installSkillBundle('claude-code', { homeDir: homeRoot });
    const skillPath = join(homeRoot, '.claude', 'skills', 'openmeta', 'SKILL.md');
    const legacyNestedPath = join(homeRoot, '.claude', 'skills', 'openmeta', 'claude-code', 'skill.md');

    expect(result.installed).toBe(true);
    expect(result.installPath).toBe(join(homeRoot, '.claude', 'skills', 'openmeta'));
    expect(result.exportedFiles).toEqual([skillPath]);
    expect(existsSync(skillPath)).toBe(true);
    expect(existsSync(legacyNestedPath)).toBe(false);

    const installedSkill = readFileSync(skillPath, 'utf-8');
    expect(installedSkill).toStartWith('---\nname: openmeta\n');
    expect(installedSkill).toContain('description: Use when');
    expect(installedSkill).toContain('## What OpenMeta Can Do');
    expect(installedSkill).toContain('openmeta machine doctor');
  });

  test('installs codex bundle at the Codex personal skill discovery entrypoint', async () => {
    const homeRoot = join(tempRoot, 'home');

    const result = await installSkillBundle('codex', { homeDir: homeRoot });
    const skillPath = join(homeRoot, '.agents', 'skills', 'openmeta', 'SKILL.md');

    expect(result.installed).toBe(true);
    expect(result.installPath).toBe(join(homeRoot, '.agents', 'skills', 'openmeta'));
    expect(result.exportedFiles).toEqual([skillPath]);
    expect(existsSync(skillPath)).toBe(true);

    const installedSkill = readFileSync(skillPath, 'utf-8');
    expect(installedSkill).toStartWith('---\nname: openmeta\n');
    expect(installedSkill).toContain('description: Use when');
    expect(installedSkill).toContain('Host: Codex');
    expect(installedSkill).toContain('openmeta machine doctor');
  });
});

describe('package files', () => {
  test('publishes skill assets with the CLI binary', () => {
    expect(packageJson.files).toContain('bin/openmeta.js');
    expect(packageJson.files).toContain('dashboard');
    expect(packageJson.files).toContain('skills');
  });
});

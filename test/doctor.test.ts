import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DoctorOrchestrator } from '../src/orchestration/doctor.js';
import type { AppConfig } from '../src/types/index.js';

let tempRoot = '';

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    userProfile: {
      techStack: ['TypeScript'],
      proficiency: 'intermediate',
      focusAreas: ['open-source'],
    },
    github: {
      pat: 'ghp_test_token',
      username: 'octocat',
      targetRepoPath: '',
    },
    llm: {
      provider: 'openai',
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
      modelName: 'gpt-4o-mini',
    },
    automation: {
      enabled: false,
      scheduleTime: '09:00',
      timezone: 'UTC',
      contentType: 'research_note',
      scheduler: 'manual',
      minMatchScore: 70,
      skipIfAlreadyGeneratedToday: true,
    },
    commitTemplate: 'feat(daily): {{title}}\n\n{{content}}',
  };

  return {
    ...base,
    ...overrides,
    userProfile: {
      ...base.userProfile,
      ...overrides.userProfile,
    },
    github: {
      ...base.github,
      ...overrides.github,
    },
    llm: {
      ...base.llm,
      ...overrides.llm,
    },
    automation: {
      ...base.automation,
      ...overrides.automation,
    },
  };
}

function prepareOpenMetaDirs(): void {
  mkdirSync(join(tempRoot, '.config', 'openmeta'), { recursive: true });
  mkdirSync(join(tempRoot, '.openmeta', 'workspaces'), { recursive: true });
  mkdirSync(join(tempRoot, '.openmeta', 'artifacts'), { recursive: true });
}

describe('DoctorOrchestrator', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'openmeta-doctor-'));
    process.env['OPENMETA_CONFIG_DIR'] = join(tempRoot, '.config', 'openmeta');
    process.env['OPENMETA_HOME'] = join(tempRoot, '.openmeta');
  });

  afterEach(() => {
    delete process.env['OPENMETA_CONFIG_DIR'];
    delete process.env['OPENMETA_HOME'];

    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  test('reports a ready local surface when required config and directories are present', async () => {
    prepareOpenMetaDirs();

    const report = await new DoctorOrchestrator().inspect(createConfig());

    expect(report.ready).toBe(true);
    expect(report.totals.fail).toBe(0);
    expect(report.checks.find((check) => check.id === 'github-config')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'llm-config')?.status).toBe('pass');
  });

  test('marks missing credentials as critical failures', async () => {
    const report = await new DoctorOrchestrator().inspect(createConfig({
      github: {
        pat: '',
        username: '',
        targetRepoPath: '',
      },
      llm: {
        provider: 'openai',
        apiBaseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        modelName: 'gpt-4o-mini',
      },
    }));

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.id === 'github-config')?.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'llm-config')?.status).toBe('fail');
  });

  test('fails when a configured artifact repository path does not exist', async () => {
    const report = await new DoctorOrchestrator().inspect(createConfig({
      github: {
        pat: 'ghp_test_token',
        username: 'octocat',
        targetRepoPath: join(tempRoot, 'missing-repo'),
      },
    }));

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.id === 'target-repo')?.status).toBe('fail');
  });
});

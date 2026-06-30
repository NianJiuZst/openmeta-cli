import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import type { RepositoryContributionRules as StructuredRepositoryContributionRules } from '../contracts/index.js';
import { RepositoryContributionRulesSchema } from '../contracts/index.js';
import { ensureDirectory, getOpenMetaStateDir, logger } from '../infra/index.js';
import type { RepositoryRuleFile, RepositoryRulesSnapshot } from '../types/index.js';
import { llmService } from './llm.js';

const RULE_CANDIDATE_PATHS = [
  'CONTRIBUTING.md',
  'contributing.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/config.yaml',
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/feature_request.md',
  '.github/ISSUE_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE.md',
  '.github/DISCUSSION_TEMPLATE.md',
  '.github/SECURITY.md',
  '.github/SUPPORT.md',
  'RELEASE.md',
  'RELEASING.md',
  'CHANGELOG.md',
  'docs/release-notes.md',
  'docs/release-note-policy.md',
  'docs/pull_request_template.md',
  'docs/pr-template.md',
  'docs/discussion-policy.md',
  'docs/CONTRIBUTING_GUIDE.md',
  'docs/CONTRIBUTING.md',
  'docs/contributing.md',
];

function sanitizeRepoName(repoFullName: string): string {
  return repoFullName.replace(/\//g, '__');
}

function defaultRules(detectedFiles: string[] = []): StructuredRepositoryContributionRules {
  return {
    detectedFiles,
    summary: detectedFiles.length > 0 ? [`Detected ${detectedFiles.length} contribution rule files.`] : [],
    requiredChecklistItems: [],
    requiredValidationNotes: [],
    requiresPriorDiscussion: false,
    missingRequirements: [],
    blockingRequirements: [],
    requiredReleaseNotes: false,
    requiredDiscussionEvidence: false,
  };
}

export class RepositoryRulesService {
  private getCacheDir(): string {
    return ensureDirectory(join(getOpenMetaStateDir(), 'cache', 'repository-rules'));
  }

  private getCachePath(repoFullName: string): string {
    return join(this.getCacheDir(), `${sanitizeRepoName(repoFullName)}.json`);
  }

  async loadFromWorkspace(repoFullName: string, workspacePath: string): Promise<StructuredRepositoryContributionRules> {
    const files = this.readRuleFiles(workspacePath);
    if (files.length === 0) {
      return defaultRules();
    }

    const cached = this.loadCachedRules(repoFullName, files, workspacePath);
    if (cached) {
      return cached.rules;
    }

    try {
      const extracted = await llmService.extractRepositoryRules(repoFullName, files);
      const parsed = RepositoryContributionRulesSchema.parse(extracted);
      const normalized = {
        ...defaultRules(files.map((file) => file.path)),
        ...parsed,
        detectedFiles: parsed.detectedFiles.length > 0 ? parsed.detectedFiles : files.map((file) => file.path),
      };
      this.saveCachedRules(repoFullName, workspacePath, files, normalized);
      return normalized;
    } catch (error) {
      logger.debug(`Repository rules extraction failed for ${repoFullName}`, error);
      const fallback = defaultRules(files.map((file) => file.path));
      fallback.summary.push('Rule extraction fell back to file discovery only.');
      this.saveCachedRules(repoFullName, workspacePath, files, fallback);
      return fallback;
    }
  }

  private readRuleFiles(workspacePath: string): RepositoryRuleFile[] {
    const root = resolve(workspacePath);
    const discovered = new Map<string, RepositoryRuleFile>();

    for (const candidate of RULE_CANDIDATE_PATHS) {
      const target = join(root, candidate);
      if (!existsSync(target)) {
        continue;
      }
      discovered.set(candidate, {
        path: candidate,
        content: readFileSync(target, 'utf-8').slice(0, 32_000),
      });
    }

    const templateDir = join(root, '.github', 'PULL_REQUEST_TEMPLATE');
    if (existsSync(templateDir)) {
      for (const entry of readdirSync(templateDir)) {
        const fullPath = join(templateDir, entry);
        if (!statSync(fullPath).isFile()) {
          continue;
        }
        const relPath = relative(root, fullPath).replace(/\\/g, '/');
        discovered.set(relPath, {
          path: relPath,
          content: readFileSync(fullPath, 'utf-8').slice(0, 32_000),
        });
      }
    }

    const issueTemplateDir = join(root, '.github', 'ISSUE_TEMPLATE');
    if (existsSync(issueTemplateDir)) {
      for (const entry of readdirSync(issueTemplateDir)) {
        const fullPath = join(issueTemplateDir, entry);
        if (!statSync(fullPath).isFile()) {
          continue;
        }
        const relPath = relative(root, fullPath).replace(/\\/g, '/');
        discovered.set(relPath, {
          path: relPath,
          content: readFileSync(fullPath, 'utf-8').slice(0, 32_000),
        });
      }
    }

    return [...discovered.values()];
  }

  private loadCachedRules(
    repoFullName: string,
    files: RepositoryRuleFile[],
    workspacePath: string,
  ): RepositoryRulesSnapshot | null {
    const cachePath = this.getCachePath(repoFullName);
    if (!existsSync(cachePath)) {
      return null;
    }

    try {
      const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as RepositoryRulesSnapshot;
      const currentEntries = this.buildFileEntries(files, workspacePath);
      const matches =
        raw.detectedFiles.length === currentEntries.length &&
        raw.detectedFiles.every((entry, index) => {
          const current = currentEntries[index];
          return (
            current && current.path === entry.path && current.mtimeMs === entry.mtimeMs && current.size === entry.size
          );
        });
      return matches ? raw : null;
    } catch (error) {
      logger.debug('Unable to read repository rules cache', error);
      return null;
    }
  }

  private saveCachedRules(
    repoFullName: string,
    workspacePath: string,
    files: RepositoryRuleFile[],
    rules: StructuredRepositoryContributionRules,
  ): void {
    const payload: RepositoryRulesSnapshot = {
      repoFullName,
      cacheKey: files.map((file) => file.path).join('|'),
      cachedAt: new Date().toISOString(),
      detectedFiles: this.buildFileEntries(files, workspacePath),
      rules,
    };

    try {
      writeFileSync(this.getCachePath(repoFullName), JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error) {
      logger.debug('Unable to save repository rules cache', error);
    }
  }

  private buildFileEntries(files: RepositoryRuleFile[], workspacePath: string) {
    const root = resolve(workspacePath);
    return files.map((file) => {
      const stat = statSync(join(root, file.path));
      return {
        path: file.path,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    });
  }
}

export const repositoryRulesService = new RepositoryRulesService();

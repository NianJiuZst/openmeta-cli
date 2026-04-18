import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { configService } from './config.js';

export function getOpenMetaHomePath(): string {
  return process.env['OPENMETA_HOME'] || join(homedir(), '.openmeta');
}

export function getOpenMetaWorkspaceRoot(): string {
  return join(getOpenMetaHomePath(), 'workspaces');
}

export function getOpenMetaArtifactRoot(): string {
  return join(getOpenMetaHomePath(), 'artifacts');
}

export function getOpenMetaStateDir(): string {
  return dirname(configService.getConfigPath());
}

export function ensureDirectory(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }

  return path;
}

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileAtomically } from '../src/infra/atomic-file.js';

let tempRoot = '';

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

describe('writeFileAtomically', () => {
  test('replaces an existing file without leaving a partial temporary file', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'openmeta-atomic-file-'));
    const targetPath = join(tempRoot, 'state.json');
    writeFileSync(targetPath, '{"version":1}', 'utf-8');

    writeFileAtomically(targetPath, '{"version":2}');

    expect(readFileSync(targetPath, 'utf-8')).toBe('{"version":2}');
    expect(readdirSync(tempRoot)).toEqual(['state.json']);
    if (process.platform !== 'win32') {
      expect(statSync(targetPath).mode & 0o777).toBe(0o600);
    }
  });
});

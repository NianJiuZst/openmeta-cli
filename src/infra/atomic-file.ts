import { randomUUID } from 'crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'fs';

interface AtomicWriteOptions {
  mode?: number;
}

export function writeFileAtomically(path: string, content: string, options: AtomicWriteOptions = {}): void {
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryPath, 'wx', options.mode ?? 0o600);
    writeFileSync(descriptor, content, 'utf-8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* ignore cleanup failure */
      }
    }

    try {
      unlinkSync(temporaryPath);
    } catch {
      /* ignore cleanup failure */
    }

    throw error;
  }
}

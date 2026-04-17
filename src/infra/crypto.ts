import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import CryptoJS from 'crypto-js';

const CONFIG_DIR = process.env.OPENMETA_CONFIG_DIR || join(homedir(), '.config', 'openmeta');
const KEY_FILE = join(CONFIG_DIR, 'secret.key');
const ENCRYPTION_PREFIX = 'enc:v2';
const LEGACY_ENCRYPTION_KEY = 'openmeta-cli-encryption-key-v1';
const KEY_SIZE = 32;
const IV_SIZE = 12;

export class CryptoService {
  static encrypt(plainText: string): string {
    if (!plainText) {
      return plainText;
    }

    if (this.isEncrypted(plainText)) {
      return plainText;
    }

    const key = this.getKey({ createIfMissing: true });
    const iv = randomBytes(IV_SIZE);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      ENCRYPTION_PREFIX,
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');
  }

  static decrypt(cipherText: string): string {
    if (!cipherText) {
      return cipherText;
    }

    if (this.isModernEncrypted(cipherText)) {
      const parts = cipherText.split(':');
      if (parts.length !== 5) {
        throw new Error('Encrypted value has an invalid format');
      }

      const [, , ivBase64, authTagBase64, encryptedBase64] = parts;
      if (!ivBase64 || !authTagBase64 || !encryptedBase64) {
        throw new Error('Encrypted value is missing required data');
      }

      const key = this.getKey({ createIfMissing: false });
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivBase64, 'base64'));
      decipher.setAuthTag(Buffer.from(authTagBase64, 'base64'));

      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedBase64, 'base64')),
        decipher.final(),
      ]).toString('utf8');

      if (!decrypted) {
        throw new Error('Encrypted value could not be decrypted');
      }

      return decrypted;
    }

    const bytes = CryptoJS.AES.decrypt(cipherText, LEGACY_ENCRYPTION_KEY);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    if (!decrypted) {
      throw new Error('Encrypted value could not be decrypted');
    }
    return decrypted;
  }

  static isEncrypted(value: string): boolean {
    return this.isModernEncrypted(value) || value.startsWith('U2FsdGVkX1');
  }

  private static isModernEncrypted(value: string): boolean {
    return value.startsWith(`${ENCRYPTION_PREFIX}:`);
  }

  private static getKey({ createIfMissing }: { createIfMissing: boolean }): Buffer {
    if (existsSync(KEY_FILE)) {
      const encodedKey = readFileSync(KEY_FILE, 'utf8').trim();
      const key = Buffer.from(encodedKey, 'base64');

      if (key.length !== KEY_SIZE) {
        throw new Error(`OpenMeta encryption key is invalid: ${KEY_FILE}`);
      }

      return key;
    }

    if (!createIfMissing) {
      throw new Error(`OpenMeta encryption key is missing: ${KEY_FILE}`);
    }

    mkdirSync(CONFIG_DIR, { recursive: true });

    const key = randomBytes(KEY_SIZE);
    writeFileSync(KEY_FILE, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });

    try {
      chmodSync(KEY_FILE, 0o600);
    } catch {
      // Ignore chmod failures on filesystems that do not support POSIX permissions.
    }

    return key;
  }
}

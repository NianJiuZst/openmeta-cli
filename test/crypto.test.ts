import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempRoot = '';

async function loadCryptoService() {
	const module = await import(`../src/infra/crypto.js?case=${Date.now()}-${Math.random()}`);
	return module.CryptoService as typeof import('../src/infra/crypto.js').CryptoService;
}

function getKeyPath(): string {
	return join(process.env['OPENMETA_CONFIG_DIR']!, 'secret.key');
}

describe('CryptoService', () => {
	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), 'openmeta-crypto-'));
		process.env['OPENMETA_CONFIG_DIR'] = join(tempRoot, '.config', 'openmeta');
	});

	afterEach(() => {
		delete process.env['OPENMETA_CONFIG_DIR'];

		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
			tempRoot = '';
		}
	});

	test('encrypts and decrypts modern values without double-encrypting', async () => {
		const CryptoService = await loadCryptoService();
		const cipherText = CryptoService.encrypt('sk-test-key');
		const keyPath = getKeyPath();

		expect(cipherText.startsWith('enc:v2:')).toBe(true);
		expect(CryptoService.isEncrypted(cipherText)).toBe(true);
		expect(CryptoService.encrypt(cipherText)).toBe(cipherText);
		expect(CryptoService.decrypt(cipherText)).toBe('sk-test-key');
		expect(existsSync(keyPath)).toBe(true);
	});

	test('rejects malformed modern encrypted payloads', async () => {
		const CryptoService = await loadCryptoService();

		expect(() => CryptoService.decrypt('enc:v2:only:three')).toThrow('invalid format');
		expect(() => CryptoService.decrypt('enc:v2::auth:cipher')).toThrow('missing required data');
	});

	test('fails clearly when a modern encrypted value cannot find a valid key', async () => {
		mkdirSync(process.env['OPENMETA_CONFIG_DIR']!, { recursive: true });

		{
			const CryptoService = await loadCryptoService();
			expect(() =>
				CryptoService.decrypt('enc:v2:ZmFrZWl2MTIzNDU2:ZmFrZXRhZw==:ZmFrZWNpcGhlcg=='),
			).toThrow('missing');
		}

		writeFileSync(getKeyPath(), Buffer.from('too-short').toString('base64'), 'utf-8');

		{
			const CryptoService = await loadCryptoService();
			expect(() => CryptoService.encrypt('another-secret')).toThrow('invalid');
		}
	});
});

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as encryptionService from '../encryption.service';

describe('encryption.service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('exported functions', () => {
    const exportedKeys = Object.keys(encryptionService);

    it('exposes at least one function', () => {
      expect(exportedKeys.length).toBeGreaterThan(0);
    });

    it.each(exportedKeys)('exports %s as a function', (key) => {
      const value = (encryptionService as Record<string, unknown>)[key];
      expect(typeof value).toBe('function');
    });
  });

  describe('encrypt/decrypt round trip', () => {
    const service = encryptionService as Record<string, unknown>;

    const encryptFn = (service.encrypt ?? service.encryptData ?? service.encryptString) as
      | ((value: string) => string | Promise<string>)
      | undefined;
    const decryptFn = (service.decrypt ?? service.decryptData ?? service.decryptString) as
      | ((value: string) => string | Promise<string>)
      | undefined;

    const maybeIt = encryptFn && decryptFn ? it : it.skip;

    maybeIt('returns the original plaintext after encrypting and decrypting', async () => {
      const plaintext = 'sensitive-payload-123';
      const encrypted = await encryptFn!(plaintext);
      expect(encrypted).not.toBe(plaintext);
      const decrypted = await decryptFn!(encrypted as string);
      expect(decrypted).toBe(plaintext);
    });

    maybeIt('produces different ciphertext for the same plaintext (random IV)', async () => {
      const plaintext = 'repeatable-value';
      const first = await encryptFn!(plaintext);
      const second = await encryptFn!(plaintext);
      expect(first).not.toBe(second);
    });

    maybeIt('throws when decrypting tampered ciphertext', async () => {
      const encrypted = (await encryptFn!('tamper-me')) as string;
      const tampered = encrypted.slice(0, -2) + (encrypted.endsWith('00') ? '11' : '00');
      await expect(Promise.resolve(decryptFn!(tampered))).rejects.toThrow();
    });

    maybeIt('throws when decrypting malformed input', async () => {
      await expect(Promise.resolve(decryptFn!('not-a-valid-ciphertext'))).rejects.toThrow();
    });
  });
});

import { describe, expect, it } from 'vitest';
import { encrypt, decrypt } from '../src/crypto.js';

describe('crypto', () => {
  const secret = 'test-encryption-secret-key-32ch';

  it('encrypts and decrypts a value round-trip', () => {
    const plaintext = 'my-exa-api-key-abc123';
    const encrypted = encrypt(plaintext, secret);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(':')).toHaveLength(3);
    expect(decrypt(encrypted, secret)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const plaintext = 'same-key-value';
    const a = encrypt(plaintext, secret);
    const b = encrypt(plaintext, secret);
    expect(a).not.toBe(b);
    expect(decrypt(a, secret)).toBe(plaintext);
    expect(decrypt(b, secret)).toBe(plaintext);
  });

  it('fails to decrypt with wrong secret', () => {
    const encrypted = encrypt('test-value', secret);
    expect(() => decrypt(encrypted, 'wrong-secret-key-1234567890ab')).toThrow();
  });

  it('fails to decrypt malformed input', () => {
    expect(() => decrypt('not-valid', secret)).toThrow();
  });

  it('handles unicode and special characters', () => {
    const plaintext = 'key-with-ünïcödé-特殊字符-🔑';
    const encrypted = encrypt(plaintext, secret);
    expect(decrypt(encrypted, secret)).toBe(plaintext);
  });
});

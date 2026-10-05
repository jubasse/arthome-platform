import { argon2id, hash } from 'argon2';
import { describe, expect, it } from 'vitest';

import { hashPassword, isOutdated, verifyPassword } from './password-hashing.js';

describe('password hashing', () => {
  it('is argon2id at OWASP’s floor, salted, and verifies only the password it hashed', async () => {
    const digest = await hashPassword('a-long-password');
    expect(digest).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(await hashPassword('a-long-password')).not.toBe(digest);
    expect(await verifyPassword({ hash: digest, password: 'a-long-password' })).toBe(true);
    expect(await verifyPassword({ hash: digest, password: 'a-long-passwore' })).toBe(false);
  });

  it('reads one password however its accents were typed', async () => {
    const composed = 'a-long-password-caf\u00e9';
    const decomposed = 'a-long-password-cafe\u0301';
    const digest = await hashPassword(composed);
    expect(await verifyPassword({ hash: digest, password: decomposed })).toBe(true);
  });

  it('calls outdated a digest made with other parameters than today’s', async () => {
    const weaker = await hash('a-long-password', {
      type: argon2id,
      memoryCost: 19_456,
      timeCost: 1,
      parallelism: 1,
    });
    expect(isOutdated(weaker)).toBe(true);
    expect(isOutdated(await hashPassword('a-long-password'))).toBe(false);
  });
});

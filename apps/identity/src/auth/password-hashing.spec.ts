import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password-hashing.js';

describe('password hashing', () => {
  it('is argon2id at OWASP’s floor, salted, and verifies only the password it hashed', async () => {
    const digest = await hashPassword('a-long-password');
    expect(digest).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(await hashPassword('a-long-password')).not.toBe(digest);
    expect(await verifyPassword({ hash: digest, password: 'a-long-password' })).toBe(true);
    expect(await verifyPassword({ hash: digest, password: 'a-long-passwore' })).toBe(false);
  });
});

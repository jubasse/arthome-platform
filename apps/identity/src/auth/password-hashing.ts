import { argon2id, hash, verify } from 'argon2';

/** `nestjs-auth` rule 8: argon2id at OWASP's floor, the salt generated and embedded in the digest. */
const ARGON2ID = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2ID);
}

export function verifyPassword({
  hash: digest,
  password,
}: {
  readonly hash: string;
  readonly password: string;
}): Promise<boolean> {
  return verify(digest, password);
}

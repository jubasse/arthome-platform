import { argon2id, hash, needsRehash, verify } from 'argon2';

/** `nestjs-auth` rule 8: argon2id at OWASP's floor, the salt generated and embedded in the digest. */
const ARGON2ID = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** NFKC (NIST SP 800-63B §5.1.1.2): an accented password typed on two keyboards is one password. */
function normalised(password: string): string {
  return password.normalize('NFKC');
}

export function hashPassword(password: string): Promise<string> {
  return hash(normalised(password), ARGON2ID);
}

export function verifyPassword({
  hash: digest,
  password,
}: {
  readonly hash: string;
  readonly password: string;
}): Promise<boolean> {
  return verify(digest, normalised(password));
}

/** A digest made with other parameters than today's, which the next sign-in hashes again. */
export function isOutdated(digest: string): boolean {
  return needsRehash(digest, ARGON2ID);
}

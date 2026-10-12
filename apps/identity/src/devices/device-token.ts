import { createHash, randomBytes } from 'node:crypto';

/** 256 bits, as the verification link's: guessed by nobody, and its digest is all identity keeps. */
const DEVICE_TOKEN_BYTES = 32;

export function newDeviceToken(): string {
  return randomBytes(DEVICE_TOKEN_BYTES).toString('base64url');
}

export function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

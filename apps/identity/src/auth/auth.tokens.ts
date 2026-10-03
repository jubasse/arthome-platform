/** better-auth's instance (`createAuth`). */
export const BETTER_AUTH: unique symbol = Symbol('BetterAuth');

/** Its own pool, apart from TypeORM's: two clients on one database (`adr-auth.md` R2). */
export const AUTH_POOL: unique symbol = Symbol('AuthPool');

/** Keys the fingerprint of an idempotent body that carries a password. */
export const FINGERPRINT_KEY: unique symbol = Symbol('FingerprintKey');

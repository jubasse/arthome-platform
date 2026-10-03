import { z } from 'zod';

import { DEVELOPMENT_TOKEN_PRIVATE_JWK, isDevelopmentTokenKey } from './development-token-key.js';

export type NodeEnv = 'development' | 'test' | 'production';

export interface HttpServiceEnv {
  readonly NODE_ENV: NodeEnv;
  readonly PORT: number;
  readonly DATABASE_URL: string;
}

export interface ConsumerEnv {
  readonly NODE_ENV: NodeEnv;
  readonly DATABASE_URL: string;
  readonly KAFKA_BROKERS: readonly string[];
}

export interface SearchIndexerEnv extends ConsumerEnv {
  readonly OPENSEARCH_URL: string;
}

/** A BFF owns no database: it reads the services behind it. */
export interface BffEnv {
  readonly NODE_ENV: NodeEnv;
  readonly PORT: number;
  readonly CATALOG_URL: string;
}

/**
 * Parsed once, at startup, and throwing: a configuration fault is a deployment
 * that should not have started. Reading `process.env` later defeats this.
 */
const nodeEnv = z.enum(['development', 'test', 'production']);

/**
 * `z.url()` alone reads `localhost:29092` as the scheme `localhost:` with the
 * path `29092`, passing a broker list, a bare hostname and a typo alike.
 */
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const httpUrl = z.url({ protocol: /^https?$/ });
const redisUrl = z.url({ protocol: /^rediss?$/ });

/**
 * It was passed to KafkaJS as `[process.env.KAFKA_BROKERS]`, so `a:9092,b:9092`
 * arrived as one broker whose host contained a comma, resolvable by nothing.
 */
const brokerList = z
  .string()
  .transform((value) => value.split(',').map((broker) => broker.trim()))
  .pipe(z.array(z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/, 'expected host:port')).min(1));

/**
 * Defaulted, unlike every other variable here: the migration CLI loads
 * `data-source.ts` and never listens, so requiring PORT made `migration:run`
 * unrunnable. A wrong port fails loudly, where a wrong DATABASE_URL does not.
 *
 * `min(1)` refuses `PORT=0`, which `.int()` accepts: `Number('')` is 0.
 */
const port = z.coerce.number().int().min(1).max(65535).default(3000);

/**
 * `compose.yaml` owns these ports and they are deliberately unconventional, so
 * the stack runs beside another project instead of fighting it for 5432.
 *
 * Applied outside production only: as unconditional `?? 'localhost…'`, a
 * deployment with no DATABASE_URL started and reported a database as down.
 *
 * NODE_ENV itself is never defaulted: defaulting it to `development` would let
 * an unset variable open the production-guarded write routes.
 */
const DEVELOPMENT_KAFKA_BROKERS = 'localhost:29092';
const DEVELOPMENT_OPENSEARCH_URL = 'http://localhost:19200';
const DEVELOPMENT_REDIS_URL = 'redis://localhost:56379';
/** `apps/catalog/.env.example`'s port. */
const DEVELOPMENT_CATALOG_URL = 'http://localhost:3002';
/** `apps/identity/.env.example`'s port. */
const DEVELOPMENT_IDENTITY_URL = 'http://localhost:3001';

function developmentDefaults(databaseName: string): {
  DATABASE_URL: string;
  KAFKA_BROKERS: string;
  OPENSEARCH_URL: string;
} {
  return {
    DATABASE_URL: `postgres://arthome:arthome@localhost:55432/${databaseName}`,
    KAFKA_BROKERS: DEVELOPMENT_KAFKA_BROKERS,
    OPENSEARCH_URL: DEVELOPMENT_OPENSEARCH_URL,
  };
}

function withDevelopmentDefaults(
  source: Record<string, string | undefined>,
  databaseName: string,
): Record<string, string | undefined> {
  if (readNodeEnv(source) === 'production') return source;
  return { ...developmentDefaults(databaseName), ...stripEmpty(source) };
}

/**
 * An object, not a bare value: `nodeEnv.parse(source.NODE_ENV)` throws with an
 * empty path, so the operator is never told which variable was wrong.
 */
function readNodeEnv(source: Record<string, string | undefined>): NodeEnv {
  return z.object({ NODE_ENV: nodeEnv }).parse(source).NODE_ENV;
}

/**
 * An empty variable is an absent one here: a compose file declaring
 * `DATABASE_URL:` with no value would otherwise shadow the default.
 */
function stripEmpty(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
}

export function readHttpServiceEnv(
  databaseName: string,
  source: Record<string, string | undefined> = process.env,
): HttpServiceEnv {
  return z
    .object({ NODE_ENV: nodeEnv, PORT: port, DATABASE_URL: postgresUrl })
    .parse(withDevelopmentDefaults(source, databaseName));
}

export function readConsumerEnv(
  databaseName: string,
  source: Record<string, string | undefined> = process.env,
): ConsumerEnv {
  return z
    .object({ NODE_ENV: nodeEnv, DATABASE_URL: postgresUrl, KAFKA_BROKERS: brokerList })
    .parse(withDevelopmentDefaults(source, databaseName));
}

export function readSearchIndexerEnv(
  databaseName: string,
  source: Record<string, string | undefined> = process.env,
): SearchIndexerEnv {
  return z
    .object({
      NODE_ENV: nodeEnv,
      DATABASE_URL: postgresUrl,
      KAFKA_BROKERS: brokerList,
      OPENSEARCH_URL: httpUrl,
    })
    .parse(withDevelopmentDefaults(source, databaseName));
}

/**
 * An allow-list, not `=== 'production'`: a `staging` added later is
 * production-like until someone says otherwise.
 */
export function isProductionEnvironment(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const value = readNodeEnv(source);
  return value !== 'development' && value !== 'test';
}

/**
 * For a tool that reads topics on behalf of a service that never talks to Kafka itself — the
 * publishers, whose events Debezium carries. Same rules as every other read: validated, and
 * defaulted only outside production.
 */
export function readKafkaBrokers(
  source: Record<string, string | undefined> = process.env,
): readonly string[] {
  const withDefault =
    readNodeEnv(source) === 'production'
      ? source
      : { KAFKA_BROKERS: DEVELOPMENT_KAFKA_BROKERS, ...stripEmpty(source) };
  return z.object({ KAFKA_BROKERS: brokerList }).parse(withDefault).KAFKA_BROKERS;
}

/** For a reader of the search index, where `readSearchIndexerEnv` serves its writer. */
export function readOpenSearchUrl(
  source: Record<string, string | undefined> = process.env,
): string {
  const withDefault =
    readNodeEnv(source) === 'production'
      ? source
      : { OPENSEARCH_URL: DEVELOPMENT_OPENSEARCH_URL, ...stripEmpty(source) };
  return z.object({ OPENSEARCH_URL: httpUrl }).parse(withDefault).OPENSEARCH_URL;
}

export function readRedisUrl(source: Record<string, string | undefined> = process.env): string {
  const withDefault =
    readNodeEnv(source) === 'production'
      ? source
      : { REDIS_URL: DEVELOPMENT_REDIS_URL, ...stripEmpty(source) };
  return z.object({ REDIS_URL: redisUrl }).parse(withDefault).REDIS_URL;
}

export function readBffEnv(source: Record<string, string | undefined> = process.env): BffEnv {
  const withDefault =
    readNodeEnv(source) === 'production'
      ? source
      : { CATALOG_URL: DEVELOPMENT_CATALOG_URL, ...stripEmpty(source) };
  return z.object({ NODE_ENV: nodeEnv, PORT: port, CATALOG_URL: httpUrl }).parse(withDefault);
}

/** Where a BFF reaches identity, for the authentication relay and the session's validation. */
export function readIdentityUrl(source: Record<string, string | undefined> = process.env): string {
  const withDefault =
    readNodeEnv(source) === 'production'
      ? source
      : { IDENTITY_URL: DEVELOPMENT_IDENTITY_URL, ...stripEmpty(source) };
  return z.object({ IDENTITY_URL: httpUrl }).parse(withDefault).IDENTITY_URL;
}

/** The storefront's own port in development, where Next.js listens by default. */
const DEVELOPMENT_PUBLIC_WEB_ORIGIN = 'http://localhost:3000';

/**
 * The origin a served canonical URL starts with (data-model.md §2.7). Required in production,
 * where a localhost link would be shared, bookmarked and printed into a QR code.
 */
export function readPublicWebOrigin(
  source: Record<string, string | undefined> = process.env,
): string {
  const withDefault =
    readNodeEnv(source) === 'production'
      ? source
      : { PUBLIC_WEB_ORIGIN: DEVELOPMENT_PUBLIC_WEB_ORIGIN, ...stripEmpty(source) };
  return new URL(z.object({ PUBLIC_WEB_ORIGIN: httpUrl }).parse(withDefault).PUBLIC_WEB_ORIGIN)
    .origin;
}

/**
 * Development's, so the fake payment adapter signs and verifies on a fresh clone. Production has
 *   none: a known secret there would let anyone forge a paid order.
 */
const DEVELOPMENT_PAYMENT_WEBHOOK_SECRET = 'development-payment-webhook-secret';

/** The secret a payment provider signs its webhooks with (adr-payments.md §7.1). */
export function readPaymentWebhookSecret(
  source: Record<string, string | undefined> = process.env,
): string {
  const withDefault =
    readNodeEnv(source) === 'production'
      ? source
      : { PAYMENT_WEBHOOK_SECRET: DEVELOPMENT_PAYMENT_WEBHOOK_SECRET, ...stripEmpty(source) };
  return z
    .object({ PAYMENT_WEBHOOK_SECRET: secretOutside(DEVELOPMENT_PAYMENT_WEBHOOK_SECRET, source) })
    .parse(withDefault).PAYMENT_WEBHOOK_SECRET;
}

/** A P-256 private key as a JWK, with the `kid` the JWKS document publishes its public half under. */
export interface SigningKey {
  readonly keyId: string;
  readonly privateJwk: Readonly<Record<string, string>>;
}

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);

const privateEcJwk = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: base64Url,
  y: base64Url,
  d: base64Url,
  kid: z.string().min(1),
});

/**
 * The key a BFF signs internal tokens with (`adr-auth.md` §8): `INTERNAL_TOKEN_SIGNING_KEY`, a JSON
 * JWK. Outside production the published development key; in production that key is refused by its
 * coordinates, whatever `kid` it carries, so a copied `.env` or a relabelled key cannot sign.
 */
export function readInternalTokenSigningKey(
  source: Record<string, string | undefined> = process.env,
): SigningKey {
  const production = readNodeEnv(source) === 'production';
  const raw = stripEmpty(source).INTERNAL_TOKEN_SIGNING_KEY;
  const jwk = privateEcJwk.parse(
    raw === undefined && !production
      ? DEVELOPMENT_TOKEN_PRIVATE_JWK
      : parseJson(raw, 'INTERNAL_TOKEN_SIGNING_KEY'),
  );
  if (production && isDevelopmentTokenKey(jwk)) {
    throw new Error('INTERNAL_TOKEN_SIGNING_KEY: the development key cannot sign in production');
  }
  return { keyId: jwk.kid, privateJwk: jwk };
}

/** Where a service reads the public keys of the internal token's issuers. */
export type JwksSource =
  | { readonly kind: 'remote'; readonly url: string }
  | { readonly kind: 'local'; readonly keys: readonly Readonly<Record<string, string>>[] };

/**
 * `JWKS_URL`: the static document the CDN serves (`adr-auth.md` §8.1), `https` in production. Outside
 * production and unset, the development key's public half, so no document has to be served locally.
 */
export function readJwksSource(
  source: Record<string, string | undefined> = process.env,
): JwksSource {
  const production = readNodeEnv(source) === 'production';
  const url = stripEmpty(source).JWKS_URL;
  if (url === undefined && !production) {
    const { kty, crv, x, y, kid } = DEVELOPMENT_TOKEN_PRIVATE_JWK;
    return { kind: 'local', keys: [{ kty, crv, x, y, kid }] };
  }
  const jwksUrl = production ? z.url({ protocol: /^https$/ }) : httpUrl;
  return { kind: 'remote', url: z.object({ JWKS_URL: jwksUrl }).parse({ JWKS_URL: url }).JWKS_URL };
}

/** 32 characters at least, and in production never the development value this file publishes. */
function secretOutside(
  development: string,
  source: Record<string, string | undefined>,
): z.ZodType<string> {
  const production = readNodeEnv(source) === 'production';
  return z
    .string()
    .min(32)
    .refine((secret) => !production || secret !== development, {
      message: 'the development value cannot be used in production',
    });
}

const DEVELOPMENT_BETTER_AUTH_SECRET = 'development-better-auth-secret-not-for-production';

/** better-auth's secret, which signs the session tokens identity hands out. */
export function readBetterAuthSecret(
  source: Record<string, string | undefined> = process.env,
): string {
  const withDefault =
    readNodeEnv(source) === 'production'
      ? source
      : { BETTER_AUTH_SECRET: DEVELOPMENT_BETTER_AUTH_SECRET, ...stripEmpty(source) };
  return z
    .object({ BETTER_AUTH_SECRET: secretOutside(DEVELOPMENT_BETTER_AUTH_SECRET, source) })
    .parse(withDefault).BETTER_AUTH_SECRET;
}

const DEVELOPMENT_CSRF_SECRET = 'development-csrf-secret-not-for-production';

/** The key a BFF binds a cookie session's CSRF token to that session with. */
export function readCsrfSecret(source: Record<string, string | undefined> = process.env): string {
  const withDefault =
    readNodeEnv(source) === 'production'
      ? source
      : { CSRF_SECRET: DEVELOPMENT_CSRF_SECRET, ...stripEmpty(source) };
  return z
    .object({ CSRF_SECRET: secretOutside(DEVELOPMENT_CSRF_SECRET, source) })
    .parse(withDefault).CSRF_SECRET;
}

/**
 * `TRUSTED_PROXIES`: the addresses or subnets whose `X-Forwarded-For` a BFF believes, comma
 * separated. Unset, none: every client then shares the proxy's address, which is wrong behind one
 * but never forgeable (`nestjs-web-security` rule 7).
 */
export function readTrustedProxies(
  source: Record<string, string | undefined> = process.env,
): readonly string[] {
  const raw = stripEmpty(source).TRUSTED_PROXIES;
  if (raw === undefined) return [];
  return z
    .array(z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]))
    .min(1)
    .parse(raw.split(',').map((entry) => entry.trim()));
}

const headerName = z
  .string()
  .regex(/^[A-Za-z0-9-]+$/)
  .transform((name) => name.toLowerCase());

/**
 * `VIEWER_COUNTRY_HEADER`: the header the infrastructure gateway writes the visitor's country into,
 * from its geolocation, and the only one trusted. Required in production, where a BFF reading no
 * header would record every visitor's country as unknown in silence; outside production, unset
 * means no header is read and every country is unknown.
 */
export function readViewerCountryHeader(
  source: Record<string, string | undefined> = process.env,
): string | null {
  const raw = stripEmpty(source).VIEWER_COUNTRY_HEADER;
  if (raw === undefined && readNodeEnv(source) !== 'production') return null;
  return z.object({ VIEWER_COUNTRY_HEADER: headerName }).parse({ VIEWER_COUNTRY_HEADER: raw })
    .VIEWER_COUNTRY_HEADER;
}

function parseJson(raw: string | undefined, name: string): unknown {
  if (raw === undefined) throw new Error(`${name} is required`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not JSON`);
  }
}

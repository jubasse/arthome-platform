import { z } from 'zod';

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

/**
 * ⚠ IT PARSES ONCE, AT STARTUP, AND THROWS. A configuration fault is not a runtime
 *   condition to degrade around — it is a deployment that should not have started.
 *   Reading `process.env` again later, anywhere, defeats this.
 */
const nodeEnv = z.enum(['development', 'test', 'production']);

/**
 * ⚠ `z.url()` ALONE ACCEPTS NONSENSE HERE. The URL constructor reads
 *   `localhost:29092` as the scheme `localhost:` with the path `29092`, so a plain
 *   `z.url()` passes a broker list, a bare hostname and a typo alike. The protocol is
 *   the assertion that makes the type mean something.
 */
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const httpUrl = z.url({ protocol: /^https?$/ });

/**
 * ⚠ A BROKER LIST IS NOT A URL, AND IT IS NOT ONE BROKER. It was being passed to
 *   KafkaJS as `[process.env.KAFKA_BROKERS]`, so a production value of
 *   `a:9092,b:9092` arrived as a single broker whose host contained a comma —
 *   resolvable by nothing, and a connection failure that names the wrong cause.
 */
const brokerList = z
  .string()
  .transform((value) => value.split(',').map((broker) => broker.trim()))
  .pipe(z.array(z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/, 'expected host:port')).min(1));

/**
 * ⚠ DEFAULTED, UNLIKE EVERY OTHER VARIABLE HERE, AND THE ASYMMETRY IS THE POINT. The
 *   migration CLI loads `data-source.ts` and never listens, so requiring PORT made
 *   the documented `migration:run` unrunnable. A wrong port also fails loudly — the
 *   bind fails, or nothing answers — where a wrong DATABASE_URL connects somewhere
 *   else in silence. `nestjs-config` rule 1 defaults it for the same reason.
 *
 * ⚠ `min(1)` REFUSES `PORT=0`, which `.int()` accepts: `Number('')` is 0.
 */
const port = z.coerce.number().int().min(1).max(65535).default(3000);

/**
 * The local defaults, applied only outside production.
 *
 * ⚠ `compose.yaml` OWNS THESE PORTS AND THEY ARE DELIBERATELY NOT THE CONVENTIONAL
 *   ONES — 55432, 29092, 19200, so the stack runs beside another project instead of
 *   fighting it for 5432. Changing one here without changing it there gives every
 *   service a default that connects to nothing.
 *
 * ⚠ IN PRODUCTION A MISSING VARIABLE MUST BE A FAILED STARTUP, NOT A QUIET
 *   LOCALHOST. Every one of these was an unconditional `?? 'localhost…'` in a
 *   service's source, so a deployment with no DATABASE_URL started, connected to
 *   nothing, and reported it as a database that was down.
 *
 * ⚠ NODE_ENV ITSELF IS NEVER DEFAULTED. Defaulting it to `development` would make an
 *   unset variable open the production-guarded write routes, which is the inverse of
 *   what isProductionEnvironment is for. A migration run against an unnamed
 *   environment now fails instead of migrating localhost.
 */
function developmentDefaults(databaseName: string): {
  DATABASE_URL: string;
  KAFKA_BROKERS: string;
  OPENSEARCH_URL: string;
} {
  return {
    DATABASE_URL: `postgres://arthome:arthome@localhost:55432/${databaseName}`,
    KAFKA_BROKERS: 'localhost:29092',
    OPENSEARCH_URL: 'http://localhost:19200',
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
 * ⚠ PARSED AS AN OBJECT, NOT AS A BARE VALUE. `nodeEnv.parse(source.NODE_ENV)` throws
 *   with an empty path, so the operator reads `Invalid option: expected one of
 *   "development"|"test"|"production"` and is never told which variable it came from.
 */
function readNodeEnv(source: Record<string, string | undefined>): NodeEnv {
  return z.object({ NODE_ENV: nodeEnv }).parse(source).NODE_ENV;
}

/**
 * ⚠ An empty variable is an absent one for the purpose of a default: a compose file
 *   that declares `DATABASE_URL:` with no value would otherwise shadow the default
 *   with the empty string and fail the URL check instead of filling in.
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
 * ⚠ An allow-list of the two non-production environments, not `=== 'production'`:
 *   a `staging` added later is then production-like until someone says otherwise, so
 *   widening the enum cannot quietly open a guarded route.
 */
export function isProductionEnvironment(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const value = readNodeEnv(source);
  return value !== 'development' && value !== 'test';
}

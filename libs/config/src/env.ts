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

function developmentDefaults(databaseName: string): {
  DATABASE_URL: string;
  KAFKA_BROKERS: string;
  OPENSEARCH_URL: string;
} {
  return {
    DATABASE_URL: `postgres://arthome:arthome@localhost:55432/${databaseName}`,
    KAFKA_BROKERS: DEVELOPMENT_KAFKA_BROKERS,
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

/**
 * Real infrastructure, in containers, for the assertions that cannot be made
 * without it.
 *
 * The images and the Postgres flags are read out of `compose.yaml`, never
 *   copied here: a harness that tests a different Postgres than the one the stack
 *   runs is a green test about a system nobody operates. An unresolvable
 *   reference throws.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Kafka, logLevel } from 'kafkajs';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';

export interface PostgresEndpoint {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly url: string;
}

export interface KafkaEndpoint {
  readonly brokers: readonly string[];
}

export interface OpenSearchEndpoint {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface StartedOpenSearch {
  readonly endpoint: OpenSearchEndpoint;
  stop(): Promise<void>;
}

export interface ConnectEndpoint {
  readonly url: string;
  readonly brokerInsideNetwork: string;
  readonly postgresHostInsideNetwork: string;
  readonly postgresPortInsideNetwork: number;
}

export interface StartedConnect {
  readonly endpoint: ConnectEndpoint;
  stop(): Promise<void>;
}

export interface StartedPostgres {
  readonly endpoint: PostgresEndpoint;
  stop(): Promise<void>;
}

export interface StartedKafka {
  readonly endpoint: KafkaEndpoint;
  stop(): Promise<void>;
}

export interface StackRequest {
  readonly postgres?: boolean;
  readonly kafka?: boolean;
  readonly opensearch?: boolean;
  /**
   * Implies `postgres` and `kafka`, all three on one Docker network: a
   *   connector reaches its database and broker from INSIDE Docker, where the
   *   host's mapped ports do not exist.
   */
  readonly connect?: boolean;
  readonly startupTimeoutMs?: number;
}

/** Each endpoint throws if its container was not requested, rather than reading back dead. */
export interface StartedStack {
  readonly postgres: PostgresEndpoint;
  readonly kafka: KafkaEndpoint;
  readonly opensearch: OpenSearchEndpoint;
  readonly connect: ConnectEndpoint;
  stop(): Promise<void>;
}

// Generous because a first run pulls the image; a short default only makes a cold
// cache flaky.
const DEFAULT_STARTUP_MS = 180_000;

const POSTGRES_SERVICE = 'postgres';
const KAFKA_SERVICE = 'kafka';
const OPENSEARCH_SERVICE = 'opensearch';
const CONNECT_SERVICE = 'connect';

/**
 * The aliases are compose's service names on purpose: a connector names its
 *   database by host and runs INSIDE Docker, so a test can post the same JSON
 *   `infra/debezium/` holds instead of a copy with the hosts rewritten.
 */
const POSTGRES_ALIAS = POSTGRES_SERVICE;
const KAFKA_ALIAS = KAFKA_SERVICE;

const CONNECT_PORT = 8083;

// Deliberately the development stack's words: a URL printed by a failing test
// should read like the one in `.env`.
const POSTGRES_USER = 'arthome';
const POSTGRES_PASSWORD = 'arthome';

/**
 * Only so `CREATE DATABASE` has somewhere to be issued from — a test gets its own
 * from `createDatabase`. Not named after a service: those names belong to
 * `SERVICES` in @arthome/core, which this package must not depend on.
 */
const MAINTENANCE_DATABASE = 'arthome';

const POSTGRES_PORT = 5432;

/**
 * Below `logical` there is nothing in the write-ahead log for Debezium to
 *   read, and the connector fails at startup with a message that does not say so
 *   (data-model.md §7.4). Asserted after startup rather than assumed.
 */
const REQUIRED_WAL_LEVEL = 'logical';

const OPENSEARCH_PORT = 9200;

/**
 * Not read out of `compose.yaml` like the image tag: these cannot drift into
 * being wrong, only absent, and absent the container does not start. The heap cap
 * is not tuning — OpenSearch sizes its default heap from host memory and refuses
 * to start on a small machine without it.
 */
const OPENSEARCH_ENVIRONMENT = {
  'discovery.type': 'single-node',
  DISABLE_SECURITY_PLUGIN: 'true',
  DISABLE_INSTALL_DEMO_CONFIG: 'true',
  OPENSEARCH_JAVA_OPTS: '-Xms512m -Xmx512m',
  'bootstrap.memory_lock': 'false',
} as const;

const KAFKA_INTERNAL_PORT = 9092;
const KAFKA_CONTROLLER_PORT = 9093;
const KAFKA_CLIENT_PORT = 29092;

const KAFKA_STARTER_SCRIPT = '/tmp/arthome-kafka-start.sh';
const KAFKA_SCRIPT_TRAILER = 'ARTHOME_SCRIPT_COMPLETE';
const KAFKA_WAITING_MARKER = 'arthome-testing: waiting for the advertised listeners';

const KAFKA_ENTRY_POINT = '/etc/kafka/docker/run';

/**
 * Resolved from THIS MODULE, not the working directory: a test runs from the
 * repository root, from `libs/testing` and from an editor's cwd. `src/` and
 * `dist/` sit at the same depth, so one path serves both.
 */
const COMPOSE_FILE = new URL('../../../compose.yaml', import.meta.url);

function composeBlock(service: string): string[] {
  let text: string;
  try {
    text = readFileSync(COMPOSE_FILE, 'utf8');
  } catch (cause) {
    throw new Error(
      `the harness cannot read ${COMPOSE_FILE.pathname}: ${String(cause)}. ` +
        'That path is resolved from this module, so the failure is that libs/testing has ' +
        'moved relative to the repository root — not that anything is down.',
      { cause },
    );
  }
  const lines = text.split('\n');
  const start = lines.indexOf(`  ${service}:`);
  if (start === -1) {
    throw new Error(`compose.yaml declares no service \`${service}\`; the harness reproduces it.`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

export function composeImage(service: string): string {
  for (const line of composeBlock(service)) {
    const tag = /^ {4}image:\s*(\S+)\s*$/.exec(line)?.[1];
    if (tag !== undefined) return tag;
  }
  throw new Error(`compose.yaml pins no image for \`${service}\`.`);
}

function composeCommand(service: string): string[] {
  const block = composeBlock(service);
  const at = block.indexOf('    command:');
  if (at === -1) throw new Error(`compose.yaml gives \`${service}\` no command:.`);

  const items: string[] = [];
  for (const line of block.slice(at + 1)) {
    const item = /^ {6}- (.*)$/.exec(line)?.[1];
    if (item === undefined) break;
    items.push(item);
  }
  if (items.length === 0) throw new Error(`compose.yaml gives \`${service}\` an empty command:.`);
  return items;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * The readiness check is two things. The entry point initialises over a UNIX
 *   socket, prints "ready to accept connections", then restarts — a test that
 *   connects in that window loses its connection mid-query. The TCP port rules
 *   the init phase out; `pg_isready` over TCP rules out a port not yet answering.
 */
export async function startPostgres(
  startupTimeoutMs: number = DEFAULT_STARTUP_MS,
  network?: StartedNetwork,
): Promise<StartedPostgres> {
  const base = new GenericContainer(composeImage(POSTGRES_SERVICE));
  const container = await (
    network === undefined ? base : base.withNetwork(network).withNetworkAliases(POSTGRES_ALIAS)
  )
    .withEnvironment({
      POSTGRES_USER,
      POSTGRES_PASSWORD,
      POSTGRES_DB: MAINTENANCE_DATABASE,
    })
    .withCommand(composeCommand(POSTGRES_SERVICE))
    .withExposedPorts(POSTGRES_PORT)
    .withWaitStrategy(
      Wait.forAll([
        Wait.forListeningPorts(),
        Wait.forSuccessfulCommand(
          `pg_isready -h 127.0.0.1 -U ${POSTGRES_USER} -d ${MAINTENANCE_DATABASE}`,
        ),
      ]),
    )
    .withStartupTimeout(startupTimeoutMs)
    .start();

  await assertWalLevel(container);

  const host = container.getHost();
  const port = container.getMappedPort(POSTGRES_PORT);

  return {
    endpoint: {
      host,
      port,
      user: POSTGRES_USER,
      password: POSTGRES_PASSWORD,
      database: MAINTENANCE_DATABASE,
      url: `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${host}:${port}/${MAINTENANCE_DATABASE}`,
    },
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}

/**
 * It waits on `/_cluster/health`, not the listening port: 9200 binds well
 *   before the cluster can serve a write. A single-node cluster reports `yellow`
 *   and never `green`, so waiting for green waits for ever.
 */
export async function startOpenSearch(
  startupTimeoutMs: number = DEFAULT_STARTUP_MS,
): Promise<StartedOpenSearch> {
  const container = await new GenericContainer(composeImage(OPENSEARCH_SERVICE))
    .withEnvironment({ ...OPENSEARCH_ENVIRONMENT })
    .withExposedPorts(OPENSEARCH_PORT)
    .withWaitStrategy(
      Wait.forHttp('/_cluster/health', OPENSEARCH_PORT).forStatusCodeMatching(
        (code) => code === 200,
      ),
    )
    .withStartupTimeout(startupTimeoutMs)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(OPENSEARCH_PORT);

  return {
    endpoint: { host, port, url: `http://${host}:${port}` },
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}

/**
 * The wait is on `GET /connectors` answering, the first moment a connector can
 *   be posted; on the listening port instead, the POST is reset.
 *
 * The three internal topics need replication factor 1. The image defaults to
 *   3, and against one broker the worker accepts a connector then fails to
 *   persist it — which reads as the connector vanishing.
 */
export async function startConnect(
  network: StartedNetwork,
  startupTimeoutMs: number = DEFAULT_STARTUP_MS,
): Promise<StartedConnect> {
  const container = await new GenericContainer(composeImage(CONNECT_SERVICE))
    .withNetwork(network)
    .withNetworkAliases(CONNECT_SERVICE)
    .withEnvironment({
      BOOTSTRAP_SERVERS: `${KAFKA_ALIAS}:${KAFKA_INTERNAL_PORT}`,
      GROUP_ID: `arthome-harness-${randomUUID().slice(0, 8)}`,
      CONFIG_STORAGE_TOPIC: '_connect_configs',
      OFFSET_STORAGE_TOPIC: '_connect_offsets',
      STATUS_STORAGE_TOPIC: '_connect_status',
      CONFIG_STORAGE_REPLICATION_FACTOR: '1',
      OFFSET_STORAGE_REPLICATION_FACTOR: '1',
      STATUS_STORAGE_REPLICATION_FACTOR: '1',
    })
    .withExposedPorts(CONNECT_PORT)
    .withWaitStrategy(
      Wait.forHttp('/connectors', CONNECT_PORT).forStatusCodeMatching((code) => code === 200),
    )
    .withStartupTimeout(startupTimeoutMs)
    .start();

  return {
    endpoint: {
      url: `http://${container.getHost()}:${container.getMappedPort(CONNECT_PORT)}`,
      brokerInsideNetwork: `${KAFKA_ALIAS}:${KAFKA_INTERNAL_PORT}`,
      postgresHostInsideNetwork: POSTGRES_ALIAS,
      postgresPortInsideNetwork: POSTGRES_PORT,
    },
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}

async function assertWalLevel(container: StartedTestContainer): Promise<void> {
  const shown = await container.exec([
    'psql',
    '-U',
    POSTGRES_USER,
    '-d',
    MAINTENANCE_DATABASE,
    '-tAc',
    'show wal_level',
  ]);
  const level = shown.output.trim();
  if (level === REQUIRED_WAL_LEVEL) return;

  await container.stop();
  throw new Error(
    `the harness started Postgres with wal_level=${level || '(unreadable)'}, not ` +
      `${REQUIRED_WAL_LEVEL}. Debezium reads the write-ahead log, and below that level there ` +
      'is nothing in it to read: the connector fails at startup with a message that does not ' +
      'say so. The setting comes from the `command:` block of compose.yaml — check that it ' +
      'is still there, and that this file still parses it.',
  );
}

/**
 * `advertised.listeners` must name the HOST port Docker mapped, unknown until
 *   the container exists: advertise the container's own port and a producer
 *   connects once, is redirected to an unpublished port, and hangs.
 *
 * The shell waits for the script's LAST LINE, not the file: `docker cp`
 *   creates it, then fills it, so testing `-f` hands half a script to `sh`.
 *
 * Reserving a host port up front is the shorter version and loses: between
 *   closing the probe socket and Docker binding it, anything can take it.
 */
export async function startKafka(
  startupTimeoutMs: number = DEFAULT_STARTUP_MS,
  network?: StartedNetwork,
): Promise<StartedKafka> {
  const container = await new GenericContainer(composeImage(KAFKA_SERVICE))
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS:
        `PLAINTEXT://0.0.0.0:${KAFKA_INTERNAL_PORT}` +
        `,CONTROLLER://0.0.0.0:${KAFKA_CONTROLLER_PORT}` +
        `,HOST://0.0.0.0:${KAFKA_CLIENT_PORT}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT,HOST:PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      // compose says `1@kafka:9093` for its own DNS name; here the single broker
      // is its own controller, so the voter is the loopback.
      KAFKA_CONTROLLER_QUORUM_VOTERS: `1@localhost:${KAFKA_CONTROLLER_PORT}`,
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      // Not a tweak: the default is three seconds of waiting for more group
      //   members, paid by every consumer this harness creates.
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      // Fresh per container: two harness brokers must not look like one cluster.
      CLUSTER_ID: Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64url'),
    })
    .withExposedPorts(KAFKA_CLIENT_PORT)
    .withNetworkMode(network?.getName() ?? 'bridge')
    .withNetworkAliases(...(network === undefined ? [] : [KAFKA_ALIAS]))
    .withCommand([
      'sh',
      '-c',
      `echo "${KAFKA_WAITING_MARKER}"; ` +
        `until grep -q ${KAFKA_SCRIPT_TRAILER} ${KAFKA_STARTER_SCRIPT} 2>/dev/null; ` +
        'do sleep 0.1; done; ' +
        `exec sh ${KAFKA_STARTER_SCRIPT}`,
    ])
    .withWaitStrategy(Wait.forLogMessage(KAFKA_WAITING_MARKER))
    .withStartupTimeout(startupTimeoutMs)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(KAFKA_CLIENT_PORT);
  const broker = `${host}:${port}`;

  await container.copyContentToContainer([
    {
      content: [
        '#!/bin/sh',
        // With a network, PLAINTEXT must advertise the alias: `localhost` inside
        //   Kafka Connect is Kafka Connect, which redirects to itself and reports
        //   the broker unreachable.
        `export KAFKA_ADVERTISED_LISTENERS='PLAINTEXT://` +
          `${network === undefined ? 'localhost' : KAFKA_ALIAS}:${KAFKA_INTERNAL_PORT}` +
          `,HOST://${broker}'`,
        `exec ${KAFKA_ENTRY_POINT}`,
        // Written last, and what the shell loop above greps for.
        `# ${KAFKA_SCRIPT_TRAILER}`,
        '',
      ].join('\n'),
      target: KAFKA_STARTER_SCRIPT,
      mode: 0o644,
    },
  ]);

  try {
    await waitForBroker(broker, startupTimeoutMs);
  } catch (cause) {
    await container.stop();
    throw cause;
  }

  return {
    endpoint: { brokers: [broker] },
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}

/**
 * "Kafka Server started" in the log is not the same claim: it is printed
 *   before the controller has elected itself, and a client connecting in between
 *   gets a metadata response with no leaders, which KafkaJS reports as a topic
 *   error.
 */
async function waitForBroker(broker: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const kafka = new Kafka({
    clientId: 'arthome-testing-probe',
    brokers: [broker],
    // KafkaJS's own retry would sit inside this loop and turn a 250 ms poll
    //   into a minute of backoff; its logger would print a warning per poll.
    logLevel: logLevel.NOTHING,
    retry: { retries: 0 },
  });

  let last: unknown;
  while (Date.now() < deadline) {
    const admin = kafka.admin();
    try {
      await admin.connect();
      await admin.listTopics();
      await admin.disconnect();
      return;
    } catch (error) {
      last = error;
      await admin.disconnect().catch(() => undefined);
      await delay(250);
    }
  }
  throw new Error(`Kafka did not answer on ${broker} within ${timeoutMs} ms: ${String(last)}`);
}

/**
 * Started in parallel to avoid paying two image pulls in sequence, and torn
 *   down together on failure: a bare `Promise.all` abandons the containers that
 *   did start, and the leak is invisible until a machine has thirty of them.
 */
export async function startStack(request: StackRequest): Promise<StartedStack> {
  const timeout = request.startupTimeoutMs ?? DEFAULT_STARTUP_MS;

  // `connect` implies its dependencies and a network, and cannot start in the
  //   same breath as them: the worker comes up pointing at aliases that must
  //   already resolve.
  const wantsConnect = request.connect === true;
  const network = wantsConnect ? await new Network().start() : undefined;
  const wantsPostgres = request.postgres === true || wantsConnect;
  const wantsKafka = request.kafka === true || wantsConnect;

  const [postgres, kafka, opensearch] = await Promise.allSettled([
    wantsPostgres ? startPostgres(timeout, network) : null,
    wantsKafka ? startKafka(timeout, network) : null,
    request.opensearch === true ? startOpenSearch(timeout) : null,
  ]);

  const dependenciesFailed = [postgres, kafka, opensearch].some((o) => o.status === 'rejected');
  const connect = await (async (): Promise<PromiseSettledResult<StartedConnect | null>> => {
    if (!wantsConnect || network === undefined || dependenciesFailed) {
      return { status: 'fulfilled', value: null };
    }
    try {
      return { status: 'fulfilled', value: await startConnect(network, timeout) };
    } catch (reason) {
      return { status: 'rejected', reason };
    }
  })();

  const outcomes = [postgres, kafka, opensearch, connect];
  const started = outcomes.flatMap((outcome) =>
    outcome.status === 'fulfilled' && outcome.value !== null ? [outcome.value] : [],
  );
  const failed: string[] = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [String(outcome.reason)] : [],
  );

  const stop = async (): Promise<void> => {
    await Promise.allSettled(started.map((container) => container.stop()));
    // Last: removing a network with a container still attached fails.
    if (network !== undefined) await network.stop();
  };

  if (failed.length > 0) {
    await stop();
    throw new Error(`the harness could not start the stack: ${failed.join('; ')}`);
  }

  const postgresEndpoint = postgres.status === 'fulfilled' ? postgres.value?.endpoint : undefined;
  const kafkaEndpoint = kafka.status === 'fulfilled' ? kafka.value?.endpoint : undefined;
  const openSearchEndpoint =
    opensearch.status === 'fulfilled' ? opensearch.value?.endpoint : undefined;
  const connectEndpoint = connect.status === 'fulfilled' ? connect.value?.endpoint : undefined;

  return {
    get postgres(): PostgresEndpoint {
      if (postgresEndpoint === undefined) {
        throw new Error('startStack was not asked for postgres: pass { postgres: true }.');
      }
      return postgresEndpoint;
    },
    get opensearch(): OpenSearchEndpoint {
      if (openSearchEndpoint === undefined) {
        throw new Error('startStack was not asked for opensearch: pass { opensearch: true }.');
      }
      return openSearchEndpoint;
    },
    get kafka(): KafkaEndpoint {
      if (kafkaEndpoint === undefined) {
        throw new Error('startStack was not asked for kafka: pass { kafka: true }.');
      }
      return kafkaEndpoint;
    },
    get connect(): ConnectEndpoint {
      if (connectEndpoint === undefined) {
        throw new Error('startStack was not asked for connect: pass { connect: true }.');
      }
      return connectEndpoint;
    },
    stop,
  };
}

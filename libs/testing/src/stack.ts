/**
 * Real infrastructure, in containers, for the assertions that cannot be made
 * without it.
 *
 * ⚠ THE IMAGES AND THE POSTGRES FLAGS ARE READ OUT OF `compose.yaml`, NOT COPIED
 *   HERE. A harness that tests a different Postgres than the one the stack runs
 *   is worse than no harness: it is a green test about a system nobody operates,
 *   and the drift is silent because both sides keep passing. `compose.yaml` is
 *   the one document that owns those versions (critical-rules.md 15), so this
 *   module REFERENCES it. When the reference cannot be resolved it throws, which
 *   is the whole difference between a harness that has drifted and one that is
 *   visibly broken.
 *
 * ⚠ NOTHING HERE TOUCHES THE DEVELOPMENT STACK. Testcontainers starts its own
 *   containers on its own random ports; the stack `docker compose up` runs keeps
 *   55432, 29092 and 8083 to itself. A harness that reached for those ports
 *   would pass alone and fail the moment anyone had the stack up — which is
 *   every day.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Kafka, logLevel } from 'kafkajs';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/** Where a running Postgres can be reached, and as whom. */
export interface PostgresEndpoint {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /** The same thing as a connection string: what TypeORM's `url` option takes. */
  readonly url: string;
}

/** Where a running broker can be reached. */
export interface KafkaEndpoint {
  /** `host:port` pairs, as KafkaJS's `brokers` option wants them. */
  readonly brokers: readonly string[];
}

/** Where a running index can be reached. */
export interface OpenSearchEndpoint {
  readonly host: string;
  readonly port: number;
  /** What the OpenSearch client's `node` option takes. */
  readonly url: string;
}

export interface StartedOpenSearch {
  readonly endpoint: OpenSearchEndpoint;
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

/** Which containers a test needs. Anything left out is not started, nor paid for. */
export interface StackRequest {
  readonly postgres?: boolean;
  readonly kafka?: boolean;
  readonly opensearch?: boolean;
  /**
   * Milliseconds allowed per container before startup is called a failure.
   * Generous by default: a first run pulls the image.
   */
  readonly startupTimeoutMs?: number;
}

export interface StartedStack {
  /** ⚠ Throws if `postgres` was not requested — never returns a dead endpoint. */
  readonly postgres: PostgresEndpoint;
  /** ⚠ Throws if `kafka` was not requested — never returns a dead endpoint. */
  readonly kafka: KafkaEndpoint;
  /** ⚠ Throws if `opensearch` was not requested — never returns a dead endpoint. */
  readonly opensearch: OpenSearchEndpoint;
  stop(): Promise<void>;
}

/**
 * Container startup is measured in tens of seconds, and the first run of all in
 * minutes: an image has to be pulled. A short default here does not make a test
 * fast, it makes it flaky on the one machine that had a cold cache.
 */
const DEFAULT_STARTUP_MS = 180_000;

/** The compose service names this harness reproduces. */
const POSTGRES_SERVICE = 'postgres';
const KAFKA_SERVICE = 'kafka';
const OPENSEARCH_SERVICE = 'opensearch';

/**
 * Throwaway credentials, and deliberately the same words the development stack
 * uses: a URL printed by a failing test should read like the one in `.env`, not
 * like a second set of facts to learn. They are not read from `compose.yaml`
 * because a password is not a version — it cannot drift into being wrong.
 */
const POSTGRES_USER = 'arthome';
const POSTGRES_PASSWORD = 'arthome';

/**
 * The database the server is created with. It exists only so that `CREATE
 * DATABASE` has somewhere to be issued from — a test gets its own database from
 * `createDatabase`, never this one.
 *
 * ⚠ IT IS NOT NAMED AFTER A SERVICE. `identity`, `notifications` and the rest are
 *   members of `SERVICES` in @arthome/core, and this package does not depend on
 *   @arthome/core, so the only honest name is one that belongs to no vocabulary.
 */
const MAINTENANCE_DATABASE = 'arthome';

const POSTGRES_PORT = 5432;

/**
 * ⚠ WITHOUT THIS THERE IS NOTHING FOR DEBEZIUM TO READ. `wal_level=logical` is
 *   the setting the whole event path rests on, it needs a server restart on a
 *   real machine, and at any lower level the connector fails at startup with a
 *   message that does not mention it (data-model.md §7.4). It is asserted after
 *   startup rather than assumed, so that a regression in the `compose.yaml`
 *   reader above surfaces here instead of three layers downstream.
 */
const REQUIRED_WAL_LEVEL = 'logical';

/**
 * The broker's three listeners, mirroring `compose.yaml`: one for inter-broker
 * traffic, one for the KRaft controller, one for clients outside the container.
 */
const OPENSEARCH_PORT = 9200;

/**
 * ⚠ THESE MUST MATCH `compose.yaml`'s opensearch block, and they are NOT read
 *   out of it. `composeImage` reads the image tag because a version can drift;
 *   these three settings cannot drift into being *wrong*, they can only be
 *   absent — and absent, the container does not start at all, which a test
 *   discovers immediately rather than subtly.
 *
 *   `DISABLE_SECURITY_PLUGIN` is what makes `http://` work without credentials,
 *   and the heap cap is not tuning: OpenSearch sizes its default heap from the
 *   host's memory and refuses to start on a small machine without it.
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

/** Where the advertised-listener script is written, and how the container waits for it. */
const KAFKA_STARTER_SCRIPT = '/tmp/arthome-kafka-start.sh';
const KAFKA_SCRIPT_TRAILER = 'ARTHOME_SCRIPT_COMPLETE';
const KAFKA_WAITING_MARKER = 'arthome-testing: waiting for the advertised listeners';

/** The image's own entry point, which the starter script hands over to. */
const KAFKA_ENTRY_POINT = '/etc/kafka/docker/run';

/**
 * `compose.yaml`, resolved from THIS MODULE and not from the working directory.
 *
 * A test is run from the repository root, from `libs/testing`, and from an
 * editor's own cwd, and all three have to work. `src/` and `dist/` sit at the
 * same depth under `libs/testing`, so one relative path serves the source and
 * the build.
 */
const COMPOSE_FILE = new URL('../../../compose.yaml', import.meta.url);

/** The lines of one service's block, from its name to the next service's. */
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

/**
 * The image tag `compose.yaml` pins for one service.
 *
 * Exported because every future container belongs here for the same reason: the
 * day a test wants OpenSearch, it asks this rather than writing the tag down a
 * second time.
 */
export function composeImage(service: string): string {
  for (const line of composeBlock(service)) {
    const tag = /^ {4}image:\s*(\S+)\s*$/.exec(line)?.[1];
    if (tag !== undefined) return tag;
  }
  throw new Error(`compose.yaml pins no image for \`${service}\`.`);
}

/** The `command:` list `compose.yaml` gives one service, item by item. */
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
 * Postgres 18 with the write-ahead log configured the way the connector needs.
 *
 * ⚠ THE READINESS CHECK IS TWO THINGS AND NEEDS TO BE. The official entry point
 *   runs the whole initialisation against a UNIX socket with `listen_addresses`
 *   empty, and prints "database system is ready to accept connections" while
 *   doing it. A `pg_isready` over the socket therefore succeeds on a server that
 *   will shortly be shut down and restarted, and a test that connects in that
 *   window sees its connection dropped mid-query. Waiting for the TCP port rules
 *   the init phase out; `pg_isready` over TCP then rules out a port that is open
 *   but not yet answering.
 */
export async function startPostgres(
  startupTimeoutMs: number = DEFAULT_STARTUP_MS,
): Promise<StartedPostgres> {
  const container = await new GenericContainer(composeImage(POSTGRES_SERVICE))
    .withEnvironment({
      POSTGRES_USER,
      POSTGRES_PASSWORD,
      POSTGRES_DB: MAINTENANCE_DATABASE,
    })
    // The flags are compose's, read out of it: `wal_level`, the replication slot
    // ceiling and the WAL sender ceiling travel together, and a harness that kept
    // only the first would reproduce the setting while losing the capacity.
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
 * A single-node OpenSearch, for tests that assert on a projection.
 *
 * ⚠ IT WAITS ON `/_cluster/health`, NOT ON THE LISTENING PORT. OpenSearch binds
 *   9200 well before the cluster can serve a write: an index request in that
 *   window fails with a master-not-discovered error that reads like a bug in the
 *   test. A single-node cluster reports `yellow`, never `green` — it has no
 *   replica to place — so waiting for green would wait for ever.
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

/** Refuse a server that would make every CDC test a false negative. */
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
 * One Kafka broker in KRaft mode, reachable from the test process.
 *
 * ⚠ A BROKER TELLS ITS CLIENTS WHERE TO RECONNECT, AND IT HAS TO BE TOLD THE
 *   TRUTH. `advertised.listeners` is what comes back in a metadata response, so
 *   it must name the HOST port Docker mapped — which is not known until the
 *   container exists. Advertise the container's own port instead and every
 *   producer connects once, is redirected to a port that is not published, and
 *   hangs until its request timeout with an error about the broker being
 *   unreachable rather than about the address being wrong.
 *
 *   The fix here is the one the testcontainers Kafka module uses, and it is a
 *   two-phase start: the container comes up running a shell that waits for a
 *   script, the mapped port is read off the started container, the script is
 *   written with the real address, and the shell hands over to Kafka's own entry
 *   point.
 *
 *   ⚠ THE SHELL WAITS FOR THE LAST LINE OF THE SCRIPT, NOT FOR THE FILE. A file
 *     exists from its first byte; `docker cp` creates it, then fills it. Testing
 *     `-f` can therefore hand a half-written script to `sh`, which is a syntax
 *     error inside a container at a moment when nothing is watching the logs.
 *     Grepping for a trailer that is written last cannot see a partial file.
 *
 * ⚠ RESERVING A HOST PORT UP FRONT WOULD HAVE BEEN SHORTER, AND IT IS THE THING
 *   THIS AVOIDS. Asking the kernel for a free port, closing it, and handing the
 *   number to Docker leaves a window in which anything else on the machine can
 *   take it — rare, unreproducible, and indistinguishable from a broken test.
 */
export async function startKafka(
  startupTimeoutMs: number = DEFAULT_STARTUP_MS,
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
      // compose says `1@kafka:9093` because `kafka` is the compose service's own
      // DNS name. There is no second container here to resolve it, and the one
      // broker is its own controller, so the quorum voter is the loopback.
      KAFKA_CONTROLLER_QUORUM_VOTERS: `1@localhost:${KAFKA_CONTROLLER_PORT}`,
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      // ⚠ NOT A PERFORMANCE TWEAK. The default is three seconds of deliberate
      //   waiting for more group members before the first assignment, paid by
      //   every consumer this harness creates. A test that waits for one message
      //   would spend that three seconds doing nothing, per test.
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      // A fresh id per container: two harness brokers running side by side must
      // not look to each other like two halves of one cluster.
      CLUSTER_ID: Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64url'),
    })
    .withExposedPorts(KAFKA_CLIENT_PORT)
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
        `export KAFKA_ADVERTISED_LISTENERS='PLAINTEXT://localhost:${KAFKA_INTERNAL_PORT}` +
          `,HOST://${broker}'`,
        `exec ${KAFKA_ENTRY_POINT}`,
        // Written last, read by the shell loop above: the file is complete when
        // this line is in it. Never executed — `exec` does not return.
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
 * Poll until the broker answers a metadata request.
 *
 * ⚠ "KAFKA SERVER STARTED" IN THE LOG IS NOT THE SAME CLAIM. The log line is
 *   printed before the controller has finished electing itself, and a client
 *   that connects in between gets a metadata response with no leaders — which
 *   KafkaJS reports as an unrelated topic error. Asking the broker the question
 *   the test will ask is the only readiness signal worth having.
 */
async function waitForBroker(broker: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const kafka = new Kafka({
    clientId: 'arthome-testing-probe',
    brokers: [broker],
    // ⚠ SILENT AND WITHOUT RETRIES, both on purpose. KafkaJS's own retry would
    //   sit inside this loop's iteration and turn a 250 ms poll into a minute of
    //   exponential backoff; its default logger would print a connection warning
    //   for every poll and bury the test output that matters.
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
 * Start what a test asks for, and nothing else.
 *
 * ⚠ THE TWO ARE STARTED IN PARALLEL AND TORN DOWN TOGETHER ON FAILURE. Started
 *   one after the other, a test that needs both pays the sum of two image pulls
 *   for no reason. Started in parallel with `Promise.all`, a failure of one
 *   abandons the other still running, and the leak is invisible until a machine
 *   has thirty of them.
 */
export async function startStack(request: StackRequest): Promise<StartedStack> {
  const timeout = request.startupTimeoutMs ?? DEFAULT_STARTUP_MS;

  const [postgres, kafka, opensearch] = await Promise.allSettled([
    request.postgres === true ? startPostgres(timeout) : null,
    request.kafka === true ? startKafka(timeout) : null,
    request.opensearch === true ? startOpenSearch(timeout) : null,
  ]);

  const outcomes = [postgres, kafka, opensearch];
  const started = outcomes.flatMap((outcome) =>
    outcome.status === 'fulfilled' && outcome.value !== null ? [outcome.value] : [],
  );
  const failed: string[] = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [String(outcome.reason)] : [],
  );

  const stop = async (): Promise<void> => {
    await Promise.allSettled(started.map((container) => container.stop()));
  };

  if (failed.length > 0) {
    await stop();
    throw new Error(`the harness could not start the stack: ${failed.join('; ')}`);
  }

  const postgresEndpoint = postgres.status === 'fulfilled' ? postgres.value?.endpoint : undefined;
  const kafkaEndpoint = kafka.status === 'fulfilled' ? kafka.value?.endpoint : undefined;
  const openSearchEndpoint =
    opensearch.status === 'fulfilled' ? opensearch.value?.endpoint : undefined;

  return {
    // Getters rather than nullable fields: a test that forgot to ask for a
    // container is told so by name, instead of reading `undefined` out of an
    // endpoint and failing later on a connection string of the word "undefined".
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
    stop,
  };
}

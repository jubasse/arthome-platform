import { randomUUID } from 'node:crypto';

import {
  DateOutcome as WireDateOutcome,
  DateOutcomeDeclaredSchema,
  DateScheduledSchema,
  DeviceRevokedSchema,
  DeviceSessionClosedSchema,
  PlanOpening as WirePlanOpening,
  PlanTier as WirePlanTier,
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
  SeatActivatedSchema,
  SeatCancelledSchema,
  SubscriptionChangedSchema,
  SubscriptionState as WireSubscriptionState,
} from '@arthome-platform/events';
import { InternalTokenVerifier, serveEndpoints } from '@arthome-platform/http-edge';
import type { Outcome } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  mintInternalToken,
  startStack,
  type DeclaredResponses,
  type StartedStack,
} from '@arthome-platform/testing';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';

import {
  DisplayState,
  FixedClock,
  InternalTokenIssuer,
  RunState,
  Service,
  Surface,
  type Instant,
  type StorefrontSurface,
} from '@arthome/core';

import {
  ACCOUNT_TOPIC,
  CATALOG_DATE_TOPIC,
  DATE_SALES_TOPIC,
  payloadOf,
  wireMessage,
  type WireMessage,
} from './entitlement.js';
import { STUDIO_KEY_ID, studioTokenVerifier } from './run-desk.js';
import { STREAMING_SCHEMA } from './schema.js';
import { CLOCK } from '../clock.js';
import { applyStreamingMessage } from '../consumed-messages.js';
import { DevicesConsumerModule } from '../devices/devices-consumer.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { EntitlementConsumerModule } from '../entitlement/entitlement-consumer.module.js';
import { FakeStreamingProvider } from '../media/fake-streaming-provider.js';
import { ExpireLapsedLeases, ExpireLapsedLeasesHandler } from '../playback/lease-sweep.js';
import { PlaybackModule } from '../playback/playback.module.js';

/**
 * The player's routes over HTTP on a real Postgres, with the consumer's entitlement and device
 *   modules on the same bus, all on one `FixedClock` the fake provider shares. A suite projects its
 *   dates, seats and subscriptions as the consumer reads them, and writes the run's row itself.
 */

export const STARTUP_MS = 240_000;
export const CASE_MS = 60_000;

export const NOW: Instant = '2026-12-12T19:10:00.000Z';
/** Ten minutes before `NOW`: the date is live by the clock and by its run. */
export const STARTS_AT: Instant = '2026-12-12T19:00:00.000Z';
const OCCURRED_AT = timestampFromDate(new Date('2026-12-01T10:00:00.000Z'));
const CHANNEL = '01a0f6cc-0000-7000-8000-000000000001';

export interface Playback {
  readonly stack: StartedStack;
  readonly dataSource: DataSource;
  readonly app: NestFastifyApplication;
  readonly clock: FixedClock;
  readonly fake: FakeStreamingProvider;
  /** As the consumer applies it: read, then dispatched on the real bus. */
  readonly apply: (message: WireMessage) => Promise<Outcome>;
  /** One pass of the sweeper's lease expiry, on the suite's clock. */
  readonly sweep: (batch?: number) => Promise<number>;
}

export async function startPlayback(
  database: string,
  { watch }: { readonly watch?: DeclaredResponses } = {},
): Promise<Playback> {
  const stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const dataSource = await applyMigrations(
    await createDatabase(stack.postgres, database),
    STREAMING_SCHEMA,
  );
  const clock = new FixedClock(NOW);
  const app = await httpApp({
    imports: [PlaybackModule, EntitlementConsumerModule, DevicesConsumerModule],
    providers: EDGE_PROVIDERS,
    dataSource,
    overrides: [
      [CLOCK, clock],
      [InternalTokenVerifier, studioTokenVerifier(clock)],
    ],
    configure: (configured) => {
      serveEndpoints(configured);
      watch?.watch(configured);
    },
  });
  const commands = app.get(CommandBus);
  const sweeper = new ExpireLapsedLeasesHandler(dataSource, clock);
  return {
    stack,
    dataSource,
    app,
    clock,
    fake: app.get(FakeStreamingProvider),
    apply: (message) => applyStreamingMessage(commands, payloadOf(message)),
    sweep: (batch?: number) => sweeper.execute(new ExpireLapsedLeases(batch)),
  };
}

export async function stopPlayback(playback: Playback | undefined): Promise<void> {
  await playback?.app.close();
  await playback?.stack.stop();
}

async function applied(playback: Playback, ...messages: WireMessage[]): Promise<void> {
  for (const message of messages) await playback.apply(message);
}

export interface DateOptions {
  readonly startsAt?: Instant;
  readonly blackoutCountries?: readonly string[];
  readonly runState?: RunState | null;
}

/** A date scheduled, published worldwide (or blacked out where told) and its run on air. */
export async function liveDate(
  playback: Playback,
  { startsAt = STARTS_AT, blackoutCountries = [], runState = RunState.ON_AIR }: DateOptions = {},
): Promise<string> {
  const dateId = randomUUID();
  await applied(
    playback,
    wireMessage(CATALOG_DATE_TOPIC, 'catalog.date.scheduled.v1', DateScheduledSchema, dateId, {
      dateId,
      channelId: CHANNEL,
      startsAt: timestampFromDate(new Date(startsAt)),
      runtimeMin: 90,
      replayPolicy: WireReplayPolicy.NONE,
      rights:
        blackoutCountries.length === 0
          ? { scope: WireRightsScope.WORLDWIDE }
          : { scope: WireRightsScope.RESTRICTED, blackoutCountries: [...blackoutCountries] },
      occurredAt: OCCURRED_AT,
    }),
    wireMessage(
      CATALOG_DATE_TOPIC,
      'catalog.publication.state_changed.v1',
      PublicationStateChangedSchema,
      dateId,
      {
        dateId,
        channelId: CHANNEL,
        toState: WirePublicationState.SCHEDULED,
        version: 1n,
        occurredAt: OCCURRED_AT,
      },
    ),
  );
  if (runState !== null) await setRun(playback, dateId, runState);
  return dateId;
}

/** The run's row as PS1 leaves it in that state: the playback reads its state and its veil only. */
export async function setRun(playback: Playback, dateId: string, state: RunState): Promise<void> {
  const now = new Date(playback.clock.now());
  await playback.dataSource.query(
    `INSERT INTO run (id, date_id, channel_id, state, stream_path, ingest_protocol, monitor_path,
                      started_at, ended_at, version)
          VALUES ($1, $2, $3, $4, $5, 'rtmps', 'll_hls', $6, $7, 1)
     ON CONFLICT (date_id) DO UPDATE
             SET state = excluded.state, ended_at = excluded.ended_at`,
    [
      randomUUID(),
      dateId,
      CHANNEL,
      state,
      randomUUID(),
      state === RunState.IDLE || state === RunState.REHEARSAL ? null : now,
      state === RunState.ENDED ? now : null,
    ],
  );
}

export async function declareInterrupted(playback: Playback, dateId: string): Promise<void> {
  await applied(
    playback,
    wireMessage(
      CATALOG_DATE_TOPIC,
      'catalog.date.outcome_declared.v1',
      DateOutcomeDeclaredSchema,
      dateId,
      {
        dateId,
        channelId: CHANNEL,
        outcome: WireDateOutcome.INTERRUPTED,
        declaredAt: timestampFromDate(new Date(playback.clock.now())),
      },
    ),
  );
}

/** One seat activated for the account on the date; its id cancels it. */
export async function grantSeat(
  playback: Playback,
  accountId: string,
  dateId: string,
): Promise<string> {
  const seatId = randomUUID();
  await applied(
    playback,
    wireMessage(DATE_SALES_TOPIC, 'ticketing.seat.activated.v1', SeatActivatedSchema, dateId, {
      seatId,
      accountId,
      dateId,
      occurredAt: OCCURRED_AT,
    }),
  );
  return seatId;
}

export async function cancelSeat(
  playback: Playback,
  seatId: string,
  accountId: string,
  dateId: string,
): Promise<void> {
  await applied(
    playback,
    wireMessage(DATE_SALES_TOPIC, 'ticketing.seat.cancelled.v1', SeatCancelledSchema, dateId, {
      seatId,
      accountId,
      dateId,
      occurredAt: timestampFromDate(new Date(playback.clock.now())),
    }),
  );
}

/** A premium subscription: every live, on two screens. */
export async function subscribeMultiScreen(playback: Playback, accountId: string): Promise<void> {
  await applied(
    playback,
    wireMessage(
      ACCOUNT_TOPIC,
      'ticketing.subscription.changed.v1',
      SubscriptionChangedSchema,
      accountId,
      {
        accountId,
        plan: WirePlanTier.PREMIUM,
        state: WireSubscriptionState.ACTIVE,
        opens: [WirePlanOpening.ALL_LIVES, WirePlanOpening.MULTI_SCREEN],
        occurredAt: OCCURRED_AT,
      },
    ),
  );
}

export function deviceRevoked(accountId: string, deviceId: string, at: Instant): WireMessage {
  return wireMessage(
    'arthome.identity.device',
    'identity.device.revoked.v1',
    DeviceRevokedSchema,
    deviceId,
    { deviceId, accountId, occurredAt: timestampFromDate(new Date(at)) },
  );
}

export function deviceSessionClosed(viewer: Viewer, at: Instant): WireMessage {
  return wireMessage(
    'arthome.identity.device',
    'identity.device_session.closed.v1',
    DeviceSessionClosedSchema,
    viewer.deviceId,
    {
      deviceId: viewer.deviceId,
      accountId: viewer.accountId,
      profileId: viewer.profileId,
      occurredAt: timestampFromDate(new Date(at)),
      selfInitiated: true,
    },
  );
}

/** Who the storefront BFF mints the token for: an account, its profile, its device. */
export interface Viewer {
  readonly accountId: string;
  readonly profileId: string;
  readonly deviceId: string;
}

/** Identity's ids are UUIDv7, which the internal token's claims require: a v4 with its version set. */
export function identityId(): string {
  return randomUUID().replace(/^(.{14})4/, '$17');
}

export function newViewer(accountId: string = identityId()): Viewer {
  return { accountId, profileId: identityId(), deviceId: identityId() };
}

/** The same account and profile on another of its devices. */
export function onAnotherDevice(viewer: Viewer): Viewer {
  return { ...viewer, deviceId: identityId() };
}

export interface CallOptions {
  readonly issuer?: InternalTokenIssuer;
  /** What the token names, when it differs from the viewer: null leaves the claim out. */
  readonly token?: {
    readonly accountId?: string | null;
    readonly profileId?: string | null;
    readonly deviceId?: string | null;
  };
  readonly deadline?: string | null;
  readonly country?: string | null;
  readonly surface?: StorefrontSurface;
}

async function headersFor(playback: Playback, viewer: Viewer, options: CallOptions) {
  const issuer = options.issuer ?? InternalTokenIssuer.STOREFRONT_BFF;
  const named = { ...viewer, ...options.token };
  const token = await mintInternalToken(
    {
      service: Service.STREAMING,
      clock: playback.clock,
      ...(named.accountId !== null && { accountId: named.accountId }),
      ...(named.profileId !== null && { profileId: named.profileId }),
      ...(named.deviceId !== null && { deviceId: named.deviceId }),
    },
    {
      issuer,
      ...(issuer === InternalTokenIssuer.STUDIO_BFF && { keyId: STUDIO_KEY_ID }),
    },
  );
  const deadline =
    options.deadline === undefined
      ? new Date(playback.clock.nowMs() + 60_000).toISOString()
      : options.deadline;
  const country = options.country === undefined ? 'FR' : options.country;
  return {
    authorization: `Bearer ${token}`,
    'x-arthome-actor-surface': options.surface ?? Surface.STOREFRONT_TV,
    ...(deadline !== null && { 'x-arthome-deadline': deadline }),
    ...(country !== null && { 'x-arthome-viewer-country': country }),
  };
}

export interface OpenOptions extends CallOptions {
  readonly body?: Record<string, unknown>;
}

export async function openCall(
  playback: Playback,
  viewer: Viewer,
  dateId: string,
  options: OpenOptions = {},
) {
  return playback.app.inject({
    method: 'POST',
    url: `/v1/playback/${dateId}/open`,
    headers: {
      ...(await headersFor(playback, viewer, options)),
      'x-arthome-surface': options.surface ?? Surface.STOREFRONT_TV,
      'content-type': 'application/json',
    },
    payload: {
      deviceId: viewer.deviceId,
      kind: DisplayState.LIVE,
      profileId: viewer.profileId,
      capabilities: { maxHeightPx: 1080 },
      ...options.body,
    },
  });
}

export async function renewCall(
  playback: Playback,
  viewer: Viewer,
  sessionId: string,
  options: CallOptions = {},
) {
  return playback.app.inject({
    method: 'POST',
    url: `/v1/playback/sessions/${sessionId}/renew`,
    headers: await headersFor(playback, viewer, options),
  });
}

export async function releaseCall(
  playback: Playback,
  viewer: Viewer,
  sessionId: string,
  options: CallOptions = {},
) {
  const { 'x-arthome-viewer-country': _country, ...headers } = await headersFor(
    playback,
    viewer,
    options,
  );
  return playback.app.inject({
    method: 'POST',
    url: `/v1/playback/sessions/${sessionId}/release`,
    headers,
  });
}

/** The ticket's data, or the call's failure with its body. */
export function ticketOf(response: { statusCode: number; body: string }) {
  if (response.statusCode !== 200) {
    throw new Error(`expected a ticket, got ${String(response.statusCode)}: ${response.body}`);
  }
  return (JSON.parse(response.body) as { data: Ticket }).data;
}

export interface Ticket {
  readonly sessionId: string;
  readonly resumedExistingSession?: boolean;
  readonly scope: string;
  readonly manifestUrl: string;
  readonly signature: { readonly queryToken?: string | null; readonly cookieSet?: boolean | null };
  readonly edgeRenewalMode: string;
  readonly expiresAt: string;
  readonly renewAfterSec: number;
  readonly leaseExpiresAt: string;
  readonly qualityCap: string;
  readonly drmSystem?: string | null;
  readonly protocol: string;
}

export interface ErrorBody {
  readonly error: { readonly code: string; readonly params?: Record<string, unknown> };
}

export function errorOf(response: { body: string }): ErrorBody['error'] {
  return (JSON.parse(response.body) as ErrorBody).error;
}

export interface SessionRow {
  readonly id: string;
  readonly device_id: string;
  readonly state: string;
  readonly revoke_reason: string | null;
}

export function sessionsOf(playback: Playback, accountId: string): Promise<SessionRow[]> {
  return playback.dataSource.query<SessionRow[]>(
    `SELECT id, device_id, state, revoke_reason FROM playback_session
      WHERE account_id = $1 ORDER BY opened_at, id`,
    [accountId],
  );
}

import type { HandlerInput } from '@arthome/contracts/http';
import {
  DrmSystem,
  EdgeRenewalMode,
  PlaybackProtocol,
  QualityCap,
} from '@arthome/contracts/streaming';
import type { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import { Surface, toEpochMs, type StorefrontSurface } from '@arthome/core';

import type { PlaybackCapabilities, PlaybackCookie } from '../media/media-ports.js';

export type DeclaredCapabilities = NonNullable<
  HandlerInput<typeof streamingServiceApi.routes.openPlayback>['body']['capabilities']
>;

/** What the server chooses for one device: never guessed by the client, degraded rather than refused. */
export interface PlaybackFormat {
  readonly protocol: PlaybackProtocol;
  readonly drmSystem: DrmSystem | null;
  readonly qualityCap: QualityCap;
  readonly mechanism: EdgeRenewalMode;
}

const QUALITY_FLOORS_PX: readonly (readonly [number, QualityCap])[] = [
  [2160, QualityCap.UHD],
  [1080, QualityCap.FHD],
  [720, QualityCap.HD],
];

/** A device that declares no height gets `hd`: a cap too low degrades, one too high is the wrong promise. */
export function qualityCapFor(maxHeightPx: number | undefined): QualityCap {
  if (maxHeightPx === undefined) return QualityCap.HD;
  return QUALITY_FLOORS_PX.find(([floor]) => maxHeightPx >= floor)?.[1] ?? QualityCap.SD;
}

function drmSystemFor(
  provider: PlaybackCapabilities,
  declared: DeclaredCapabilities | undefined,
): DrmSystem | null {
  const offered = declared?.drmSystems ?? [];
  return provider.drmSystems.find((system) => offered.includes(system)) ?? null;
}

/** FairPlay rides HLS; Widevine and PlayReady prefer DASH when the provider serves it. */
function protocolFor(
  provider: PlaybackCapabilities,
  drmSystem: DrmSystem | null,
): PlaybackProtocol {
  const preferred =
    drmSystem === null || drmSystem === DrmSystem.FAIRPLAY
      ? PlaybackProtocol.HLS
      : PlaybackProtocol.DASH;
  const chosen = provider.protocols.includes(preferred) ? preferred : provider.protocols[0];
  if (chosen === undefined) throw new Error('the playback provider declares no protocol');
  return chosen;
}

/**
 * Signed cookies for the browser, a query token for native players; a provider declaring neither
 *   is asked for a query token and refuses it (`PlaybackSigningUnavailable`), never serves unsigned.
 */
export function edgeRenewalModeFor(
  provider: PlaybackCapabilities,
  surface: StorefrontSurface,
): EdgeRenewalMode {
  if (surface === Surface.STOREFRONT_WEB && provider.supportsSignedCookies) {
    return EdgeRenewalMode.SIGNED_COOKIE;
  }
  return EdgeRenewalMode.QUERY_TOKEN;
}

export function playbackFormatFor(
  provider: PlaybackCapabilities,
  declared: DeclaredCapabilities | undefined,
  surface: StorefrontSurface,
): PlaybackFormat {
  const drmSystem = drmSystemFor(provider, declared);
  return {
    protocol: protocolFor(provider, drmSystem),
    drmSystem,
    qualityCap: qualityCapFor(declared?.maxHeightPx),
    mechanism: edgeRenewalModeFor(provider, surface),
  };
}

/** The port's cookies as `Set-Cookie` values, which the BFF relays to the browser (its slice). */
export function setCookieHeadersOf(cookies: readonly PlaybackCookie[]): string[] {
  return cookies.map(
    ({ name, value, path, expiresAt }) =>
      `${name}=${value}; Path=${path}; Expires=${new Date(toEpochMs(expiresAt)).toUTCString()}; ` +
      'Secure; HttpOnly; SameSite=None',
  );
}

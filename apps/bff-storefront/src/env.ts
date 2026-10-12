import {
  readBffEnv,
  readCsrfSecret,
  readIdentityUrl,
  readInternalTokenSigningKey,
  readPlaybackCookieDomain,
  readRedisUrl,
  readStreamingUrl,
  readTrustedProxies,
  readViewerCountryHeader,
  type BffEnv,
  type SigningKey,
} from '@arthome-platform/config';

export const env: BffEnv = readBffEnv();

/** Read at module load like `env`, so a deployment missing one fails at boot, naming it. */
export const authEnv: {
  readonly identityUrl: string;
  readonly redisUrl: string;
  readonly signingKey: SigningKey;
  readonly csrfSecret: string;
  readonly trustedProxies: readonly string[];
  readonly viewerCountryHeader: string | null;
} = {
  identityUrl: readIdentityUrl(),
  redisUrl: readRedisUrl(),
  signingKey: readInternalTokenSigningKey(),
  csrfSecret: readCsrfSecret(),
  trustedProxies: readTrustedProxies(),
  viewerCountryHeader: readViewerCountryHeader(),
};

/** The player's routes: where streaming answers, and the `Domain` its ticket cookie is relayed on. */
export const playbackEnv: {
  readonly streamingUrl: string;
  readonly cookieDomain: string | null;
} = {
  streamingUrl: readStreamingUrl(),
  cookieDomain: readPlaybackCookieDomain(),
};

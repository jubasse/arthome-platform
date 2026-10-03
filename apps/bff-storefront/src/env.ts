import {
  readBffEnv,
  readCsrfSecret,
  readIdentityUrl,
  readInternalTokenSigningKey,
  readRedisUrl,
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

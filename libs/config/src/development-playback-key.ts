/**
 * The key playback is signed with OUTSIDE production, so the fake streaming provider signs on a
 * fresh clone. Published here, it protects nothing, so production refuses it by its key material
 * whatever `kid` it is given. It is not the internal token's development key: the playback set and
 * the session set are never the same (`adr-stream-entitlement.md` §3.4).
 */
export const DEVELOPMENT_PLAYBACK_KEY_ID = 'play-development';

export const DEVELOPMENT_PLAYBACK_PRIVATE_JWK: Readonly<
  Record<'kty' | 'crv' | 'x' | 'y' | 'd' | 'kid', string>
> = {
  kty: 'EC',
  crv: 'P-256',
  x: 'fJX5rezG5FSD2_OmhffGlraX6DbJF6zUi_fGgaSM8rM',
  y: 'cxNwxbf1tJ8NwRIAJ0u7sO5Uz_Pcdxbdg5L7v7VP3x0',
  d: 'JeY3r498VaqzIEc4WjeNYVYf6Q7a0rfy3_lGDF0jLHY',
  kid: DEVELOPMENT_PLAYBACK_KEY_ID,
};

/** True for the published key, by its public coordinates: a renamed `kid` changes nothing. */
export function isDevelopmentPlaybackKey(jwk: {
  readonly x?: unknown;
  readonly y?: unknown;
}): boolean {
  return (
    jwk.x === DEVELOPMENT_PLAYBACK_PRIVATE_JWK.x && jwk.y === DEVELOPMENT_PLAYBACK_PRIVATE_JWK.y
  );
}

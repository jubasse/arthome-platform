/**
 * The storefront BFF's signing key OUTSIDE production, so a fresh clone runs the BFF and the
 * services against each other with nothing to provision. It protects nothing, being published here,
 * so production refuses it by its key material, whatever `kid` it is given, and a verifier drops it
 * from any JWKS document it fetches (`isDevelopmentTokenKey`).
 */
export const DEVELOPMENT_TOKEN_KEY_ID = 'bff-sf-development';

export const DEVELOPMENT_TOKEN_PRIVATE_JWK: Readonly<
  Record<'kty' | 'crv' | 'x' | 'y' | 'd' | 'kid', string>
> = {
  kty: 'EC',
  crv: 'P-256',
  x: 'yrpOao2qZtML5MusrxTx1aDWGswvY5OOR_fllzL59GI',
  y: 'ki6qt4Fywe_2zdQdtWcsxmvX4EYWG49e5IoZokhdQek',
  d: 'HubC9T--WhiChZoNmCD_bZqQ3gF1GrS1RWJ07PDhHFI',
  kid: DEVELOPMENT_TOKEN_KEY_ID,
};

/** True for the published key, by its public coordinates: a renamed `kid` changes nothing. */
export function isDevelopmentTokenKey(jwk: {
  readonly x?: unknown;
  readonly y?: unknown;
}): boolean {
  return jwk.x === DEVELOPMENT_TOKEN_PRIVATE_JWK.x && jwk.y === DEVELOPMENT_TOKEN_PRIVATE_JWK.y;
}

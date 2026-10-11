#!/usr/bin/env node
// Writes the public half of the playback signing key as the key set the playback edge (Envoy)
// reads from disk. No service serves it (D-121): the edge's key set is infrastructure, as a CDN's
// is. Envoy reads the file at start only, so restart `playback-edge` after writing it.
//
//   Usage: NODE_ENV=development node tools/playback-jwks.mjs [out]   (default infra/mediamtx/playback-jwks.json)
//   With PLAYBACK_SIGNING_KEY unset outside production, the published development key.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPlaybackSigningKey } from '@arthome-platform/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(root, process.argv[2] ?? 'infra/mediamtx/playback-jwks.json');

const { keyId, privateJwk } = readPlaybackSigningKey();
const { kty, crv, x, y } = privateJwk;
const keySet = { keys: [{ kty, crv, x, y, kid: keyId, alg: 'ES256', use: 'sig' }] };

fs.writeFileSync(out, `${JSON.stringify(keySet, null, 2)}\n`);
console.log(`playback-jwks: wrote ${path.relative(root, out)} (kid ${keyId})`);

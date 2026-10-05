#!/usr/bin/env node
// use-core <version> [--from <releases-url>] — consume a released arthome-core.
//
// Points every @arthome/* dependency at the tarballs attached to the GitHub
// release v<version> of arthome-core, refreshes the lockfile (pnpm records the
// integrity of each URL), and builds the libs. `bootstrap` is the other way in:
// it packs a sibling checkout, for cross-repository work that is not released yet.
// `--from` swaps the base URL, for a mirror or a local test server.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  ARTHOME_PACKAGES,
  CORE_RELEASES_URL,
  REPO,
  releaseAssetUrl,
  rewriteArthomeSpecs,
} from './arthome-specs.mjs';

function fail(message) {
  console.error(`use-core: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const fromIndex = args.indexOf('--from');
const releasesUrl = fromIndex === -1 ? CORE_RELEASES_URL : args.splice(fromIndex, 2)[1];
if (!releasesUrl) fail('--from needs a URL');

const version = args[0]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail('usage: pnpm run use-core <version>   e.g. pnpm run use-core 0.1.0');
}

for (const name of ARTHOME_PACKAGES) {
  const url = releaseAssetUrl(name, version, releasesUrl);
  const response = await fetch(url, { method: 'HEAD' }).catch((error) => fail(`${url}: ${error}`));
  if (!response.ok) fail(`${url} answered ${response.status}; is v${version} released?`);
}

const touched = rewriteArthomeSpecs((name) => releaseAssetUrl(name, version, releasesUrl));
console.log(
  touched.length
    ? `use-core: ${touched.length} manifest(s) now point at arthome-core v${version}: ${touched.join(', ')}`
    : `use-core: every manifest already pointed at arthome-core v${version}`,
);

const vendor = path.join(REPO, 'vendor');
if (fs.existsSync(vendor)) {
  for (const entry of fs.readdirSync(vendor)) {
    if (/^arthome-(core|contracts|tooling)-.*\.tgz$/.test(entry))
      fs.rmSync(path.join(vendor, entry));
  }
}

execFileSync('pnpm', ['install'], { cwd: REPO, stdio: 'inherit' });
execFileSync('pnpm', ['run', 'build:libs'], { cwd: REPO, stdio: 'inherit' });

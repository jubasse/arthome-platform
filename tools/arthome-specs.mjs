// What pack-siblings, use-core and check-core-specs share: which manifests the
// workspace has, which dependencies are @arthome/* packages, and the shape of a
// release asset URL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARTHOME_PACKAGES = ['core', 'contracts', 'tooling'];
export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
export const CORE_RELEASES_URL = 'https://github.com/jubasse/arthome-core/releases/download';

export function releaseAssetUrl(name, version, releasesUrl = CORE_RELEASES_URL) {
  return `${releasesUrl}/v${version}/arthome-${name}-${version}.tgz`;
}

export function parseReleaseAssetUrl(spec) {
  const escaped = CORE_RELEASES_URL.replaceAll('.', '\\.');
  const match = new RegExp(`^${escaped}/v([^/]+)/arthome-([a-z]+)-([^/]+)\\.tgz$`).exec(spec);
  return match ? { tagVersion: match[1], name: match[2], fileVersion: match[3] } : null;
}

function workspaceGlobs() {
  const globs = [];
  let inside = false;
  for (const raw of fs.readFileSync(path.join(REPO, 'pnpm-workspace.yaml'), 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (!item) {
      if (line.trim() === '') continue;
      break;
    }
    globs.push(item[1].trim().replace(/^["']|["']$/g, ''));
  }
  return globs;
}

export function manifestPaths() {
  const found = [path.join(REPO, 'package.json')];
  for (const glob of workspaceGlobs()) {
    const dir = path.join(REPO, glob.replace(/\/\*$/, ''));
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const candidate = path.join(dir, entry, 'package.json');
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

// Points every @arthome/* dependency of every manifest at specFor(name), and
// returns the manifests that changed.
export function rewriteArthomeSpecs(specFor) {
  const touched = [];
  for (const file of manifestPaths()) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = false;

    for (const field of DEPENDENCY_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        const name = ARTHOME_PACKAGES.find((p) => `@arthome/${p}` === dep);
        if (!name) continue;
        const spec = specFor(name, file);
        if (manifest[field][dep] !== spec) {
          manifest[field][dep] = spec;
          changed = true;
        }
      }
    }

    if (changed) {
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
      touched.push(path.relative(REPO, file));
    }
  }
  return touched;
}

#!/usr/bin/env node
// pack-siblings — turn the sibling arthome-core checkout into installable
// tarballs under vendor/, because the @arthome/* packages are not published.
//
// WHY TARBALLS AND NOT `file:../arthome-core/packages/core`
//   A `file:` reference to a source DIRECTORY makes pnpm symlink the whole
//   working tree, `files` field and all — which means it would also expose
//   `packages/tooling/docs/`, a gitignored build directory that happens to
//   exist on this machine. `arthome-sync-agent-docs` would then appear to work
//   even if the package were shipping nothing, and the three documents would be
//   proven by an accident of the local filesystem.
//
//   ⚠ THAT IS NOT HYPOTHETICAL. The first tarball packed for this repository
//     carried `bin/` and no `docs/` at all, and the hook reported success over
//     it. A symlink would have hidden that; a tarball is what found it. Only a
//     real pack exercises `files`, `bin` and `prepack` — the three things that
//     decide what a consumer actually receives.
//
// WHY NOT A LOCAL REGISTRY
//   Verdaccio is a daemon to install, run and keep alive for three packages
//   that change in one place. Everything here has to be verifiable locally with
//   no service running.
//
// ⚠ CONTENT-ADDRESSED FILENAMES, AND A STABLE NAME WAS TRIED FIRST AND FAILED
//   SILENTLY — which is the worst way for a build to be wrong.
//
//   With `vendor/arthome-tooling.tgz` fixed, a fix made in arthome-core is
//   packed, `pnpm install` is run, and THE FIX IS NOT THERE. pnpm prints
//   "Lockfile is up to date, resolution step is skipped": the specifier did not
//   change, so it never looks at the file. Measured, not assumed — none of
//   these picked the new content up:
//     · pnpm install                         · pnpm install --force
//     · rm -rf node_modules/.pnpm/@arthome*  · dropping the integrity from the lockfile
//   The extracted directory is keyed by PATH, and the lockfile's integrity
//   points into the global store, so the old bytes are re-linked from there.
//   Only deleting node_modules AND the lockfile worked.
//
//   A changing specifier is the one invalidation pnpm actually supports, so the
//   filename carries the first 12 hex of the tarball's sha256 and the manifests
//   are rewritten to match. Staleness stops being something to remember to
//   clean and becomes impossible: different bytes, different name, different
//   spec. The churn in `git diff` is provenance — it says which build of the
//   domain this repository is compiled against.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VENDOR = path.join(REPO, 'vendor');
const PACKAGES = ['core', 'contracts', 'tooling'];

function siblingRoot() {
  const explicit = process.env.ARTHOME_CORE;
  const candidates = explicit ? [explicit] : [path.resolve(REPO, '..', 'arthome-core')];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'packages', 'tooling', 'package.json'))) return c;
  }
  console.error('pack-siblings: arthome-core not found.');
  console.error(`  Looked in: ${candidates.join(', ')}`);
  console.error('  The @arthome/* packages are not published, so this repository is built');
  console.error('  against a sibling checkout. Clone arthome-core next to this one, or set');
  console.error('  ARTHOME_CORE to its path.');
  return null;
}

// Every manifest that depends on an @arthome/* package is pointed at the build
// just produced. Rewriting rather than asking a human to is the whole point: a
// hand-edited path is the parallel table this repository cannot use a catalog
// to remove (pnpm refuses `file:` in catalogs), so it is written by machine and
// checked by `tools/check-vendor-specs.mjs`.
function rewriteManifests(packed) {
  const byName = new Map(packed.map((p) => [`@arthome/${p.name}`, p]));
  const touched = [];

  for (const file of manifestPaths()) {
    const text = fs.readFileSync(file, 'utf8');
    const manifest = JSON.parse(text);
    let changed = false;

    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        const p = byName.get(dep);
        if (!p) continue;
        const rel = path.relative(path.dirname(file), path.join(VENDOR, p.file));
        const spec = `file:${rel.startsWith('.') ? rel : `./${rel}`}`;
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

function manifestPaths() {
  const found = [path.join(REPO, 'package.json')];
  for (const dir of ['apps', 'libs', 'tools']) {
    const parent = path.join(REPO, dir);
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent)) {
      const candidate = path.join(parent, entry, 'package.json');
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

function main() {
  const root = siblingRoot();
  if (!root) return 1;

  fs.mkdirSync(VENDOR, { recursive: true });
  const packed = [];

  for (const name of PACKAGES) {
    const dir = path.join(root, 'packages', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

    // `prepack` is what builds. Without it a tarball carries a stale dist/ or
    // no docs/ at all, and nothing downstream says so (D-071).
    if (!manifest.scripts?.prepack) {
      console.error(`pack-siblings: @arthome/${name} has no \`prepack\` script.`);
      console.error('  Packing does not build, so the tarball would ship stale or missing');
      console.error('  build output. Add prepack in arthome-core before packing.');
      return 1;
    }

    execFileSync('pnpm', ['pack', '--pack-destination', VENDOR], { cwd: dir, stdio: 'pipe' });
    const produced = path.join(VENDOR, `arthome-${name}-${manifest.version}.tgz`);
    const digest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(produced))
      .digest('hex')
      .slice(0, 12);
    const final = path.join(VENDOR, `arthome-${name}-${digest}.tgz`);

    fs.renameSync(produced, final);

    // Older builds of the same package go, or vendor/ accumulates tarballs that
    // nothing references and the next reader cannot tell which one is live.
    // ⚠ AFTER the rename, never before: the file pnpm just produced is called
    //   `arthome-<name>-<version>.tgz`, which matches this very prefix — sweeping
    //   first deleted the thing about to be renamed.
    for (const old of fs.readdirSync(VENDOR)) {
      if (old.startsWith(`arthome-${name}-`) && old !== path.basename(final)) {
        fs.rmSync(path.join(VENDOR, old));
      }
    }
    packed.push({
      name,
      version: manifest.version,
      digest,
      file: path.basename(final),
      bytes: fs.statSync(final).size,
    });
  }

  const rewritten = rewriteManifests(packed);

  for (const p of packed) {
    console.log(
      `  @arthome/${p.name.padEnd(9)} ${p.version.padEnd(8)} ${String(Math.round(p.bytes / 1024)).padStart(5)} KB  -> vendor/${p.file}`,
    );
  }
  console.log(`pack-siblings: ${packed.length} package(s) from ${root}`);
  console.log(
    rewritten.length
      ? `  ${rewritten.length} manifest spec(s) rewritten: ${rewritten.join(', ')}`
      : '  every manifest already pointed at these builds',
  );
  console.log('  Run `pnpm install` to pick them up.');
  return 0;
}

process.exit(main());

#!/usr/bin/env node
// check-vendor-specs — every manifest points at the vendored tarballs, and at
// the right ones.
//
// WHY THIS GATE EXISTS AT ALL
//   The three @arthome/* packages are unpublished, so each manifest that needs
//   the domain repeats a path like `file:../../vendor/arthome-core.tgz`. That is
//   a parallel literal table under a common name — fault E2, applied to paths —
//   and the instrument built for exactly that, a pnpm catalog, cannot hold it:
//
//     ERR_PNPM_CATALOG_ENTRY_INVALID_SPEC — declares a dependency using the
//     'file' protocol. This is not yet supported.
//
//   So the repetition cannot be removed, and the answer is the one versions.json
//   already gives to the same shape of problem: keep the repetition, and put a
//   check behind it. What makes a parallel table dangerous is not that it
//   repeats, it is that nothing notices when one copy drifts.
//
// WHAT IT CHECKS, now that the tarballs are content-addressed
//   `pack-siblings` names each tarball after the first 12 hex of its sha256 and
//   rewrites every manifest to match, because a changing specifier is the only
//   invalidation pnpm honours for a `file:` dependency. This gate checks the
//   three ways that can come apart:
//     1. a manifest pointing at a tarball that is not there — someone pulled a
//        package.json without running `pnpm run bootstrap`;
//     2. two manifests pointing at DIFFERENT builds of the same package, which
//        installs two copies of the domain and breaks every `instanceof`;
//     3. a tarball whose contents no longer hash to the name it carries —
//        someone edited vendor/ by hand, and vendor/ is build output.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VENDORED = new Set(['@arthome/core', '@arthome/contracts', '@arthome/tooling']);
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function workspaceGlobs() {
  const file = path.join(REPO, 'pnpm-workspace.yaml');
  const globs = [];
  let inside = false;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
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

function manifests() {
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

function main() {
  const problems = [];
  const seen = new Map();
  let checked = 0;
  const files = manifests();

  for (const file of files) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const where = path.relative(REPO, file);
    for (const field of FIELDS) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (!VENDORED.has(name)) continue;
        checked += 1;

        if (!spec.startsWith('file:')) {
          problems.push(
            `${where} → ${field}.${name}\n    is ${spec}, expected a file: path into vendor/`,
          );
          continue;
        }

        const tarball = path.resolve(path.dirname(file), spec.slice('file:'.length));
        if (!fs.existsSync(tarball)) {
          problems.push(
            `${where} → ${field}.${name}\n    points at a tarball that is not there: ${path.relative(REPO, tarball)}\n    run \`pnpm run bootstrap\``,
          );
          continue;
        }

        // 2. one build per package across the whole repository
        const previous = seen.get(name);
        if (previous && previous.tarball !== tarball) {
          problems.push(
            `${where} → ${field}.${name}\n    points at ${path.basename(tarball)}\n    but ${previous.where} points at ${path.basename(previous.tarball)}\n    two builds of one package install two copies, and every instanceof fails`,
          );
        } else if (!previous) {
          seen.set(name, { where, tarball });
        }

        // 3. the name is a claim about the contents; check it
        const declared = /-([0-9a-f]{12})\.tgz$/.exec(path.basename(tarball))?.[1];
        if (!declared) {
          problems.push(
            `${where} → ${field}.${name}\n    ${path.basename(tarball)} carries no content hash — repack with \`pnpm run pack:siblings\``,
          );
          continue;
        }
        const actual = crypto
          .createHash('sha256')
          .update(fs.readFileSync(tarball))
          .digest('hex')
          .slice(0, 12);
        if (actual !== declared) {
          problems.push(
            `${where} → ${field}.${name}\n    ${path.basename(tarball)} hashes to ${actual}\n    vendor/ is build output and was edited by hand`,
          );
        }
      }
    }
  }

  if (problems.length) {
    console.error('check-vendor-specs: FAIL');
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log(
    `check-vendor-specs: ${checked} vendored spec(s) across ${files.length} manifest(s), ${seen.size} package(s)`,
  );
  console.log('PASS every @arthome/* dependency points at one existing, unaltered build');
  return 0;
}

process.exit(main());

#!/usr/bin/env node
// check-core-specs — every manifest points at ONE build of each @arthome/* package,
// and on develop and main that build is a GitHub release of arthome-core.
//
// TWO WAYS TO CONSUME arthome-core, ONE RULE FOR EACH
//   release  `pnpm run use-core <version>` writes the URLs of the release assets
//            (https://github.com/jubasse/arthome-core/releases/download/v<version>/
//            arthome-<package>-<version>.tgz). Checked: the URL has that shape, names
//            its own package, and every package and manifest agrees on the version.
//   local    `pnpm run bootstrap` packs a sibling checkout into vendor/ and writes
//            `file:` paths. A local build is for unreleased cross-repository work, so it
//            is refused where the code is shared: on develop and main, or anywhere with
//            --require-release (the pull request check passes it).
//   Mixing the two, or two versions, installs two copies of the domain and breaks
//   every instanceof.
//
// WHY `file:` IS REPEATED IN EVERY MANIFEST
//   pnpm refuses `file:` in a catalog (ERR_PNPM_CATALOG_ENTRY_INVALID_SPEC), so the
//   specs repeat per manifest, written by machine and checked here, as versions.json
//   does for the same shape of problem. A repetition is dangerous only when nothing
//   notices that one copy drifted.
//
// WHAT IT CHECKS ABOUT A LOCAL BUILD, now that the tarballs are content-addressed
//   `pack-siblings` names each tarball after the first 12 hex of its sha256, because
//   a changing specifier is the only invalidation pnpm honours for a `file:`
//   dependency. Three ways that can come apart:
//     1. a manifest pointing at a tarball that is not there: someone pulled a
//        package.json without running `pnpm run bootstrap`;
//     2. two manifests pointing at DIFFERENT builds of the same package;
//     3. a tarball whose contents no longer hash to the name it carries: someone
//        edited vendor/ by hand, and vendor/ is build output.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  ARTHOME_PACKAGES,
  DEPENDENCY_FIELDS,
  REPO,
  manifestPaths,
  parseReleaseAssetUrl,
} from './arthome-specs.mjs';

const SHARED_BRANCHES = new Set(['develop', 'main']);

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function releaseRequirement() {
  if (process.argv.includes('--require-release')) return '--require-release was passed';
  const branch = currentBranch();
  return SHARED_BRANCHES.has(branch) ? `the branch is ${branch}` : null;
}

function main() {
  const problems = [];
  const seen = new Map();
  const releaseVersions = new Set();
  const requirement = releaseRequirement();
  let checked = 0;
  const files = manifestPaths();

  for (const file of files) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const where = path.relative(REPO, file);
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of ARTHOME_PACKAGES) {
        const dependency = `@arthome/${name}`;
        const spec = manifest[field]?.[dependency];
        if (spec === undefined) continue;
        checked += 1;
        const at = `${where} -> ${field}.${dependency}`;

        const key = identifyBuild(spec, file, at, requirement, problems, releaseVersions);
        if (key === null) continue;

        const previous = seen.get(dependency);
        if (previous && previous.key !== key) {
          problems.push(
            `${at}\n    points at ${path.basename(key)}\n    but ${previous.where} points at ${path.basename(previous.key)}\n    two builds of one package install two copies, and every instanceof fails`,
          );
        } else if (!previous) {
          seen.set(dependency, { where, key });
        }
      }
    }
  }

  if (releaseVersions.size > 1) {
    problems.push(
      `release specs name ${releaseVersions.size} versions of arthome-core: ${[...releaseVersions].join(', ')}\n    one release per repository; run \`pnpm run use-core <version>\``,
    );
  }
  const fromRelease = [...seen.values()].filter((entry) => entry.key.startsWith('https://'));
  if (fromRelease.length && fromRelease.length !== seen.size) {
    problems.push(
      'some @arthome/* packages are consumed from a release and some from vendor/\n    run `pnpm run use-core <version>` or `pnpm run bootstrap` to make them one',
    );
  }

  if (problems.length) {
    console.error('check-core-specs: FAIL');
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  const source = releaseVersions.size
    ? `release v${[...releaseVersions][0]}`
    : 'a local build under vendor/';
  console.log(
    `check-core-specs: ${checked} @arthome/* spec(s) across ${files.length} manifest(s), ${seen.size} package(s), from ${source}`,
  );
  console.log('PASS every @arthome/* dependency points at one existing, unaltered build');
  return 0;
}

// The identity of the build a spec points at (the URL, or the tarball's path), or
// null after recording why the spec is not acceptable.
function identifyBuild(spec, manifestFile, at, requirement, problems, releaseVersions) {
  const name = /@arthome\/(\w+)/.exec(at)[1];
  const asset = parseReleaseAssetUrl(spec);
  if (asset) {
    if (asset.name !== name || asset.tagVersion !== asset.fileVersion) {
      problems.push(
        `${at}\n    ${spec}\n    does not name its own package and one version; rewrite it with \`pnpm run use-core <version>\``,
      );
      return null;
    }
    releaseVersions.add(asset.tagVersion);
    return spec;
  }
  if (!spec.startsWith('file:')) {
    problems.push(
      `${at}\n    is ${spec}, expected a release asset URL or a file: path into vendor/`,
    );
    return null;
  }
  if (requirement) {
    problems.push(
      `${at}\n    is ${spec}, a local build, and ${requirement}\n    run \`pnpm run use-core <version>\` to consume a release`,
    );
    return null;
  }
  const tarball = path.resolve(path.dirname(manifestFile), spec.slice('file:'.length));
  return checkLocalTarball(at, tarball, problems) ? tarball : null;
}

function checkLocalTarball(at, tarball, problems) {
  if (!fs.existsSync(tarball)) {
    problems.push(
      `${at}\n    points at a tarball that is not there: ${path.relative(REPO, tarball)}\n    run \`pnpm run bootstrap\``,
    );
    return false;
  }
  const declared = /-([0-9a-f]{12})\.tgz$/.exec(path.basename(tarball))?.[1];
  if (!declared) {
    problems.push(
      `${at}\n    ${path.basename(tarball)} carries no content hash; repack with \`pnpm run pack:siblings\``,
    );
    return false;
  }
  const actual = crypto
    .createHash('sha256')
    .update(fs.readFileSync(tarball))
    .digest('hex')
    .slice(0, 12);
  if (actual !== declared) {
    problems.push(
      `${at}\n    ${path.basename(tarball)} hashes to ${actual}\n    vendor/ is build output and was edited by hand`,
    );
    return false;
  }
  return true;
}

process.exit(main());

#!/usr/bin/env node
// generate-events — the Protobuf wire types, from arthome-core's proto/.
//
// WHY THE GENERATED CODE LIVES HERE AND NOT IN @arthome/contracts
//   events.md §7.3 says the producer serialises "with the registry serialiser
//   from @arthome/contracts", which reads as though the generated messages
//   belong to that package. They do not, and the repository split is what
//   decides it: @arthome/contracts holds the BOUNDARY DTOs, the zod schemas a
//   BFF and a browser share. Protobuf is the SERVICE-TO-SERVICE wire, and
//   events.md's own rule is that "Kafka is the only inter-service channel; a
//   synchronous call goes only from a BFF to a service". Every Kafka participant
//   — services and BFFs alike — lives in arthome-platform. The two web
//   repositories never see a Protobuf byte.
//
//   So shipping these types through a package consumed by browsers would put
//   the inter-service wire on the public boundary, and make every web install
//   carry it. They stay here, shared between the services that actually speak
//   the protocol. Recorded as a decision in arthome-core rather than diverged
//   from the document in silence.
//
// THE GENERATED FILES ARE COMMITTED
//   They are the contract this repository compiles against, and a diff on them
//   is the clearest possible statement that the wire changed. Regenerating is
//   `pnpm run gen:events`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT = path.join(REPO, 'libs', 'events', 'src', 'gen');

function protoRoot() {
  const explicit = process.env.ARTHOME_CORE;
  const candidates = explicit ? [explicit] : [path.resolve(REPO, '..', 'arthome-core')];
  for (const c of candidates) {
    const proto = path.join(c, 'proto');
    if (fs.existsSync(path.join(proto, 'buf.yaml'))) return proto;
  }
  console.error('generate-events: arthome-core/proto not found.');
  console.error(`  Looked in: ${candidates.map((c) => path.join(c, 'proto')).join(', ')}`);
  console.error('  Clone arthome-core next to this repository, or set ARTHOME_CORE.');
  return null;
}

function main() {
  const proto = protoRoot();
  if (!proto) return 1;

  // Regenerate from empty: a message deleted upstream must disappear here, and
  // a stale file that still compiles is the worst kind of survivor.
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  execFileSync('pnpm', ['exec', 'buf', 'generate', proto], { cwd: REPO, stdio: 'inherit' });

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(OUT, full));
    }
  };
  walk(OUT);

  if (files.length === 0) {
    console.error('generate-events: buf produced nothing. The proto root was found but is empty,');
    console.error(
      '  or the plugin failed silently. Refusing to report success over an empty tree.',
    );
    return 1;
  }

  console.log(`generate-events: ${files.length} file(s) from ${proto}`);
  for (const f of files.slice(0, 12)) console.log(`  ${f}`);
  if (files.length > 12) console.log(`  … and ${files.length - 12} more`);
  return 0;
}

process.exit(main());

// arthome-platform — the repository's ESLint configuration.
//
// The shape is the same in all seven repositories, and the order is the one
// thing that is not negotiable:
//   1. the common floor (@arthome/tooling)
//   2. the stack, which may turn things back on  <- NestJS arrives in wave 1
//   3. local overrides, each with its reason
//   4. eslint-config-prettier/flat, LAST
//
// `npx eslint-config-prettier <file>` verifies that 4 really did switch
// everything off. See docs/arthome/code-conventions.md sections 3.2 and 4.3.

import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';

import node from '@arthome/tooling/eslint/node';

export default defineConfig([
  globalIgnores([
    'apps/*/dist/**',
    'libs/*/dist/**',
    'vendor/**', // tarballs: build output of another repository
    'libs/events/src/gen/**', // protobuf-es output; typechecked, not linted
    'docs/**', // copied in on install; the originals live in arthome-core
  ]),

  // 1. the floor. Everything here runs under Node.
  ...node,

  // 3. local overrides
  {
    // The repository's own tools are standalone Node scripts: no TypeScript
    // project, and writing to standard output is their job.
    files: ['tools/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // Scoped to the entry points: stdout IS the log in a container. Anywhere else a
    // console call is a debug statement somebody forgot.
    files: ['apps/*/src/main.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // 4. LAST
  prettier,
]);

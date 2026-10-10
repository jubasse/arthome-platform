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

import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';

import node from '@arthome/tooling/eslint/node';

import { arthomePlatform } from './tools/eslint/plugin.mjs';

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
    // Workspace packages sort with the external packages whether or not libs/*/dist is built.
    // Left to the resolver they are internal with a dist and external without, and import-x/order
    // flips its verdict. This is the core rule's options plus one pathGroup.
    files: ['**/*.{ts,mjs}'],
    rules: {
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          pathGroups: [
            { pattern: '@arthome/**', group: 'internal', position: 'before' },
            { pattern: '@arthome-platform/**', group: 'external', position: 'before' },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          distinctGroup: false,
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  {
    // The repository's own tools are standalone Node scripts: no TypeScript
    // project, and writing to standard output is their job.
    files: ['tools/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // Scoped to the entry points and the consumer host they boot: stdout IS the log in a
    // container. Anywhere else a console call is a debug statement somebody forgot.
    files: [
      'apps/*/src/main.ts',
      'apps/*/src/consumer.ts',
      'libs/messaging/src/consumer-host.module.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // An allowance names what it silences and says why after `--`, where its reviewer reads it.
    plugins: comments.recommended.plugins,
    rules: {
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      '@eslint-community/eslint-comments/require-description': 'error',
    },
  },

  {
    // Tests and their harness pick their own time; the services read it through the Clock.
    files: ['apps/*/src/**/*.ts', 'libs/*/src/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.itest.ts', 'apps/*/src/itest/**', 'libs/testing/**'],
    plugins: { 'arthome-platform': arthomePlatform },
    rules: {
      'arthome-platform/no-wall-clock': 'error',
    },
  },

  {
    // A new use of a deprecated API fails, so what the contract model replaces cannot spread.
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-deprecated': 'error',
    },
  },

  // 4. LAST
  prettier,
]);

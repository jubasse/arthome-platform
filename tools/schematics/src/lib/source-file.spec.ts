import { describe, expect, it } from 'vitest';

import {
  addImports,
  addInterfaceMember,
  addNullCase,
  addToArrayProperty,
  addToCollection,
  compareModules,
  renderImports,
} from '#schematics/source-file';

/** Layout is Prettier's, run after every edit: the edits are compared on their tokens. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').replace(/ ,/g, ',');

describe('renderImports', () => {
  it('groups builtin, external, @arthome and relative imports, a blank line between groups', () => {
    expect(
      renderImports([
        { name: 'CLOCK', from: '../clock.js' },
        { name: 'Module', from: '@nestjs/common' },
        { name: 'SystemClock', from: '@arthome/core' },
        { name: 'join', from: 'node:path' },
        { name: 'Widget', from: './widget.aggregate.js' },
        { name: 'frozen', from: '@arthome-platform/transactions' },
      ]),
    ).toBe(
      [
        "import { join } from 'node:path';",
        '',
        "import { frozen } from '@arthome-platform/transactions';",
        "import { Module } from '@nestjs/common';",
        '',
        "import { SystemClock } from '@arthome/core';",
        '',
        "import { Widget } from './widget.aggregate.js';",
        "import { CLOCK } from '../clock.js';",
      ].join('\n'),
    );
  });

  it('merges a module’s value and type specifiers, the values first', () => {
    expect(
      renderImports([
        { name: 'EntityManager', from: 'typeorm', typeOnly: true },
        { name: 'DataSource', from: 'typeorm' },
        { name: 'Column', from: 'typeorm' },
      ]),
    ).toBe("import { Column, DataSource, type EntityManager } from 'typeorm';");
  });
});

describe('compareModules', () => {
  it('orders as import-x does, breaking its sibling-parent tie as the services write it', () => {
    expect(compareModules('./a.js', '../b.js')).toBeLessThan(0);
    expect(compareModules('../clock.js', './rigs/rig.entity.js')).toBeLessThan(0);
    expect(compareModules('@nestjs/cqrs', '@nestjs/common')).toBeGreaterThan(0);
  });
});

describe('addImports', () => {
  it('adds nothing a file already imports, and places a new relative import in order', () => {
    const text =
      "import { a } from './a.js';\nimport { c } from './c.js';\n\nexport const x = 1;\n";
    expect(addImports(text, [{ name: 'a', from: './a.js' }])).toBe(text);
    expect(addImports(text, [{ name: 'b', from: './b.js' }])).toContain(
      "import { a } from './a.js';\nimport { b } from './b.js';\nimport { c } from './c.js';",
    );
  });
});

describe('addToArrayProperty', () => {
  it('appends to a decorator’s array once, and creates the property when absent', () => {
    const text = '@Module({ imports: [A] })\nexport class M {}\n';
    const once = addToArrayProperty(text, { decorator: 'Module' }, 'imports', 'B');
    expect(addToArrayProperty(once, { decorator: 'Module' }, 'imports', 'B')).toBe(once);
    expect(once).toContain('imports: [A, B]');
    expect(flat(addToArrayProperty(text, { decorator: 'Module' }, 'providers', 'P'))).toContain(
      'imports: [A], providers: [P]',
    );
  });
});

describe('addToCollection', () => {
  it('appends to a Set or a Map literal once', () => {
    const text =
      "const PUBLISHERS = new Set(['identity']);\nconst CONSUMERS = new Map([['a', 'a']]);\n";
    const edited = addToCollection(
      addToCollection(text, 'PUBLISHERS', "'lighting'"),
      'CONSUMERS',
      "['lighting', 'lighting']",
    );
    expect(edited).toContain("new Set(['identity', 'lighting'])");
    expect(edited).toContain("new Map([['a', 'a'], ['lighting', 'lighting']])");
    expect(addToCollection(edited, 'PUBLISHERS', "'lighting'")).toBe(edited);
  });
});

describe('addInterfaceMember', () => {
  it('turns `type T = Base` into an interface extending Base, then adds to it', () => {
    const text = 'export type T = Base;\n';
    const first = addInterfaceMember(text, 'T', 'readonly a: A;');
    expect(first).toBe('export interface T extends Base {\nreadonly a: A;\n}\n');
    expect(addInterfaceMember(first, 'T', 'readonly b: B;')).toContain(
      'readonly a: A;\n\nreadonly b: B;',
    );
  });
});

describe('addNullCase', () => {
  it('falls through to the clause returning null, or returns null before default', () => {
    const text = `function wire(e: E) {
  switch (e.kind) {
    case 'A':
      return null;
    default:
      return never(e);
  }
}`;
    expect(flat(addNullCase(text, 'wire', "'B'"))).toContain("case 'B': case 'A': return null;");
    const noNull = text.replace("case 'A':\n      return null;", "case 'A':\n      return a(e);");
    expect(flat(addNullCase(noNull, 'wire', "'B'"))).toContain("case 'B': return null; default:");
  });
});

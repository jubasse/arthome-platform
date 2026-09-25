# Development conventions and tooling

> **Scope** — the seven Arthome repositories. This document says **how we write and how we tool**,
> not what the domain must guarantee.
>
> **Written 21 September 2026**, under **D-013** (common conventions, ESLint + Prettier) and
> **D-014** (`@arthome/tooling`). Every version quoted was read off the npm registry and the
> official documentation **on 21 September 2026** — §1 gives the readings and their sources.

---

## 0. What this document is, and what it is not

### The three documents and the line between them

| Document | Contents | Who reads it, when |
|---|---|---|
| `critical-rules.md` *(another teammate)* | The imperative **business** rules. Under twenty lines, copied into every repository. | Every session, in full. |
| `definition-of-done.md` *(another teammate)* | What makes a batch finished. | When closing a batch. |
| **`code-conventions.md`** *(this document)* | Style, naming, tooling, versions, automatic gates. | When creating a repository, on a version bump, when a red gate is not understood. |

A style convention **never** enters `critical-rules.md`: that file has to stay readable every
session, and twenty lines of business beat a hundred lines of indentation. When this document needs
a business rule it **refers**; it does not copy.

### The spirit: a written principle is not enough

`corrections-handoff.md` § E2 establishes this project's dominant failure mode: the **parallel
literal table**. Eight fields, five mockups, an explicit principle forbidding it — and the fault
committed anyway, every time, silently.

> **The lesson, applied to this document: every rule stated here must name the command that checks
> it.** A rule without a gate is an intention. §8 collects every gate into one table; each section
> above names its own along the way.

An accepted corollary: **this document prefers few checked rules to many hoped-for rules.** Where a
convention is desirable but not checkable at reasonable cost, it is filed as a "recommendation" and
marked as such, so that nobody tells themselves it is being upheld.

### Two context constraints that bear on everything else

1. **One person, seven repositories.** Any mechanism that must be maintained in seven copies will be
   abandoned. That is why `@arthome/tooling` exists (§4), and why this document refuses husky,
   lint-staged and commitlint in favour of two dependency-free git hooks (§8.4). ⚠ They were described as "ten-line" until 2026-09-25, when writing them showed the cost honestly: `pre-commit` is short, and `commit-msg` is 78 lines of which 18 are logic — the rest is the refusal message that teaches the shape, and the record of what it deliberately does not check. The argument was never brevity; it is that three packages, three configurations and three version bumps in seven copies buy nothing git does not already do.
2. **The account's GitHub Actions quota is exhausted.** No gate in this document assumes a remote
   runner. Everything runs locally, with the command given. When the quota returns, the workflow
   file will only have to call the same commands — which is why they all sit behind
   `pnpm run verify` (§8.2).

---

## 1. The verified state of versions — 21 September 2026

Read off `registry.npmjs.org` and the official documentation that day. **This table is the
reference; it goes stale.** §7.5 says how to rebuild it.

### 1.1 Cross-cutting tooling

| Package | Version | Verified note |
|---|---|---|
| `eslint` | **10.11.0** (`maintenance`: 9.39.5) | `eslintrc` **removed**; `eslint.config.*` is the only format. Node `^20.19 \|\| ^22.13 \|\| >=24`. Config file looked up **from the linted file's directory**, walking upward. |
| `prettier` | **3.9.8** (`next`: 4.0.0-alpha.13) | Prettier 4 is **in alpha**: we stay on 3.x. |
| `eslint-config-prettier` | **10.1.8** | Dedicated flat entry point since 10.1.1: `eslint-config-prettier/flat`. Handles `@stylistic` rules since 10.0.0. Peer: `eslint >=7`. |
| `typescript-eslint` | **8.70.0** | Peer: `eslint ^8.57 \|\| ^9 \|\| ^10`, **`typescript >=4.8.4 <6.1.0`**. |
| `eslint-plugin-import-x` | **4.17.1** | Peer: `eslint ^8.57 \|\| ^9 \|\| ^10`, `@typescript-eslint/utils ^8.56`. |
| `pnpm` | **12.5.1** | `minimumReleaseAge` has defaulted to **1440 minutes since pnpm 11**. `minimumReleaseAgeExclude` accepts patterns since 10.17. |
| `turbo` | **2.11.2** | Task cache only (D-005, README §3). |
| Node.js | **24.21.0 "Krypton" (LTS)** | The only line satisfying all seven repositories — see §7.2. |

### 1.2 The stacks, and what they actually constrain

**Constraint** = a `peerDependencies` entry or an observed refusal to run, not a preference.

| Repository | Stack (version read) | **Hard** TypeScript constraint | Source of the constraint |
|---|---|---|---|
| `arthome-studio-web`, `arthome-studio-mobile` | Angular 22.1.7 | **`>=6.0 <6.1`** | `@angular/compiler-cli@22.1.7` → `peerDependencies.typescript` |
| `arthome-platform` | NestJS 12 / `@nestjs/cli` 12.0.3 | **TS 6 in practice** | `nest build` **aborts** on TS 7 (`UNSUPPORTED_TYPESCRIPT_VERSION`): the CLI calls `getParsedCommandLineOfConfigFile`, an API absent from TS 7.0 |
| `arthome-storefront-web` | Next 16.3.5 | *none* coming from `next` | but `eslint-config-next@16.3.5` depends on `typescript-eslint ^8.46` → **`<6.1`** as soon as you lint |
| `arthome-storefront-mobile` | React Native 0.87.1 | **none** | `react-native@0.87.1` has **no** `typescript` peer |
| `arthome-storefront-tv` | react-native-tvos 0.87.1-1 | **none** | same |
| *any repository linting with type-aware rules* | — | **`>=4.8.4 <6.1.0`** | `typescript-eslint@8.70.0` → `peerDependencies.typescript` |

Available TypeScript versions: **`typescript@6.0.3`** (last 6.0.x, published 2026-04-16) and
**`typescript@7.0.2`** (`latest`). Microsoft also publishes **`@typescript/typescript6@6.0.2`**, an
official package — maintainers `typescript-bot`, `andrewbranch`, `jakebailey` — which exposes the
`tsc6` binary and exists to let the two compilers coexist (§2.5).

### 1.3 A correction to D-014's table

D-014 carries a table of pins. Checked package by package, **two of its four rows need correcting**.
This does not reopen the decision — D-014 explicitly asked me to verify — but the consequence
changes.

| D-014 row | What is verified | Effect |
|---|---|---|
| Angular 22 → TS `>=6.0 <6.1` | ✅ **exact**, it is a hard `peerDependencies` entry | unchanged |
| Angular 22 → Vitest `^4.0.8` | ✅ exact (Vitest publishes 5.0.1 as `latest`, 4.1.11 as `V4`) | unchanged |
| React 19.3 → TS **`7.0.2`** | ❌ **this is not a constraint.** `react-native@0.87.1` has no `typescript` peer; `@types/react@19.3.0` carries `typesVersions: {"<=5.0": …}`, so **TS 5.1+ is enough**. `7.0.2` is what `npm latest` returned when the `react-how-to` router was verified — a registry observation, not a floor. | **the split is not forced on us** |
| NestJS 12 → "not pinned" | ❌ **NestJS is the most constrained of the four.** `nest build` fails on TS 7.0 whichever builder is used (`tsc`, `swc`, `rspack`). | **the backend sits on the TS 6 side** |

**The consequence, and it is the hinge of all of §2:** the TypeScript 6 / 7 split is not a fate
imposed by React. **The only hard floor is Angular's ceiling** (`<6.1`), and NestJS and
`typescript-eslint` join it there. Nothing pushes upward.

But the split **will happen**: `typescript@7.0.2` is already `latest`, an absent-minded
`pnpm add typescript` installs it, and the two React Native repositories could adopt it overnight
without breaking anything obvious — until the type-aware lint falls over. So the publication
constraint D-014 states is correct; it was its cause that was misattributed. §2 handles it exactly as
D-014 asks.

---

## 2. The TypeScript split — the structuring constraint

### 2.1 What is actually at stake

`@arthome/core` and `@arthome/contracts` are published once and consumed by seven repositories.
Their `.d.ts` files are the contract. If a consumer cannot read them, it cannot build — and the
error shows up **at the consumer**, not at the publisher, which is the worst place to discover it.

Three distinct questions, often conflated:

1. **Which version do we compile the shared packages with?** → §2.3
2. **Which version does each repository install?** → §2.2
3. **How do we prove the published `.d.ts` pass under both?** → §2.4

### 2.2 The decision: TypeScript 6.0.3 for the fleet

**All seven repositories install `typescript@6.0.3`, exactly pinned (no `^`, no `~`).**

The reasons, strongest first:

1. **Angular cannot move.** `>=6.0 <6.1` is a `peerDependencies` entry of
   `@angular/compiler-cli`. Two repositories out of seven are nailed there, and Angular 23 does not
   exist.
2. **NestJS cannot move either.** `nest build` aborts on TS 7.0.
3. **Type-aware linting cannot move.** `typescript-eslint@8.70.0` caps at `<6.1.0`. And type-aware
   linting is **the reason Biome was ruled out** (D-013): `no-floating-promises`,
   `no-misused-promises` and `await-thenable` only exist because a type checker is wired in.
   Adopting TS 7 on a repository switches those rules off **on that repository** — and the TS 7
   support request opened against `typescript-eslint` on the day 7.0.2 shipped was **closed "not
   planned"**, for lack of a TypeScript 7 API to attach to. That API is expected in 7.1.
4. **Nothing pushes the other way.** React Native, React and Next require nothing above TS 5.1.
   Adopting TS 7 on the two React Native surfaces would be a choice, not a necessity — and it would
   cost type-aware linting on the two surfaces most constrained in memory and performance, which are
   exactly the ones where an orphaned promise costs the most.

**What TypeScript 7 brings, and what it does not.** 7.0 is a **Go port** of the compiler:
"methodically ported from our existing implementation rather than rewritten from scratch", with
checking logic "structurally identical to TypeScript 6.0", roughly ten times faster. It **adds no
type syntax**. It hardens 6.0's deprecations into errors and adopts its new defaults
(`strict: true`, `module: esnext`, `types: []`, `rootDir: "./"`, `stableTypeOrdering: true` and not
disableable). And it **ships no programmatic API** — hence `typescript-eslint`'s refusal, and hence
the NestJS CLI failure.

> **So:** D-014's worry — "their public types must forbid any syntax specific to TS 7" — has no
> object in the literal sense: **there is no syntax specific to TS 7**. The real danger is
> elsewhere, and §2.3 handles it: it is the **compiler options** and the **type emission order**,
> not the grammar.

### 2.3 How `@arthome/core` and `@arthome/contracts` are compiled

Four rules, all checkable.

**a. Compile with the oldest compiler in the fleet: `typescript@6.0.3`.**
A `.d.ts` emitted by 6.0 is read by 7.0 — checking is structurally identical and 7.0 accepts 6.0's
output. The reverse is guaranteed by nobody. So we always emit with the lowest, never the highest.
A general rule, not a circumstantial one: **a shared package compiles with its consumers' floor.**

**b. `"stableTypeOrdering": true` in the two packages' build tsconfig — and nowhere else.**
TypeScript assigns internal ids to types in the order it meets them, and sorts unions by those ids.
Adding a `const` above a function can therefore **reverse a union's order in the emitted `.d.ts`**,
without a single line of the type having changed. TypeScript 7 uses deterministic, content-based
ordering; `--stableTypeOrdering`, introduced in 6.0, makes 6.0 adopt 7.0's ordering.

Two benefits, both measurable: published `.d.ts` files become **reproducible** (a diff in `dist/`
means a real contract change, not an accident of declaration order), and they are **already what
7.0 would emit**, so the future migration will not produce a false contract change across seven
repositories at once.

The stated cost is up to **25% more checking**. That is why the option is confined to the
`tsconfig/lib.json` of the **two published packages** — a few hundred files, built rarely — and
**forbidden** in application tsconfigs, where it would slow every type check for nothing.

**And it is forbidden for a second reason, harder than performance**: it is the **only option in
the whole setup that does not exist on both sides of the split.** Under TypeScript 7 the
deterministic ordering "is `true` by default, and cannot be turned off". So it descends only into
the base file TypeScript 7 will never read. The full reasoning, and the three base files that
follow from it, are in **§4.4**.

**c. `"isolatedDeclarations": true` on the two published packages.**
This option refuses any export whose type cannot be written without inferring through the function
body. It forces **explicit annotation of the entire public surface**. Three effects, all aligned
with this project:

- the `.d.ts` stops depending on inference subtleties that could diverge between two compilers —
  that is the real "readable by both" guarantee, far more than any syntax ban;
- the public surface becomes readable without opening the implementation, which is exactly what one
  wants from a contracts package;
- errors appear **at the publisher**, when the package is built, and not at the consumer.

This is the highest-return constraint in this section, and it is new to the project: take it as an
addition, not a reminder.

**d. Targets and module format, written rather than inferred.**
TypeScript 6.0 changed its defaults: `types` is now `[]` (no longer "every `@types` package found"),
`rootDir` is `"."`, `module` is `esnext`, `target` is the year's ES version, `strict` is `true`,
`noUncheckedSideEffectImports` is `true`. `--baseUrl`, `--moduleResolution node`,
`--moduleResolution classic`, `target: es5` and `--outFile` are removed or deprecated.

A `tsconfig` that leaned on the old defaults behaves differently without having changed.
`@arthome/tooling`'s base files **write all of these options explicitly**, including those that
coincide with the current default: a default is not a decision, and the next major can change it.

For the two published packages: `target: "es2022"`, `module: "nodenext"`,
`moduleResolution: "nodenext"`, `lib: ["es2022"]`, `types: []`. `es2022` and no higher because
Metro, Hermes and the TV's JavaScript engine are the most rustic consumers of the lot, and because
`@arthome/core` forbids itself any platform dependency (README §3) — therefore also any syntax one
of its hosts cannot digest. `types: []` because a domain package that accidentally picks up Node's
types has stopped being agnostic, and that only shows when a browser consumer compiles.

### 2.4 The proof: compiling the `.d.ts` against both versions

D-014 is explicit — this is the only accepted proof. It mechanises into one command and depends on
no remote runner.

**The principle.** After building `@arthome/core` and `@arthome/contracts`, we write a tiny probe
file that **imports each package's public surface**, then type-check it twice: once with
`typescript@6.0.3`, once with `typescript@7.0.2`. We do not compile the source twice — we compile
**the published contract**, as a consumer will see it.

In `arthome-core`, a `tools/dts-check/` workspace that nothing publishes:

```
tools/dts-check/
├── package.json         # devDeps: typescript@6.0.3, @typescript/native@npm:typescript@7.0.2
├── tsconfig.json        # extends @arthome/tooling/tsconfig/base.json ; skipLibCheck: false
└── src/probe.ts         # export * from '@arthome/core'; export * from '@arthome/contracts';
```

The **three** points that make this gate prove something:

- **`"skipLibCheck": false`.** That is the whole gate. With `skipLibCheck: true` — the default in
  many templates — TypeScript **does not check `.d.ts` files**, and the gate becomes a test that
  always passes.
- **we check `dist/`, not `src/`.** The `package.json` `exports` must point at the built `.d.ts`. A
  pnpm workspace link resolving to sources short-circuits exactly what we want to measure. So in a
  pnpm workspace `probe.ts` imports by package name (`@arthome/core`) and never by a relative path.
- **the probe extends `@arthome/tooling/tsconfig/base.json`.** This is not a convenience: it makes
  step 3 check **two** things — that the `.d.ts` pass under TypeScript 7, *and* that the base file
  shared by all seven repositories is still readable by TypeScript 7. The day someone adds a TS-6-only
  option to the base, this gate goes red the same day (§4.4.3).

The commands, run from `arthome-core`:

```bash
# 1. build the published packages (emits dist/**/*.d.ts)
pnpm -r --filter "@arthome/core" --filter "@arthome/contracts" run build

# 2. the contract as TypeScript 6.0.3 sees it — Angular's, NestJS's and the type-aware lint's
pnpm --filter dts-check exec tsc --noEmit

# 3. the same contract as TypeScript 7.0.2 sees it — tomorrow's
pnpm --filter dts-check exec tsgo --noEmit     # binary from @typescript/native

# 4. reproducibility: rebuilding must change nothing
git diff --exit-code -- packages/*/dist/**/*.d.ts
```

Step 4 is the complement of `stableTypeOrdering`: if the `.d.ts` move while nothing in the code has
changed, either the option is not active or a tool version has slipped. It assumes the two published
packages' `dist/` is **tracked by git** — an accepted choice here, against the usual practice,
because it is what makes a contract change **visible in a review** rather than in an incident at a
consumer. The cost is a few noisy diffs; the benefit is that `@arthome/contracts` can no longer
change in silence.

The four failures worth being able to read:

| Symptom | Cause | What to do |
|---|---|---|
| step 2 passes, step 3 fails **on a type** | we used behaviour that 7.0 hardened into an error | fix the package, not the gate |
| step 2 passes, step 3 fails **on the configuration** (`TS5023` or a rejected option) | a TS-6-only option was added to `tsconfig/base.json`, which must remain the intersection | move it into `tsconfig/lib.json` (§4.4.2) |
| step 3 passes, step 2 fails | the package was compiled with 7.0 by mistake | check which `tsc` ran (§2.5) |
| step 4 fails with no source change | `stableTypeOrdering` inactive, or a `typescript` version has moved | compare versions before touching code |

### 2.5 Running both compilers side by side, when necessary

`tools/dts-check/` needs both TypeScripts at once. Microsoft publishes `@typescript/typescript6` for
this, which installs the **`tsc6`** binary — enabling the reverse setup too, useful the day a
repository has to move to 7 before its tools follow:

```json
{
  "devDependencies": {
    "typescript": "npm:@typescript/typescript6",
    "@typescript/native": "npm:typescript@^7"
  }
}
```

`require('typescript')` then resolves TypeScript 6 — what the NestJS CLI and `typescript-eslint`
load — while `npx tsc` runs TypeScript 7.

**Two warnings, both verified:**

- `@typescript/typescript6` is published at **6.0.2** while `typescript` is at **6.0.3**. The alias
  therefore moves you back one patch. Accept that knowingly, not by accident.
- **In a pnpm workspace, never mix TS 6 and TS 7 across packages**: the NestJS Swagger plugin
  resolves whichever TypeScript is hoisted first and fails. **One TypeScript version per
  repository** for anything a CLI loads. `tools/dts-check/` is the only tolerated exception, because
  nothing calls it from a CLI and nothing publishes it.

### 2.6 When Angular moves up

This is D-014's last question, and it has a simple answer because §2.3 and §2.4 were paid for in
advance.

**What triggers the switch** — the three conditions, in this order:

1. TypeScript **7.1** ships the announced programmatic API ("we expect TypeScript 7.1 to ship with
   a new (and different) API");
2. `typescript-eslint` ships a version accepting `typescript >=7.1` — this is the deciding
   condition, because it governs type-aware linting in all seven repositories;
3. `@angular/compiler-cli` ships a major whose `typescript` peer covers 7.x — the day Angular 23
   does, the fleet's ceiling disappears.

**What then happens**, and what does not:

- the published `.d.ts` **do not change**: they are already emitted in 7.0's order
  (`stableTypeOrdering`), with a fully annotated surface (`isolatedDeclarations`), and the §2.4 gate
  already validates them under 7.0.2. The switch does not reopen the contract;
- the §2.4 gate **inverts**: `typescript@7.x` becomes step 2 and the old floor becomes step 3, for
  as long as a consumer stays behind;
- on the configuration side, **exactly one line disappears**: `stableTypeOrdering` in
  `tsconfig/lib.json`, now pointless since 7.0 always applies it. That is all, because
  `tsconfig/base.json` and `tsconfig/app.json` are already valid under 7.0 by construction (§4.4.2);
- the switch happens **repository by repository**, in the order of §7.3, and never more than one
  repository in transit;
- `nest build` follows last, because 7.1 support in `nest-cli` (PR #3554) was still **on hold** on
  21 September 2026: re-check before touching it.

**What not to do in the meantime**: install `typescript@latest` on a repository "just to see".
`latest` is 7.0.2. §7.4 makes a gate of it.

---

## 3. ESLint and Prettier — the division of responsibility

This is D-013's constraint number one. It is treated here as a **requirement**: every claim in this
section ends with the command that checks it.

### 3.1 The rule, in one sentence

> **Prettier owns formatting. ESLint owns code quality only. Zero overlap.**

| | Prettier | ESLint |
|---|---|---|
| **Owns** | quotes, semicolons, width, indentation, trailing commas, line breaks, arrow parentheses, brace position | orphaned promises, `any`, unused variables, import cycles, import order, hooks rules, template rules, accessibility |
| **Never touches** | the meaning of the code | a single decision about appearance |
| **Command** | `prettier --check .` | `eslint .` |
| **Fixes with** | `prettier --write .` | `eslint --fix .` |

The two commands are **sequential and independent**. They are never nested. This is exactly what
Prettier's documentation describes as the healthy setup: "if you run `eslint --fix` and
`prettier --write` as separate steps".

### 3.2 `eslint-config-prettier`, and why its position decides everything

`eslint-config-prettier` **switches off** every ESLint rule that touches formatting. In flat config,
ESLint applies objects **in array order**: a later object overrides an earlier one. Placed before a
preset, `eslint-config-prettier` therefore switches off nothing that preset will turn on afterwards
— it is simply inert, **silently**.

**It is the last element of the array, without exception.** The exact shape, with the dedicated flat
entry point introduced in 10.1.1:

```js
// eslint.config.js — the shape, in all seven repositories
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';   // ⚠ /flat, not the root

export default defineConfig([
  globalIgnores(['dist/**', 'coverage/**', '**/generated/**']),
  // … everything else: floor, stack presets, local overrides …
  prettier,                                            // ⚠ LAST, always
]);
```

Two traps, both verified:

- **`eslint-config-prettier` (root) versus `eslint-config-prettier/flat`.** Both exist in 10.1.8.
  The `/flat` entry carries a `name` field, which ESLint's config inspector expects; the root was
  kept as it was so as not to break existing setups. In flat config, import **`/flat`**.
- **A stack preset can carry its own copy.** That is the case for
  `@react-native/eslint-config@0.87.1`, which depends on `eslint-config-prettier@^8.5.0` — a copy at
  **major 8**, sitting in the middle of the array, knowing nothing of the `@stylistic` rules. Our
  10.1.8 copy placed **last** takes back control; the §3.5 gate is what **proves** it, and this is
  precisely the "a linter installed twice in two versions" scenario D-014 feared.

### 3.3 `eslint-plugin-prettier` is forbidden

Banned in all seven repositories. This is not a preference: it is the setup that **creates** the
conflicts we want to avoid. The reasons, as Prettier's own documentation gives them:

1. "You end up with a lot of red squiggly lines in your editor, which gets annoying. Prettier is
   supposed to make you forget about formatting – and not be in your face about it!"
2. "They are slower than running Prettier directly."
3. "They're yet one layer of indirection where things may break."

These plugins "were especially useful when Prettier was new"; today `prettier --check .` is enough
and every editor worth using knows how to call Prettier.

**The same ban applies in the other direction** — and this is the case people forget: a **Prettier
plugin doing a linter's job** is the same fault, mirrored.

| Forbidden | Why |
|---|---|
| `eslint-plugin-prettier` | Prettier turned into an ESLint rule |
| `prettier-plugin-organize-imports` | Prettier starts **sorting imports**, in direct competition with `import-x/order` (§5.5): two tools, two orders, a `--fix` war |
| `@trivago/prettier-plugin-sort-imports` | same |
| `@stylistic/eslint-plugin` | ESLint handed formatting back, which is exactly what `eslint-config-prettier` exists to switch off |

> **Worth noting, because it is counter-intuitive**: Prettier **does not sort** imports, and that is
> deliberate. Import order is therefore **not** a shared domain — it belongs entirely to ESLint, and
> `import-x/order` creates no conflict. That holds only as long as no sorting plugin is installed on
> the Prettier side. Hence the ban above: it does not protect against a disagreement about style, it
> protects against **reintroducing an overlap** where there is none.

### 3.4 `arrow-body-style` and `prefer-arrow-callback`

These are the two rules D-013 asks to be named. Their exact situation:

- **They are not formatting rules.** `eslint-config-prettier` therefore does not switch them off,
  and that is correct: they decide the **shape of the code**, not its appearance.
- **They only cause problems combined with `eslint-plugin-prettier` and `--fix`**, where the two
  fixers hand the same file back and forth. The documentation is explicit: "These rules are safe to
  use if you don't use `eslint-plugin-prettier`."
- **`eslint-plugin-prettier` being forbidden (§3.3), the problem does not exist here.**

**What we do about them, decided:**

| Rule | Status | Reason |
|---|---|---|
| `arrow-body-style` | **off** | It imposes a shape where the author has a reason to choose: a braced body often signals that a line is about to be added, and its `--fix` produces diffs unrelated to the change in progress. No defect is caught. |
| `prefer-arrow-callback` | **off** | Same reason, and it collides with named functions passed as callbacks, which are a legitimate choice for call-stack readability. |

They appear **explicitly** in `@arthome/tooling`'s base configuration, with this comment — rather
than merely left off by omission. A rule you decide not to apply must be written down: otherwise,
the day a preset turns it on, nobody will know whether that was intended.

```js
// @arthome/tooling — extract from the base ESLint configuration
{
  rules: {
    // Neither is a formatting rule: eslint-config-prettier does not switch them
    // off, and that is correct. They only become harmful together with
    // eslint-plugin-prettier, which is forbidden here (§3.3). We switch them off
    // because they arbitrate a style without catching a defect — not out of fear
    // of a conflict.
    'arrow-body-style': 'off',
    'prefer-arrow-callback': 'off',
  },
}
```

### 3.5 The gate: the overlap must be empty

**This is the central gate of this document.** It does not check an opinion; it **enumerates** the
still-enabled rules that conflict with Prettier. It must return an empty list, in every repository.

```bash
pnpm exec arthome-check-prettier-conflict
```

Expected output: `PASS no ESLint rule conflicts with Prettier`.
Anything else is a failure — and, at that point, **a line to add to the `rules` object at the end of
the array, never a reason to move `eslint-config-prettier`**.

**Why a wrapper rather than `npx eslint-config-prettier <file>`.** The specification first said to
call the upstream CLI directly. Running it proved that will not work, for two reasons, and both are
consequences of decisions made elsewhere in this document:

1. `eslint-config-prettier` is a **peer** of `@arthome/tooling`, declared by each repository (§4.2).
   Before that correction it was a dependency of the tooling package, and its binary was therefore
   **not on the repository's path**: `pnpm exec eslint-config-prettier` answered "Command not
   found". Found by running it, not by reading it.
2. ESLint 10 looks its configuration up **from the linted file's directory upward**, so in a
   workspace a root file and a package file do not necessarily resolve to the same configuration.
   The gate must therefore pass **one file per configuration family** — which the upstream CLI
   cannot do in a single call.

The wrapper resolves the upstream CLI through `eslint-config-prettier/package.json` rather than
through a deep path into `bin/`, because that package's `exports` map lists `.`, `./flat`,
`./prettier` and `./package.json` and nothing else — a deep path is blocked by the exports map,
exactly as §4.4.4 says it should be.

Four points that make the gate reliable rather than reassuring:

1. **The file matters.** The tool queries the configuration *resolved for that file* (see reason 2
   above). The gate therefore passes one file per configuration **family**, not one file for the
   whole repository.
2. **It must run after every preset is added.** A new stack preset can turn a formatting rule back
   on without saying so. This is the only way to notice, short of seeing a strange diff three weeks
   later.
3. **It must run after every ESLint or plugin bump**, for the same reason.
4. **It is in `pnpm run verify`** (§8.2). A gate you run when you think of it is not a gate.

The wrapper's default probe list covers the plausible families; a repository with an unusual layout
passes its own list as arguments. If **no** probe file exists, the gate exits 2 rather than 0 —
because a gate that checks nothing while reporting success would be the most dangerous file in the
repository.

| Repository | Representative files |
|---|---|
| `arthome-core` | `eslint.config.js`, `packages/core/src/index.ts`, `packages/tooling/eslint/base.js` |
| `arthome-platform` | `services/identity/src/main.ts`, `services/identity/src/app.module.ts` |
| `arthome-storefront-web` | `src/app/page.tsx`, `src/lib/api.ts` |
| `arthome-storefront-mobile`, `-tv` | `src/App.tsx`, `src/lib/api.ts` |
| `arthome-studio-web`, `-mobile` | `src/app/app.ts`, `src/app/app.html` |

### 3.6 What Prettier owns, written once

The Prettier configuration lives in `@arthome/tooling` and is **never redefined** by a repository
(§4.5). Its contents:

```js
// @arthome/tooling/prettier — the fleet's Prettier configuration
export default {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  arrowParens: 'always',
  bracketSameLine: false,
  bracketSpacing: true,
  quoteProps: 'as-needed',
  endOfLine: 'lf',
  overrides: [
    { files: '*.md', options: { proseWrap: 'always' } },
    { files: ['*.json', '*.jsonc'], options: { trailingComma: 'none' } },
    { files: ['*.yaml', '*.yml'], options: { singleQuote: false } },
  ],
};
```

A repository consumes it with one line of its `package.json`:

```json
{ "prettier": "@arthome/tooling/prettier" }
```

Two choices deserve their reason; the rest is arbitrary and knows it:

- **`printWidth: 100`.** 80 wraps perfectly readable TypeScript signatures and RxJS method chains;
  120 makes side-by-side diffs unreadable on a laptop. 100 is the compromise, and it is the same
  everywhere so that moving code between repositories reformats nothing.
- **`endOfLine: 'lf'`.** The one setting where a different default would produce a whole-file diff.
  Backed by `* text=auto eol=lf` in a `.gitattributes` present in all seven repositories: Prettier
  fixes the file, git stops it arriving in the first place.

**The Angular trap, to be handled in the two Angular repositories.** Prettier binds the `angular`
parser — the one that knows how to format `@if`, `[prop]`, `(event)`, `{{ … }}` — to the
**`.component.html`** extension only. And Angular 20+ **dropped the `.component` suffix**: the
template is now called `user-profile.html`. Prettier then falls back to the generic `html` parser,
which formats the markup but **leaves the binding expressions untouched** — no error, no warning.

So the two Angular repositories add, in their local `.prettierrc.mjs`, the only permitted Prettier
override:

```js
import base from '@arthome/tooling/prettier';

export default {
  ...base,
  overrides: [
    ...base.overrides,
    // Angular 20+ removed the `.component` suffix, and Prettier binds the
    // `angular` parser to `.component.html` only. Without this, binding
    // expressions are not formatted — silently.
    { files: 'src/app/**/*.html', options: { parser: 'angular' } },
  ],
};
```

`index.html` stays outside the pattern: it is an HTML document, not a template.

### 3.7 What Prettier does NOT own: prose

Measured rather than assumed, and it corrects this document's own first draft.

Running Prettier across `architecture/` rewrites **all fifteen** documents. The cause is not
`proseWrap` — it is **Markdown table padding**. Prettier pads every cell to the column width, so a
table whose cells hold sentences produces source lines several hundred characters long. Two
consequences, both bad: the source becomes unreadable in an editor, and a later edit to one cell
reflows the whole table, so the diff no longer shows what changed.

**So Markdown is excluded, in `.prettierignore`, in all seven repositories.** This is a deliberate
scope boundary, not an oversight: these documents are read and reviewed by humans, and their line
structure is authorial — a line per clause is what makes a prose diff reviewable.

"Prettier owns formatting" means **code** formatting. The `.prettierignore` also excludes
`prototypes/` (the five mockups, reproduced as they are, README §3), `docs/` (the handoff dossier,
corrected in place but not ours to restyle), the lockfile and every generated directory.

**And it does not own a generated artefact's target either — the same boundary, one category further
out.** `openapi/storefront.yaml` and `openapi/studio.yaml` are the **target** that
`@arthome/contracts` must emit, and the moment of truth for that package is `contracts:emit`
producing an **empty diff** against them. That makes their byte-level formatting a property of the
**emitter**, not of the formatter: if Prettier restyles them, the emitter has to learn to reproduce
Prettier's YAML style, or the diff is never empty.

This one was not reasoned out in advance. It was written after a repository-wide `prettier --write`
reflowed `storefront.yaml` while another agent was mid-translation — single quotes to double, flow
mappings exploded, about seven hundred lines of growth — which moved every line number that agent
was holding by up to 835 and destroyed **151 keys**. The document stopped parsing. It was recovered
in full by rebuilding from `HEAD` and re-applying all 514 translations keyed on **token signatures
instead of line numbers**, which is the more durable technique and is now the one to use.

Three lessons, and only the first is about Prettier:

1. **A file that is a target is owned by whatever produces it.** Ask "what would have to change if
   this file were reformatted?" — if the answer is "a generator", the generator owns the format.
2. **Keying an edit on line numbers is keying it on someone else's restraint.** Token signatures
   survive a reformat; line numbers do not survive anything.
3. **The reformat itself was the fault, not the file.** That is §8.5.

---

## 4. `@arthome/tooling` — the configuration package

`arthome-core`'s third published package, alongside `@arthome/core` and `@arthome/contracts`
(D-014). It carries ESLint, Prettier, TypeScript and Vitest.

### 4.1 What it exposes

No `"."` entry point. That is deliberate: nothing in an application's `src/` must be able to import
this package (§4.7).

```json
{
  "name": "@arthome/tooling",
  "type": "module",
  "exports": {
    "./eslint/base":        "./eslint/base.js",
    "./eslint/node":        "./eslint/node.js",
    "./eslint/browser":     "./eslint/browser.js",
    "./prettier":           "./prettier.js",
    "./vitest":             "./vitest.js",
    "./tsconfig/base.json": "./tsconfig/base.json",
    "./tsconfig/lib.json":  "./tsconfig/lib.json",
    "./tsconfig/app.json":  "./tsconfig/app.json"
  }
}
```

| Entry point | Contents | Who extends it |
|---|---|---|
| `./eslint/base` | flat array: JS recommended, `typescript-eslint` (type-aware), `import-x`, the §5 rules. **Contains no formatting rule.** | all seven |
| `./eslint/node` | `base` + Node globals, service rules | `arthome-platform`, tooling scripts |
| `./eslint/browser` | `base` + browser globals | the five applications |
| `./prettier` | the object from §3.6 | all seven |
| `./tsconfig/base.json` | the TS 6 / TS 7 **intersection**, every option written, **no path** (§4.4) | all seven |
| `./tsconfig/lib.json` | `base` + `declaration`, `isolatedDeclarations`, **`stableTypeOrdering`** — the one file TS 7 will never read (§4.4.2) | `@arthome/core`, `@arthome/contracts` |
| `./tsconfig/app.json` | `base` + `noEmit`, `moduleResolution: "bundler"` | the five applications |
| `./vitest` | a **bare object**, not a `defineConfig` (§4.2) | all seven |

**Three ESLint entry points and not one.** A single entry would force browser globals into the
services and vice versa, and globals are exactly what produces the false positives that make someone
switch a rule off — and then forget to switch it back on.

**Three `tsconfig` files and not one** — that is the question the project lead raised, and it has its
own section: **§4.4**. The `./tsconfig/*.json` subpaths are listed in `exports` **including the
extension**, because `extends` honours `exports` (§4.4.4) — and the files must in addition appear in
the `package.json` `files` field, or they are simply not published.

**And four `bin` entries**, the gates this package supplies to the other six repositories:
`arthome-check-enums` (§5.3), `arthome-check-versions` (§7.4), `arthome-check-tsconfig` (§4.5.1) and
`arthome-check-prettier-conflict` (§3.5). Each exists for the same reason: its reference table must
live in **exactly one place**.

### 4.2 `dependencies` versus `peerDependencies`

D-014 names the trap: "a linter installed twice in two versions is a classic". The dividing line is
sharp and fits in one question: **does the repository name this package itself?**

```json
{
  "peerDependencies": {
    "@eslint/js":             "^9.39.5 || ^10.0.1",
    "eslint":                 "^9.39.5 || ^10.11.0",
    "eslint-config-prettier": "10.1.8",
    "prettier":               "^3.9.8",
    "typescript":             "6.0.3"
  },
  "dependencies": {
    "typescript-eslint":                 "8.70.0",
    "eslint-plugin-import-x":            "4.17.1",
    "eslint-import-resolver-typescript": "4.4.5",
    "globals":                           "16.4.0"
  },
  "devDependencies": {
    "@eslint/js":             "10.0.1",
    "eslint":                 "10.11.0",
    "eslint-config-prettier": "10.1.8",
    "prettier":               "3.9.8",
    "typescript":             "6.0.3"
  }
}
```

**The `devDependencies` block is not decoration, and leaving it out cost us a real defect.** A
package that declares a peer must ALSO pin it in its own `devDependencies`. Without that,
`@arthome/tooling` being a workspace package, pnpm auto-installs a peer for it and picks the
**lowest** member of the range: `eslint@9.39.5`, while the repository root had `10.11.0`. Two ESLint
copies, both working, differently — precisely the failure this whole split exists to prevent, and
nothing was red. It was found by running `pnpm why eslint` after the first install, not by reading
the file. §7.4 now carries the gate that catches it.

**`@eslint/js` is a peer, and that is not a detail** — it is the case that makes this section's rule
concrete. It publishes **one major per ESLint major** (10.0.1 opposite ESLint 10, 9.39.5 opposite
ESLint 9). Pinning it in `dependencies` would therefore indirectly impose an ESLint major on all
seven repositories — and would break precisely the two nailed to ESLint 9 by
`@react-native/eslint-config` (§6.3). It tracks `eslint`, so it is a peer like `eslint`.

**`eslint-config-prettier` is a peer too, and this document had it wrong at first.** It was filed
under `dependencies`, on the grounds that the tooling package imports its plugins by value. But
`eslint-config-prettier/flat` is imported **by the repository's own `eslint.config.js`** — it has to
be, because it must be LAST, after the repository's stack presets. So the repository names it, and
by this section's own test it is a peer. Filed as a dependency, its binary was not on the
repository's path and the root `eslint.config.js` could not resolve it at all. Found by running the
§3.5 gate.

`eslint-import-resolver-typescript`, by contrast, is a `dependency`: it is an object passed to
`settings['import-x/resolver-next']`, and the repository never names it. Without it,
`import-x/no-cycle` and `no-restricted-imports` see through neither `paths` nor `exports` — the rule
runs and finds nothing, which is the worse of the two failure modes.

**In `peerDependencies` — the binaries the repository runs:**

- **`eslint`** — it is the repository's `eslint` that runs, reads the cache, and is loaded by the
  editor. Two copies, and the plugin loaded by one is not the one the other sees. The range covers
  **9 and 10** because the two React Native repositories are nailed to 9 (§6.3).
- **`prettier`** — `prettier --check` is launched by the repository; `@arthome/tooling` only exposes
  a configuration object and has no reason to carry the formatter.
- **`typescript`** — the nerve of §2. Pinned **exactly at `6.0.3`**, no `^`: a `^6.0.3` would let a
  future 6.1 through, outside Angular's range. One TypeScript version per repository, and the same
  one across all seven.
- **`eslint-config-prettier`** — pinned exactly, because its position in the array is a rule of this
  document and its major decides which `@stylistic` rules it knows about.

**In `dependencies` — the plugins `@arthome/tooling` imports and passes by value:**

In flat config a plugin is an **object** placed in the array, no longer a name resolved from the
repository as in the `eslintrc` days. So there is **no resolution ambiguity**: the plugin
`@arthome/tooling` imports is the one that runs. That is flat config's one real advance for a shared
package, and it lets these plugins be pinned **exactly**, without the repository having to know or
install them.

**Neither one nor the other — the stack presets, absent from `@arthome/tooling`:**

`angular-eslint`, `eslint-config-next`, `@next/eslint-plugin-next`, `eslint-plugin-react-hooks`,
`eslint-config-expo` and `@react-native/eslint-config` appear **nowhere** in this package, under any
heading. Their version must track the **framework major installed in the repository**:
`angular-eslint@22.5.0` requires `@angular-devkit/core >= 22 < 23`,
`@next/eslint-plugin-next@16.3.5` is versioned with Next. Lodging them in `@arthome/tooling` would
force all seven repositories to upgrade framework together — the exact opposite of what §7.3 is
after.

**What we explicitly refuse**, and it is the classic fault: putting `eslint` in `dependencies`. pnpm
would then install a second ESLint inside `@arthome/tooling`'s folder; the command-line lint and the
editor's could diverge, and the diagnosis is long because nothing fails — both work, differently.

**The verification**, to run on each repository after installing:

```bash
pnpm why eslint typescript prettier    # expected: one resolved version each
pnpm exec arthome-check-versions       # reads the pnpm store and fails on a duplicate (§7.4)
```

### 4.3 How a repository extends, without duplicating

**ESLint** — all seven repositories have an `eslint.config.js` of this shape, and only this shape:

```js
// eslint.config.js — arthome-storefront-web, for example
import { defineConfig, globalIgnores } from 'eslint/config';
import base from '@arthome/tooling/eslint/browser';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';

export default defineConfig([
  globalIgnores(['.next/**', 'out/**', 'next-env.d.ts']),
  ...base,           // 1. the common floor
  ...nextVitals,     // 2. the stack, which may turn things back on
  ...nextTs,
  { rules: { /* 3. local overrides, each with its reason in a comment */ } },
  prettier,          // 4. LAST: switches off whatever 2 and 3 turned back on
]);
```

The order **1 → 2 → 3 → 4** is the one thing that is not negotiable. §3.5 verifies it.

**TypeScript** — this is the case that collides head-on with the split of §2, and it has a section of
its own: **§4.4**.

**Vitest** — `@arthome/tooling/vitest` exports a **bare object** and imports **nothing** from
`vitest`:

```js
// a repository's vitest.config.ts
import { defineConfig } from 'vitest/config';   // the repository's defineConfig, its own version
import base from '@arthome/tooling/vitest';

export default defineConfig({ ...base, test: { ...base.test, /* repository-specific */ } });
```

**The reason is §2's split, transposed to Vitest**: Angular 22 pins `vitest ^4.0.8`, the other
repositories are on `5.0.1`. If `@arthome/tooling` imported `defineConfig` from `vitest`, it would
impose **one** Vitest version on all seven repositories and break the two Angular ones. A bare object
imposes nothing: `vitest` appears neither in `dependencies` nor in `peerDependencies` of
`@arthome/tooling`. The package describes the configuration; it does not supply the tool.

### 4.4 The base tsconfig files — how many, and what each carries

The project lead is right to make this explicit: **one base tsconfig cannot be enough**, and the
reason is more precise than a general incompatibility between TypeScript 6 and 7.

#### 4.4.1 What actually diverges between TS 6.0.3 and TS 7.0.2

Checked option by option against the TypeScript 7.0 announcement and the 6.0 release notes, rather
than assumed. The list is short, and its shape is instructive: **TypeScript 7 removes almost nothing
we would ever write here.**

| Option | TS 6.0.3 | TS 7.0.2 | Does it concern us? |
|---|---|---|---|
| `target: "es5"` | deprecated | **hard error** | no — we are on `es2022` |
| `downlevelIteration` | deprecated | **hard error** | no |
| `moduleResolution: "node"` / `"node10"` / `"classic"` | deprecated | **hard error** | no — `nodenext` or `bundler` |
| `module: "amd"` / `"umd"` / `"systemjs"` / `"none"` | deprecated | **hard error** | no |
| `baseUrl` | deprecated | **hard error** | **yes, indirectly** — a `tsconfig` template copied off the internet almost always contains one (§4.4.4) |
| `esModuleInterop: false`, `allowSyntheticDefaultImports: false` | deprecated | **hard error** | no — we leave them at `true` |
| `alwaysStrict: false` | deprecated | **hard error** | no |
| `outFile` | deprecated | **hard error** | no |
| `ignoreDeprecations: "6.0"` | valid, silences warnings | **silences nothing** | no — we do not use it, and using it would only postpone this work |
| **`stableTypeOrdering`** | **valid opt-in option** (up to 25% slower) | **`true` by default, "cannot be turned off"** | **yes — it is the setup's only real collision** |

> **The only option in our configuration that does not exist the same way on both sides is
> `stableTypeOrdering`.** The official TypeScript 7.0 announcement says it "is `true` by default, and
> cannot be turned off". Whether writing it explicitly under 7.0 is accepted is **not verified** —
> secondary sources contradict each other — and that is exactly why the rule below makes the question
> moot rather than depending on the answer.

#### 4.4.2 Three files, and the rule that decides their contents

**The rule, in one line: a file read by both compilers contains only the intersection; an option
specific to one version descends into the file only that version reads.**

| File | Read by | Carries | Never carries |
|---|---|---|---|
| **`tsconfig/base.json`** | **TS 6 *and* TS 7** | the common strictness: `strict` and its family, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `useUnknownInCatchVariables`, `isolatedModules`, `verbatimModuleSyntax`, `forceConsistentCasingInFileNames`, `types: []`, `target`, `lib`, `module`, `moduleResolution` | **no version-specific option**, and **no path** (§4.4.4) |
| **`tsconfig/lib.json`** | **TS 6 only** — the build of the two published packages | `extends` base + `declaration`, `declarationMap`, `isolatedDeclarations`, **`stableTypeOrdering`** | anything that assumes a bundler |
| **`tsconfig/app.json`** | TS 6 *and* TS 7 | `extends` base + `noEmit`, `moduleResolution: "bundler"` | `declaration`, `stableTypeOrdering`, `jsx` (only three stacks need it; they declare it locally) |

**Why three and not two.** The lead's suggestion — `base` plus `lib` — is the right half of the
problem: it correctly isolates what is specific to the published packages. One is missing, and not
for a version reason but an **emission** reason: an application emits no `.d.ts` and delegates
resolution to its bundler (`moduleResolution: "bundler"`), whereas a published package emits its
`.d.ts` and must resolve like Node (`nodenext`). Putting both in one file would force the five
applications to override three options each — and an option overridden five times is no longer
locked, it is a default.

**Why not four.** One might want a `base-ts7.json` for switchover day. Unnecessary: `base.json` is
already valid under TS 7 **by construction**, since it contains only the intersection. That is what
the rule is for.

**And `stableTypeOrdering` descends into `lib.json` only this way**, which settles the collision: the
only file carrying it is the only one TypeScript 7 will never read, because the two published
packages are built with TypeScript 6.0.3 (§2.3 a). On switchover day (§2.6) it is **one line to
remove, in one file**.

#### 4.4.3 The gate that proves `base.json` really is the intersection

This is the kind of invariant that decays silently: all it takes is someone adding a convenient
option to `base.json` one day without asking whether TypeScript 7 knows it.

**The mechanism: the `tools/dts-check` probe (§2.4) extends `tsconfig/base.json`.** It is type-checked
under both compilers. So **gate 7 fails if `base.json` stops being readable by TypeScript 7** — and
it fails immediately, at the publisher, not six months later at a consumer.

```jsonc
// tools/dts-check/tsconfig.json
{
  "extends": "@arthome/tooling/tsconfig/base.json",  // ⚠ this is what turns gate 7 into
  "compilerOptions": {                               //   a check of the floor AND of the .d.ts
    "noEmit": true,
    "skipLibCheck": false,                           // without this the gate always passes (§2.4)
    "types": []
  },
  "include": ["src"]
}
```

A gate that checks two things for the price of one, and asks for no extra tool.

#### 4.4.4 `extends` across a package boundary — the mechanism, verified

`"extends": "@arthome/tooling/tsconfig/base.json"` uses **Node module resolution**. The four contexts
D-014 asks to be checked, verified rather than assumed:

| Context | Verdict | What was verified |
|---|---|---|
| **`exports` resolution** | ✅ **honoured** | This was a known defect — `extends` ignored the `exports` field and always read from the package root (microsoft/TypeScript#48665). **Fixed by PR #50955**, merged December 2022, so shipped well before TS 6. The `./tsconfig/*.json` subpaths must therefore be **listed in `exports`, `.json` extension included** (§4.1): a missing subpath is unreachable. |
| **pnpm and its symlinks** | ✅ holds | TypeScript resolves `@arthome/tooling` as a module then reads through the link; `preserveSymlinks` stays `false`. **But the pnpm constraint is elsewhere**: `node_modules/@arthome/tooling` only exists if the package is a **direct** dependency of the repository. pnpm isolates, it does not hoist transitive dependencies — a repository inheriting `@arthome/tooling` transitively could not extend it, with a message about a file not being found. So it is an **explicit** `devDependencies` entry in all seven. |
| **Metro bundler** | ✅ not applicable, and that is the right answer | **Metro does not read `tsconfig.json` at all**: it transpiles via Babel, with no type checking. So `extends` never concerns it. Two real consequences in its place: `paths` must be **replicated** in `metro.config.js` (§6.3), and `@arthome/core`'s `exports` field is honoured, since `exports` resolution has been **on by default** in Metro since 0.82 (React Native 0.79), therefore in RN 0.87. |
| **Angular CLI** | ✅ holds, with one extra guarantee | `ng build` goes through TypeScript's own parsing, so `extends` by package name works. And Angular has **explicitly implemented inheritance of `angularCompilerOptions` through `extends`**, at the same level as `compilerOptions`. So the two Angular repositories keep their `angularCompilerOptions` **locally** — `@arthome/tooling` carries none, so as not to couple the floor of all seven to a framework that concerns only two. |

**The trap that costs the most, and it is not a version matter.** The documentation is unambiguous:
"All relative paths found in the configuration file will be resolved relative to the configuration
file they originated in." A path written in `base.json` is therefore resolved **from
`node_modules/@arthome/tooling/tsconfig/`**, not from the repository.

> **Rule: the three base files contain no path-bearing option.** Not `include`, not `exclude`, not
> `files`, not `outDir`, not `rootDir`, not `paths`, not `typeRoots`, not `declarationDir`. Those
> options **always** belong to the repository's own `tsconfig.json`.

`include`, `exclude` and `files` are doubly treacherous: they **override** instead of merging, and
their paths would point inside `node_modules`. An `include: ["src"]` in the base would literally
compile `@arthome/tooling`'s own sources. As for `references`, it is **not inherited** at all.

And `baseUrl` is forbidden for two cumulative reasons: it carries a path, and it is a **hard error
under TypeScript 7** (§4.4.1). So `paths` is written without `baseUrl`, in the repository, relative
to its own `tsconfig.json`.

#### 4.4.5 The shape, on the repository side

```jsonc
// tsconfig.json — an application (storefront-web, for example)
{
  "extends": "@arthome/tooling/tsconfig/app.json",
  "compilerOptions": {
    "outDir": "dist",                       // a path -> here, never in the base
    "paths": { "@/*": ["./src/*"] },        // same, and without baseUrl
    "types": ["node"],                      // Next needs its globals (§6.4)
    "jsx": "preserve"
  },
  "include": ["src", "next-env.d.ts"],      // never inherited: always written here
  "exclude": ["node_modules", "dist"]
}
```

```jsonc
// tsconfig.build.json — @arthome/core and @arthome/contracts
{
  "extends": "@arthome/tooling/tsconfig/lib.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["**/*.spec.ts"]
}
```

**The verification, and it is the only one that tells the truth**: `tsc --showConfig` prints the
**resolved** configuration, after `extends` has been applied. Reading the files is not enough — what
counts is what the compiler understood.

```bash
pnpm exec tsc --showConfig                            # this repository's resolved config
pnpm exec tsc -p tsconfig.build.json --showConfig      # a package build's resolved config
```

### 4.5 What is locked, and what a repository may redefine

D-014 is blunt: "without that last list, `extends` is only a suggestion". Here it is — and beyond the
list, §4.5.1 says how it is **checked**, because a list of locks nobody measures is a list of wishes.

**Locked — compiler options. A repository that redefines these has a defect, not a need:**

| Lock | Value | Why |
|---|---|---|
| `strict` | `true` | the floor of §5.7; a repository that is "almost strict" has none of strict's guarantees |
| `noUncheckedIndexedAccess` | `true` | §5.7 — `array[i]` is `T \| undefined` |
| `exactOptionalPropertyTypes` | `true` | §5.7 |
| `noImplicitOverride` | `true` | §5.7 |
| `noFallthroughCasesInSwitch` | `true` | the exhaustiveness of §5.3 depends on it |
| `noImplicitReturns` | `true` | §5.7 |
| `useUnknownInCatchVariables` | `true` | this is where `any` comes back (§5.6) |
| `isolatedModules` | `true` | Metro, SWC and esbuild transpile file by file |
| `verbatimModuleSyntax` | `true` | forces `import type` (§5.5) |
| `forceConsistentCasingInFileNames` | `true` | macOS versus Linux |
| `isolatedDeclarations` | `true` **on the two published packages** | §2.3 c — this is the "readable by both" guarantee |
| `stableTypeOrdering` | `true` **in `lib.json` only** | §2.3 b and §4.4.2: nowhere else, never in a file TS 7 will read |
| `skipLibCheck` | `false` **in `tools/dts-check`** | that is the §2.4 gate; elsewhere `true` is tolerated for speed |
| `baseUrl` | **absent** | carries a path *and* is a hard error under TS 7 (§4.4.1) |
| the `typescript` version | `6.0.3` | §2.2 — one version, the same across all seven |

**Locked — outside the compiler:** the Prettier object of §3.6 (except the single Angular override of
§3.6) · the position of `eslint-config-prettier/flat` last (§3.2) · the ban on
`eslint-plugin-prettier` and on Prettier sorting plugins (§3.3) · the rules marked **[floor]** in §5.

**Redefinable with no justification** — and this has to be possible, otherwise repositories will
bypass the base instead of extending it: `include` / `exclude` / `files` (which are in any case
**never** usefully inherited — §4.4.4), `outDir`, `rootDir`, `declarationDir`, `paths`, `typeRoots`,
`types` (Next needs `["node"]`, §6.4), `lib` (a TV application does not have the same `lib` as a
service), `jsx`, `module` and `moduleResolution` when the bundler requires it,
`angularCompilerOptions` in full, `globalIgnores`, the list of stack presets, Vitest configuration
outside the floor, test file patterns.

#### 4.5.1 The gate: the resolved configuration against the list

Reading the seven repositories' `tsconfig.json` files proves nothing — it is the **resolved**
configuration that runs, and an `extends` can be bypassed by a single local line. So the check is
mechanical:

```bash
pnpm exec arthome-check-tsconfig      # in each of the seven repositories
```

It reads the resolved configuration through `tsc --showConfig` when `typescript` is installed, and
otherwise resolves the `extends` chain itself — so the gate exists before the first install. It also
checks what `--showConfig` never reports: that the three base files carry no path-bearing option, and
that `stableTypeOrdering` appears in `lib.json` and nowhere else.

The lock table is `@arthome/tooling/tsconfig-locks.json` — **so it lives in exactly one place**, like
the version table (§7.4). Seven copies of this list would be fault E2 applied to tooling: seven
parallel literal tables under a common name, diverging in whatever order the repositories happened to
be touched.

**What this gate catches and nothing else does:** a `"strict": false` added one evening to get a
migration through, and never removed. That is exactly the scenario D-014 fears — "every repository
will switch off whichever strictness annoys it" — and the only defence is to measure it, not to
forbid it.

**One behaviour worth knowing, because it is a design decision and not an accident.** When the
`extends` chain is broken, the gate reports **the single cause and stops**, without listing the ten
locks it could not verify. The first version did list them, and that was wrong: ten missing options
with one missing link as their cause invites copying the base's options into the repository — which
is committing exactly the fault the base exists to prevent. One cause, one message, and an explicit
warning not to copy.

**Redefinable with a justification written in the file:** switching off a floor rule for a file
pattern. The shape is prescribed, and it is checkable:

```js
{
  files: ['src/generated/**/*.ts'],
  rules: {
    // Generated Protobuf code: @typescript-eslint/no-explicit-any is structural
    // there, and the file is rewritten on every `buf generate`.
    // See architecture/events.md.
    '@typescript-eslint/no-explicit-any': 'off',
  },
}
```

**Forbidden everywhere: an `eslint-disable` comment with no reason.** An `eslint-disable-next-line`
must carry its reason on the same line or just above. Two motives:

1. it is the only trace that a judgement was made;
2. on React, **an `eslint-disable` of a `react-hooks/*` rule makes the React Compiler bail out of the
   entire function**, silently — the build stays green and the component is no longer optimised
   (§6.2).

The matching gate, which finds the disables that have become pointless:

```bash
pnpm exec eslint . --report-unused-disable-directives --max-warnings 0
```

### 4.6 How a bump propagates without breaking seven repositories the same day

This is D-014's second question, and it is the one that decides whether the package survives.

**a. `@arthome/tooling` is not versioned like a library.**

| Change | Version | Why |
|---|---|---|
| turning a rule on, hardening `warn` → `error`, bumping a plugin by a major | **MAJOR** | it turns a repository red: by definition, that is breaking |
| adding a rule as `warn`, adding an export entry, bumping a plugin by a minor | MINOR | |
| fixing a file pattern, a comment, an option with no effect | PATCH | |

**The point that is not intuitive, and that makes the whole thing work: turning a rule on is a
breaking change.** A configuration package that treats adding a rule as a minor turns seven
repositories red in one `pnpm update`. That is the E2 disaster, applied to tooling.

**b. Every new rule passes through `warn` before `error`.**

Minor `N`: the rule arrives as `warn`. All seven repositories see it, nobody is blocked, and
`eslint . --max-warnings 0` lets each repository measure its debt when it chooses.
Major `N+1`: the rule becomes `error`, once all seven are at zero.

**c. One repository in transit at a time**, in the order of §7.3. The repository in transit is named
in the bump log (§7.5); while it is there, no other one moves.

**d. A repository that cannot follow pins the previous major, and that is not a drama** — but it is
**dated**. Major `N-1` is supported for at most **one cycle**; beyond that, it is the repository we
fix, not the package we keep alive. The predictable case is the two React Native repositories stuck
on ESLint 9 (§6.3).

**e. `@arthome/tooling` eats its own cooking.** `arthome-core` uses the workspace version, never the
published one. A major that breaks something breaks it **at the publisher first**, before it is ever
published — the only free protection in the whole setup.

```bash
# in arthome-core: the package is consumed through the workspace link
pnpm --filter "@arthome/core" --filter "@arthome/contracts" run lint
```

**f. Publishing to GitHub Packages.** The registry is declared in a **committed** `.npmrc` (without a
token); the token stays in the machine's `~/.npmrc`.

```ini
# .npmrc — committed in all seven repositories
@arthome:registry=https://npm.pkg.github.com
```

**The trap to have seen coming**: since pnpm 11, `minimumReleaseAge` defaults to **1440 minutes**. An
`@arthome/*` package published moments ago would therefore be **invisible for 24 hours** to the
repository waiting for it — and the symptom is "that version does not exist", which sends you looking
in the wrong place. All seven `pnpm-workspace.yaml` files (or `.npmrc` for the repositories without a
workspace) carry:

```yaml
minimumReleaseAge: 10080          # one week for the whole npm ecosystem
minimumReleaseAgeExclude:
  - '@arthome/*'                  # our own packages install immediately
```

10080 rather than the default 1440: for a single maintainer who does not follow security advisories
continuously, a week of settling on third-party packages costs little and catches most supply-chain
compromises, which are detected within days.

**And this policy collides with the version table. §7.6 is the resolution** — it was found at this
repository's first install, and it is not a detail.

### 4.7 How it avoids becoming a production dependency

Four barriers, three of them mechanical.

1. **It has no `"."` entry point** (§4.1). `import { x } from '@arthome/tooling'` fails to resolve.
   The most effective barrier, because it has nothing to watch.
2. **It is in `devDependencies` in all seven**, never anywhere else.
3. **A floor ESLint rule forbids it in application code:**

```js
{
  files: ['src/**', 'app/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['@arthome/tooling', '@arthome/tooling/*'],
        message: '@arthome/tooling is tooling: never in src/.',
      }],
    }],
  },
}
```

4. **A gate that checks it**, because the previous three can be bypassed by a transitive dependency:

```bash
pnpm why -P @arthome/tooling      # expected, in all seven: no dependency found
```

And on the publishing side, `@arthome/core` stays under its own rule — **zero framework
dependencies** (README §3). Its own gate:

```bash
node -e "const p=require('./packages/core/package.json');
  const d={...p.dependencies};
  if (Object.keys(d).length) { console.error('core must stay dependency-free:', d); process.exit(1) }"
```

`@arthome/contracts` is allowed the Protobuf runtime and `zod` — that is precisely why the two
packages are separate (README §3), and **that** is what gets checked: `core`'s gate is "zero",
`contracts`'s gate is "this list and not one more".

---

## 5. The common floor — what holds in all seven repositories

Rules marked **[floor]** are locked (§4.5). The others are recommendations, and they say so.

### 5.1 Formatting

**[floor]** Prettier owns it. The configuration is in §3.6. There is nothing to discuss per
repository, and that is the point: not one minute of attention should go there.

```bash
pnpm exec prettier --check .        # gate
pnpm exec prettier --write .        # fix
```

**What Prettier does not own is prose** — §3.7 gives the measurement and the reason. `.prettierignore`
excludes Markdown, the mockups and the handoff dossier in all seven repositories.

**[floor] A gate checks. It never fixes. (D-049)**

```bash
pnpm run verify   # --check and --list-different only. Nothing is edited.
pnpm run fix      # prettier --write . && eslint . --fix && prettier --write .
```

**Why the fixer runs the formatter twice, and why that is not a redundancy to simplify away.**

`eslint --fix` changes **structure**: it reorders imports, and `consistent-type-imports` splits one
statement into two. Prettier then reflows whatever that produced. The two are **sequential
transformations that do not commute**, and no configuration makes them commute —
`eslint-config-prettier` stops the two *disagreeing about a rule* (§3.2), but nothing stops **a fixer
producing text that the formatter then reflows.** Measured from a dirty tree: `prettier --write` then
`eslint --fix` left fresh Prettier diffs in the files just fixed.

So the third pass is what a non-commuting pair costs. **If you "simplify" this to one pass each, you
will rediscover it** — which is why the reason is written here rather than in a commit message.

**And the ruling that follows is stronger than the ordering.** A gate must not edit, because:

> **A gate that fixes cannot fail honestly: it either reports a defect it has already removed, or it
> fails on a tree that was correct before it touched it.**

The second is a red gate on no defect, which is the thing that gets a gate switched off. Once `verify`
only ever reports, convergence cannot affect it at all — nothing changes underneath it while it looks.
That is why the fix is a **separate, ordered, human-invoked script**, and why `verify` contains no
`--fix` and no `--write` anywhere.

**A note on what I could not measure**, because the failure is more instructive than the answer would
have been. I tried six times to determine whether `eslint --fix` **first** converges in one pass each,
and every attempt was confounded by a different scope artefact: ESLint silently ignoring files outside
its config's base path; a fixture whose imports did not resolve, so unfixable errors masked the
question; and finally typescript-eslint refusing files no tsconfig claimed, so the type-aware rules
never ran and the "residual errors" were parse refusals. **Three different invisible scopes, in six
attempts to measure one thing** — §5.3.1's lesson arriving in the attempt to measure it. The ruling
above is safe under either mechanism, so the optimisation was not worth a seventh attempt.

### 5.2 Naming

**Files and directories — [floor]:** `kebab-case`, always, in all seven repositories and for every
extension. One case-sensitivity mismatch between macOS and Linux is enough to lose an evening, and
`kebab-case` makes it impossible.

**Directories — [floor]:** organised **by business domain**, never by technical nature. No
`components/`, `services/`, `utils/` or `types/` at the root of a feature. This is Angular's explicit
recommendation ("organize by feature areas, not file types") and it generalises without harm:
`booking/` holds its components, its calls, its types and its tests.

`utils/` deserves its own mention, because it is the directory that fills itself: a function that
does not know which domain it belongs to has **not yet found its domain**. It goes in the domain that
calls it until a second caller appears; at that point it moves up into `@arthome/core`, not into
`utils/`.

**Symbols:**

| Kind | Convention | Example |
|---|---|---|
| variable, function, method, property | `camelCase` | `remainingSeats` |
| class, interface, type, enumeration | `PascalCase` | `BookingWindow` |
| module-scope constant, genuinely constant | `SCREAMING_SNAKE_CASE` | `MAX_CHAT_MESSAGE_LENGTH` |
| a literal union's value | lowercase **`snake_case`** — the wire's spelling (see below) | `'read_only'`, `'replay_online'` |
| boolean | `is` / `has` / `can` / `should` prefix | `canModerate` |
| function returning a promise | a verb, no `Async` suffix | `fetchBooking` |
| i18n key | `camelCase` segments, dot-separated | `chat.collapse`, `account.alerts.alertHint` |
| i18n key **for an enumeration label** | `enums.<enumName>.<value>` | `enums.chatMode.read_only` |

The last two rows are read from `shared/i18n/storefront.json`, like the values in §5.3 and for the
same reason. The distinction between them **is not cosmetic**: among its eight fields, E2 records a
**`chat.*` copy family** — `chat.free`, `chat.emoji`, `chat.off` — shadowing `enums.chatMode.*` —
`open`, `emoji`, `read-only`, `off` — with a vocabulary that diverges on the very first value (`free`
versus `open`). An enumeration label that is not under `enums.` is a parallel table in the making:
the §5.3 gate says so, not vigilance.

**The wire decides the spelling, and `@arthome/core` serves it.** This reverses what this document
first said, and the reversal was settled by counting rather than by preference.

The first draft said `kebab-case`, on the reasoning that §5.3 makes the domain the single source, so
the domain's spelling should win. Three contract vocabularies disagreed with the domain by separator
alone, and they looked like the outliers. Then someone counted the 374 distinct members declared
across both contracts:

| Spelling | Members |
|---|---|
| `snake_case` | **125** |
| `kebab-case` | 12 |

The wire is 91 % snake. It is the **kebab** values that are the exception, and the expectation was
backwards — which is the whole reason this row now carries a count instead of a preference.

**The criterion is which side is expensive to change.** Published enum values in two contracts,
consumed by five surfaces and seven services, cannot be renamed later without breaking clients.
The domain's internal spelling can be refactored in an afternoon. So the wire decides, and the domain
serves it.

**And §5.3 is untouched by this**, which is the part worth being precise about: §5.3 is a rule about
**provenance**, not about spelling. `@arthome/core` remains the single place a vocabulary is declared;
it simply declares it **in the spelling that goes on the wire**. Any other answer needs a transform
between the domain and the wire — and a transform is the parallel literal table wearing a codec's
costume: two spellings, both live, with a function asserting they mean the same thing.

> **[floor]** `@arthome/core` exports **exactly the value that goes on the wire**, and that value is
> `snake_case`. The twelve `kebab-case` members are exceptions that each justify themselves or
> convert. Enumerating them belongs to `backend-domain` and `backend-contracts`, not here.

**Three families, and the third is named rather than tolerated (D-036).**

| Family | Spelling | Example |
|---|---|---|
| domain vocabulary | `snake_case` | `read_only`, `replay_online`, `moderation_page` |
| **error and failure codes** | **`SCREAMING_SNAKE`** | `NO_SEAT`, `SUBSCRIPTION_REQUIRED`, `PAYMENT_DECLINED` |
| declared exemptions | whatever they are, with a reason in place | cache tags, input filters (§5.3.1 b) |

**The reasoning is the part to keep, because it is what D-033 got wrong.** D-033 reasoned from a
**count** — three snake vocabularies looked like outliers against a kebab domain — and the count was
taken on the wrong population. This reasons from a **kind**, and the test is predictive: *what would a
new error code be?* Obviously `SCREAMING_SNAKE`. *What would a new domain value be?* Obviously
`snake_case`.

> **Two rules, each of which decides the next case without being consulted.** A count decides nothing
> about the next case, which is exactly why it failed. Prefer a rule you can apply to a value that
> does not exist yet.

**The worked example, because this is the first time the family rule decided a case it was not written
for.** The classification test is the part that transfers:

> **Does a member answer *why something was refused*, or does it state *a domain fact*?**
> `no_seat` exists only inside a verdict that says no. `co_production` is a fact about the production
> whether or not anything was ever refused.

Applied to the six vocabularies in `@arthome/core` whose names suggest a reason:

| Vocabulary | Members | Answers | Family |
|---|---|---|---|
| `WATCH_DENIAL_REASONS` | `NO_SEAT`, `ROOM_NOT_OPEN`, … | why watching was refused | **`SCREAMING_SNAKE`** ✓ |
| `REPLAY_UNAVAILABILITY_REASONS` | `no_replay_policy`, `replay_window_expired` | why the replay was refused | **`SCREAMING_SNAKE`** — currently lowercase, **the one inconsistency** |
| `BLACKOUT_REASONS` | `co_production`, `broadcaster`, `festival` | a fact about the rights arrangement | `snake_case` ✓ |
| `MODERATION_REASONS` | `spam`, `insult`, `spoiler` | a fact about the message | `snake_case` ✓ |
| `PROMOTION_REASONS` | `pre_sale`, `preview_night` | a fact about the date | `snake_case` ✓ |
| `FAILURE_NATURES` | `refused`, `unavailable`, `offline_forbidden` | *arguable* — classifies a failure rather than giving its reason | **open question** |

Five decided without being consulted, one inconsistency found, one genuine borderline surfaced rather
than guessed. That is what distinguishes a rule from a preference: **a preference tells you about the
cases you already have; a rule tells you about the next one.** The borderline is the useful part of the
output, because it is the one place the test does not reach and therefore the one place a human is
needed.

**And naming the family changed what counts as a divergence, which broke a gate.** Gate 18 grouped
values case-insensitively to find one value spelled two ways. Once `SCREAMING_SNAKE` became a
legitimate family, that grouping merged `WatchVerdict.reasonCode`'s `DATE_CANCELLED` — a refusal code —
with the refund `reasonCode`'s `date_cancelled` — a domain reason — and reported two genuinely
different vocabularies as one value misspelled. A real false positive, created by a correct ruling
landing after the check was written.

The fix is the shape of the ruling: group **separator-insensitively but case-sensitively**, so a
separator difference still fails, and report a case difference as a **note** — legitimate across
families, suspicious within one, and the gate cannot tell which while a human can. **A ruling that
creates a family creates work in every gate that assumed there was one.**

**One defect that is a defect under either ruling**, found while counting and now caught by gate 18:
`co-production` in `storefront.yaml` against `co_production` in `studio.yaml`. The same value, two
spellings, one per contract. Neither document is wrong on its own; together they mean a storefront
client and a studio client read **different strings for the same thing**. That class needs no
`-source` annotation to detect — the gate groups every member across both contracts by its
separator-insensitive form and fails on any group with more than one spelling, so it is live today
across all 148 unannotated blocks.

**What we do not do — [floor]:** no `I` prefix on interfaces, no `Type` suffix, no `Enum` suffix, no
private `_` (TypeScript has `#` and `private`). These conventions come from languages without
inference; here they are noise.

**[floor] A monetary amount on the wire names its tax basis (D-056).**

`@arthome/core`'s `Money` is `{ amountMinor, currencyCode }` — no tax semantics, which is right for the
domain, because rounding, summing and commission arithmetic do not care. At the boundary it is not
enough: **a price field is tax-inclusive**, and `Money` alone cannot say so.

So two amounts of the **same shape** mean different things according to which field they sit in, with
nothing in the type to tell them apart. A reader who takes a price for a bare amount is wrong by a VAT
rate — silently, and in the direction that under-charges or over-pays.

That is the `reasonCode` shape a third time (§5.2's worked example): **one name, two meanings,
disambiguated only by where you are standing.** And it is the E2 shape inverted — the fact that a price
includes tax is stated *nowhere* and carried by convention, which is the absence with no owning
document (§5.3.1).

The rule, in two halves because one is not enough:

1. **For TypeScript consumers**, the distinction is a type: `@arthome/contracts/money` exports
   `Taxed<T, B>`, so `TaxInclusive<Money>` and `TaxExclusive<Money>` are mutually unassignable and
   mixing a price into a net calculation is a compile error rather than a wrong number.
2. **On the wire, the basis is in the data.** A brand is erased at runtime and absent from the payload,
   so it reaches a TypeScript consumer and nobody else — not a generated client in another language,
   not a webhook recipient, not a partner reading the OpenAPI document.

> **A guarantee is only as wide as its mechanism, and a brand's mechanism is the compiler.** A contract
> whose consumers are not all compiled against it cannot rely on a compile-time distinction.

That second half is the one worth carrying past money. Every branded type in a *contract* has this
property, and the brand is the more tempting half because it is the one that produces an error message.

**The `@arthome/contracts` DTO case** — decided, because that is where names travel most: a boundary
object's type carries the concept's name **with no suffix** (`Booking`, not `BookingDto`); a command's
type carries the `Command` suffix; an event's, the `Event` suffix; a paginated response's, `Page<T>`.
The suffix is reserved for what has a particular **shape**, never for what has a particular
**provenance**.

**A role suffix on file names is a stack choice, not the floor's.** Angular dropped `.component.ts`
(§6.1); NestJS kept it (§6.5). Both are right at home. The floor does not arbitrate this point, and
§6 owns that.

### 5.3 Enumerations, and the gate against E2

**This is the most important section of this document**, because it deals with the project's dominant
fault: the **parallel literal table** (`corrections-handoff.md` § E2, committed on eight fields by
five mockups despite an explicit principle).

> **This section itself committed the fault it fights.** Its first draft illustrated the rule with
> `CHAT_MODES = ['open', 'followers-only', 'subscribers-only', 'off']` — an **invented** vocabulary
> that exists nowhere in the project. The real one is `open | emoji | read-only | off`. The fault was
> found by another teammate, re-reading this document.
>
> It is recorded here rather than quietly corrected, for three reasons. First, because it is **the
> best possible demonstration of this document's own thesis**: the author of the anti-E2 gate
> committed E2 in the paragraph describing it, and only an outside reading caught it — a written
> principle is not enough, not even for the person writing it. Second, because it counted **double**:
> `arthome-check-enums` reads these constant names, so a wrong example in the gate's documentation is
> a trap laid for whoever implements it. Third, because it shows the mechanism of the fault — I did
> not contradict a source, **I consulted none**. The parallel literal table is not born of
> disagreement; it is born of reconstruction from memory.
>
> Both examples below are now read from the source, and the source is named every time. **That is
> this section's drafting rule**: an enumeration value is not written here without its file of
> origin.

> **A note on spelling, so that this section and §5.2 do not appear to contradict each other.** The
> values below are **read from their sources as those sources stand today**, which is this section's
> own drafting rule — and today several of them are `kebab-case`. §5.2 has since ruled that the wire
> spelling wins and the wire is `snake_case`, so `read-only` becomes `read_only` and `replay-online`
> becomes `replay_online` when `backend-domain` and `backend-contracts` convert them.
>
> The examples are **not** updated here in advance of that conversion. Writing `read_only` while
> `proto/arthome/chat/v1/events.proto` still says `READ_ONLY` → `read-only` would make this document
> a table that disagrees with its own cited source — which is the exact fault the section is about.
> A sourced example tracks its source; it does not anticipate a decision. Gate 18 is what makes the
> conversion visible when it happens, and §5.2 is what says which way it goes.

**[floor] The rule:** a literal union, declared **exactly once**, in `@arthome/core`.

```ts
// @arthome/core — the prescribed shape for every boundary enumeration.
// Vocabulary read from proto/arthome/chat/v1/events.proto (enum ChatMode),
// agreeing with shared/i18n/storefront.json (chatMode.open|emoji|read-only|off)
// and shared/fixtures.js. This is not an example: it is the real enumeration.
export const CHAT_MODES = ['open', 'emoji', 'read-only', 'off'] as const;
export type ChatMode = (typeof CHAT_MODES)[number];
```

This shape gives three things no other shape gives together: the **type** for the checker, the
**array of values** for runtime (UI loops, validation, zod schemas), and **one place to change**.

**The second example is the family's founding case**, and it is worth writing out in full because it
shows what the gate is looking for. `corrections-handoff.md` § D2: two tables describe the same state
machine, and they meet at only one point in the studio mockup.

| `shared/catalogue.json` → `publicationStates` *(authoritative)* | `mockups/Studio.dc.html` → `EV_MOVES` *(parallel table)* |
|---|---|
| `draft` | `draft` |
| `reserve` | `hidden` |
| `scheduled` | `sched` |
| `technical` | `tech` |
| `live` | `live` |
| `ended` | `done` |
| `replay-online` | `replay` |

```ts
// @arthome/core — read from shared/catalogue.json (publicationStates), which is
// authoritative over mockups/Studio.dc.html: it is explicit, and it is the one the
// i18n carries (enums.publicationState.*). `replay-online` says what `replay` does
// not — the replay is ON SALE. See corrections-handoff.md § D2.
export const PUBLICATION_STATES = [
  'draft',
  'reserve',
  'scheduled',
  'technical',
  'live',
  'ended',
  'replay-online',
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];
```

What this example teaches, and the rule alone does not: **both tables are readable, coherent and
functional, each on its own side.** Nothing crashes. The cost only appears at the moment two people —
or two agents — each read their own and write two contracts. That is why detection cannot be left to
review.

**[floor] `enum` is forbidden.** Four reasons, in order:

1. a TypeScript `enum` **emits runtime code** — unacceptable in `@arthome/core`, which forbids itself
   any platform footprint, and costly on the constrained surfaces;
2. `const enum` does not survive `isolatedModules`, which the whole fleet enables;
3. an `enum` does not serialise naturally to JSON, whereas **all** of these values cross an HTTP,
   gRPC or Protobuf boundary;
4. a literal union narrows and can be exhausted (`switch` with no `default`), which a numeric `enum`
   does not do correctly.

**[floor] Exhaustiveness is mandatory** on every `switch` over a literal union: no `default`, and a
final `never` branch. That is what turns "a value was added" into a compile error across all seven
repositories, rather than into missing behaviour on one screen.

```ts
function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${String(value)}`);
}
// … switch (mode) { case 'open': … ; default: return assertNever(mode); }
```

**The gate — and this is where this document tries to be worth more than a principle.**

E2 proves that writing the rule is not enough. What is needed is to detect **the reappearance of an
enumeration value anywhere other than where it is declared**. That is mechanisable and cheap:

> `arthome-check-enums`, which:
> 1. reads `@arthome/core`'s **sources** and discovers **every** exported constant of the form
>    `export const NAME = [...] as const`, without knowing the list in advance, then collects all
>    their values;
> 2. walks the repository's source files (`src/**`, `app/**`), excluding the declaring module,
>    `**/generated/**` and the test files;
> 3. reports every string literal belonging to that set;
> 4. exits 1 with file, line and value.

**Point 1 is discovered, not enumerated**, and that is deliberate. An earlier draft of this paragraph
hardcoded the list — `CHAT_MODES`, `REPLAY_POLICIES`, `PUBLICATION_STATES`, `MODERATION_STATES`,
`CURRENCIES` — which would have been **one more parallel table**: the list of enumerations, copied
next to the enumerations. The script reads what `@arthome/core` actually exports; a new enumeration is
covered the day it is declared, with nobody having to remember to register it anywhere.

**And it reads the sources, not the built package.** Importing `@arthome/core` would require it to be
compiled *and* installed; reading `packages/core/src/**/*.ts` works from day one, with no build, no
runtime and no module resolution. This is the one divergence between this specification and the
implementation, and it is in the direction of robustness: a gate that waits for a package to be built
in order to exist does not exist on the day it is needed most.

An example of what the hardcoded list would have cost, and it is not theoretical:
`MODERATION_STATES`, singular, **conflated three axes that
`proto/arthome/chat/v1/events.proto` separates** — `MessageState` (the message's state),
`ModerationItemState` (the nature of the queue row, where `reported` lives) and `ModerationVerdict`
(the sanction). That is exactly discrepancy E3, reproduced by a constant name invented instead of
read.

Legitimate exceptions — a test building a fixture, an i18n key map — are listed in a **version-controlled**
`tools/enum-literals.allow.json`, each line carrying its reason. **An entry without a `reason` makes
the gate exit 2**: an exception that does not say why is not an exception, it is a hole. That file
stays short, or the rule is wrong: past twenty lines it is the sign that a value is missing from
`@arthome/core`.

It is published as a `bin` of `@arthome/tooling` so that the other six repositories run it against
their own sources while reading the values from the installed `@arthome/core`:

```bash
pnpm exec arthome-check-enums        # in each of the seven repositories
```

**The contracts-side complement**: every boundary enumeration is **derived**, never copied, into
`@arthome/contracts`'s zod schema (`z.enum(CHAT_MODES)`) and into the matching `.proto`. A `.proto`
cannot import TypeScript; that is therefore the point where duplication is unavoidable, and exactly
why it must be **generated or checked**, not written by hand. The detail belongs to
`architecture/events.md`; this document only requires that the check exist and appear in
`pnpm run verify`.

#### 5.3.1 The gate between the two artefacts

§5.3 proves that no enumeration value is **copied into** the source. `check-openapi.py` R14 proves
that every reachable enum is **declared**. Neither proves the two **agree** — and for four months
they did not.

Found by hand, not by a gate: `@arthome/core` exports `moderation-page` where `openapi/studio.yaml`
declares `moderation`, and `team` exists in the domain and not in the contract. Five gates were
green. That is E2 — the parallel literal table — surviving **between the two artefacts built to
prevent it**, which is the most expensive place for it to live: the domain and the contract are
precisely the pair that must not disagree.

`arthome-check-vocabulary` closes it. Three decisions it rests on, each with its cost:

**a. The contract declares its source. It is never guessed.**

```yaml
x-arthome-vocabulary-source: NAVIGATION_ENTRIES
x-arthome-vocabulary: [agenda, dashboard, moderation-page, crew, …]
```

Heuristic matching by member overlap was tried first, and it is *why* this key exists: at 0.38
overlap the matcher paired a display-state list with `DATE_OUTCOMES` and invented five missing
members. **A guessing gate gets switched off.** The cost is honest and it is not small: **148 blocks need the key**, and five of them sit inside
YAML flow mappings where it cannot be added by inserting a line.

**a-bis. When a gate needs data that does not exist yet, look for the check that needs no data.**

The `-source` key is weeks away for 149 blocks, so a gate that depends on it does nothing until the
migration lands. But one class of drift needs no annotation at all: **the same value spelled two ways
across the two contracts.** Group every member by its separator-insensitive form, fail on any group
holding more than one spelling — no source key, no domain comparison, live today across all 149.

It found `co-production` in `storefront.yaml` against `co_production` in `studio.yaml`: neither
document wrong on its own, together meaning a storefront client and a studio client read different
strings for the same thing. It was found once by hand in a one-off count; the check turns that
finding into a **class**, which is the difference between noticing and covering.

And the way to prove such a check: **it reproduced exactly the one known case and nothing else.** A
new gate that finds more than the known case on its first run is usually finding false positives.

Most drift classes have a formulation that needs no data. It is worth looking for it before accepting
that a gate has to wait.

**b. A vocabulary with no domain counterpart says so, in place.**

```yaml
x-arthome-vocabulary-source: none
x-arthome-vocabulary-reason: Input filter, not a domain vocabulary.
```

In the artefact, not in a side file — because a side file would have to identify the block by line
number, and line numbers are what §3.7 learned not to key on. The reason is mandatory: an exception
that does not say why is not an exception, it is a hole.

**b-bis. It reads `enum` as well, and the comparison is asymmetric — because the contract is.**

The first version read only `x-arthome-vocabulary` and was therefore blind to the half that fails
hard. Measured: 149 output blocks carrying 374 values, **77 input `enum` blocks carrying 191 values,
60 of them existing nowhere else.** And the asymmetry runs the wrong way for a gate that only sees
outputs:

| | Divergence behaviour |
|---|---|
| `x-arthome-vocabulary` — **served** | **degrades.** Rule 10 keeps an unknown value raw and treats it as neutral. |
| `enum` — **accepted** | **rejects.** A 400 on every request carrying the value, from the first deploy. |

The proof arrived while this was being written: `SURFACES` diverged as domain `storefront_web` against
wire `storefront-web`, on `X-Arthome-Surface` — a **required** header validated on every request to
both BFFs. **The one divergence capable of taking the platform down sat in the sixty the gate could
not see.**

So `enum` is read under the same `-source` key — and inputs are **not** turned into
`x-arthome-vocabulary`, because that would erase the strict-on-input, tolerant-on-output distinction,
which is a design property of the contract rather than a notation accident. What the gate does instead
is compare asymmetrically:

| | only in the contract | only in the domain |
|---|---|---|
| output | **fail** — we would serve a value the domain cannot represent | **fail** — the contract cannot describe something the domain can emit |
| input | **fail** — we would *accept* one. The dangerous direction, and the one that caught `SURFACES` | **note** — narrowing an input is legitimate: not every domain value is settable by a client |

**The dangerous direction fails in both kinds; only outputs require equality.** Demanding equality on
inputs would shout at every deliberately-restricted enum — a "set state" input properly accepts only
the transitions a client may request — and a gate that shouts wrongly gets switched off.

**With one qualifier, added once a third verdict existed:** an output may narrow too, provided it says
so. `PlaybackTicket.scope` omits `none` from `WATCH_SCOPES` because a ticket that grants nothing is
never issued — a real rule about a real field. So the equality requirement holds for a block that
*mirrors* a vocabulary, and a block that *restricts* one declares `x-arthome-vocabulary-narrowing`
with its reason and is checked as a subset instead. Without that qualifier the rule would have been
right about six inputs and wrong about the first output it met.

**And the two migrations get two ratchets, with the input one dated earlier.** One shared allowance
would let the safe migration mask the dangerous one: outputs could fall to zero while all 77 inputs
stayed unchecked, and the number would look like progress.

**c. The migration is a ratchet, not a truce.** `tools/vocabulary-migration.json` records how many
blocks are still unannotated, so the gate is useful **today** against contracts nobody has annotated
yet. Three properties make it a ratchet: the number may go **down and never up**, so new drift fails
immediately; it carries a `removeAfter` date the gate enforces, so the migration cannot be forgotten;
and it carries a `rebaselineAfter` date that dates the **slack** separately, so an allowance set above
the real count cannot sit there quietly. Same shape as §7.6, for the same reason.

**And it is set from a measurement, never from a prediction** — which this file learned by getting it
wrong within the hour. The allowance was first set to 148 while the observed count was 143, because
five blocks were unparseable and 148 was a *prediction* of the count once they were quoted. They were
quoted; the real count was **149**; and the gate went red **because a defect had been fixed** — the one
thing a ratchet must never do. The prediction was off by one because the contracts had gained a block
in the meantime, which is precisely what a prediction cannot see.

So: **when a fix changes the count, re-baseline in the same commit as the fix.** An allowance is a
record of an observation, not a forecast. The `rebaselineAfter` date exists because the first instinct
— "the slack disappears on its own" — is the shape of a fact that is true the day it is written and
false the next.

**And this generalises past ratchets, which is the part worth carrying.** Any threshold written as
*"what this number will be once X lands"* has the same defect: it encodes a **forecast of someone
else's work** into a gate that then fails loudly and inscrutably when the forecast is off by one. The
failure does not say "your prediction was wrong" — it says the thing the gate normally says, which
sends whoever reads it looking for a defect that is not there.

The test to apply to any number in a gate's configuration: **is this a count someone took, or a count
someone expects?** If the second, it does not belong in the gate yet. Wait for the observation, or
date the guess so it cannot outlive its plausibility.

**What it found on its first real run, which nobody was looking for.** In five blocks a vocabulary
member is **not a string**:

```yaml
x-arthome-vocabulary: [open, emoji, read_only, off]   # `off` is a BOOLEAN
```

YAML 1.1 reads bare `off`, `on`, `yes` and `no` as booleans. PyYAML returns `False`, and so will many
code generators. The contract does not say what its author believes it says, and nothing had reported
it — `check-openapi.py` reads the same file with the same parser and does not look at member types.
The fix is one pair of quotes; the lesson is that **an unquoted YAML scalar is a type decision made
by the parser**, and a vocabulary of short lowercase words is exactly where that bites.

The gate reports this as its own class and **skips the agreement check for that block**: until the
members are strings, comparing them is meaningless, and two messages for one cause invites fixing
the wrong one — the same principle as §4.5.1's broken-chain rule.

**With one exemption, written before it fired rather than after.** A vocabulary declared
`type: [string, "null"]` may legitimately list `null` among its members, and **fourteen blocks across
the two contracts are declared that way**. Nullability is a fact about the *type*, not a member of the
vocabulary, so `null` is accepted there and dropped before the comparison — the domain's union will
not contain it either. In a block typed plainly `string`, a `null` member remains a defect, and the
gate still says so.

No block lists `null` today; the ones that could are already nullable. **A gate that shouts wrongly
gets switched off** applies to this gate as much as to the one that sentence was written about, and a
latent false positive is cheaper to remove while it is still latent.

**And this gate committed its own fault, which is the third time this document has had to record
that.** As first wired into `verify:offline` it printed:

```
… 0 agree, 0 disagree, 0 exempt, 149 undeclared
PASS the contracts and the domain share one vocabulary
```

**It compared nothing and then asserted that the two sides agree.** The count line was honest; the
verdict line was not. A reader of a green `verify:offline` took away a conclusion nothing in this
repository had established — which is the failure mode this whole section exists to name, committed by
the gate built to catch it.

The other four gates already had the pattern, in two words: `GATE INACTIVE`, plus the condition that
is missing. This one asserted instead. Two rules came out of it, and they apply to every gate here:

1. **No coverage, no verdict.** When nothing was compared, the verdict is
   `GATE INACTIVE — N blocks undeclared, nothing compared`, with the missing condition named. Exit 0
   stays correct, because the ratchet is deliberate policy; it was the *sentence* that was wrong.
2. **A pass states what it covered** — `PASS — 87 of 149 blocks compared, all agree; 62 undeclared`.
   A pass that names its coverage cannot quietly decay into a pass that covers nothing, which is
   exactly what a drifting ratchet would otherwise let happen.

There is a sharper version worth keeping: `0 exempt` meant the `source: none` branch had never run
either, so **neither branch had executed against real data**. A gate whose branches have never run is
a gate whose behaviour is a hypothesis. All four verdict states — inactive, agree, disagree, exemption
without a reason — are now exercised against fixtures built from the real contracts.

**[floor] A gate's guarantee is only as wide as its mechanism.**

`check-core-entry` guarantees that `@arthome/core`'s public entry reaches neither `zod` nor a Node
API — the rule the whole package is premised on. Its **mechanism** is walking the import graph.

And a global is not an import. So `types: ["node"]` in the root `tsconfig.json` would have pulled
Node's globals into the very program that checks the domain, and **that gate would not have seen a
thing**: `process`, `Buffer` and `__dirname` would have type-checked clean inside a package whose
entire premise is that it cannot reach them. The configuration about to open that hole had itself been
failing since the day it was written, invisibly, because the chain everyone ran omitted `typecheck`
(§8.2). **Two invisible things cancelling out to look like a working system.**

The lesson is not about Node types:

> **A gate's name states an intention; its mechanism states its coverage. Where the two differ, say so
> in the gate — because the name is what people will rely on.**

A gate that walks imports should say it does not cover ambient types. A gate that reads declarations
should say it does not cover computed values. The alternative is a guarantee everyone trusts one level
wider than it holds, which is worse than no guarantee, because nobody looks where they believe a gate
is already looking.

A second instance, sharper because the gate's *judgement* was right and only its *reach* was wrong.

`check-language` guarantees that no committed file carries French prose. For a `.json` file its
mechanism was a single-line regex over the keys that hold prose here — `_comment`, `_why`, `reason`,
`description`.

Every `_comment` in this repository is written as an **array of lines**. The regex captured the rest
of the key's line, which is `[`, and the element lines that hold the actual prose were never read. A
French comment sat in `packages/core/tsconfig.build.json` for three days while the gate printed
`PASS — 330 file(s) checked`.

**The word list was never the problem.** The missed text scores four distinct French words —
`jamais`, `dans`, `depuis`, `fichier` — against a threshold of three. It would have fired the instant
those lines reached it. And the key list looked complete: it covered `"description": "one line"`, the
one form this project barely uses, and missed the form it uses everywhere. Two holes of the same shape
sat beside it — `_comment_exports` and `_comment_peer` were exempted by an **exact-match** key name,
and `.json` was declared comment-free although every `tsconfig.json` here is JSONC and carries its
reasoning in `//` lines.

It also explains why nobody caught it by eye: the French was **de-accented** (`partage`, `ecrit`,
`etendu`, `resoudrait`), so it does not read as French at a glance, and it sat in a JSON value, which
this document had already written off as data by design.

Then the fix committed the rule it was written to fix. Declaring `/* */` a block-comment marker for
`.json` made the glob `"prototypes/*.dc.html"` open a comment that never closed, so every remaining
line of `tools/language.allow.json` was read as prose and the gate reported four French words the file
does not contain — a **false** positive on the registry of allowed French, one step after a **false
negative** on real French.

> **A glob looks exactly like a comment marker, and a URL looks exactly like one too.** Deciding by
> raw text cannot tell them apart. Deciding on a projection of the line with every string literal's
> contents masked out — same length, so indices still point at the original — can.

Both faults are one fault. The gate's coverage was assumed from its key list and its word list, which
are the parts a reader checks, while the reach was decided by a regex's line discipline, which is the
part nobody reads. The word list had been argued over word by word; that the matcher only ever saw one
line at a time was never stated anywhere.

> **State a gate's reach next to its judgement.** A word list, a rule set or a threshold is the part
> people review; the traversal that feeds it is the part that decides what the review was worth.

Writing this section then produced a **third** instance, from the other side. Citing the four missed
words as evidence made the gate fail on the document that documents it, and on its own source, which
cites them in the comment explaining the fix. That is not a false positive to be waved through: a
single-token backtick span is the WORD being discussed, exactly as a fenced block is the CODE, and both
are data. So a span with **no whitespace in it** is stripped from prose, in Markdown and in comments
alike, from one shared helper — while a span with spaces stays reported, because
`les quatorze entrées de navigation` is a quotation and a quotation goes through
`tools/language.allow.json` with its reason. Whitespace tells the two apart without a word list, so the
distinction cannot drift.

The ten fixtures now pin both directions: five that the old mechanism got wrong and the new one gets
right — the verbatim missed text, a `//` comment in JSONC, a `_comment_peer` block, French after a
bracket written as prose, and the French *sentence* in backticks that must still fire — and five that
must stay silent, and do: English prose containing `types: ["node"]`, French in a non-prose key, a `/*`
glob followed by French data, `//` inside a string, and the cited tokens of this very paragraph.

**[floor] Never put prose in a double-quoted shell string.**

The only fault this week that can **execute**. A backtick inside double quotes is command
substitution, so a helpful note reading `` Run `pnpm run verify` before pushing `` embedded in an npm
script does not print that sentence — it **runs the command**. In `verify:offline`, that was `verify`
invoking itself, and it was never reached only because the chain failed earlier.

Three instances this week, two authors, each caught by accident rather than by review. The remedy is
not attention:

> **A sentence for a human does not go inside a double-quoted shell string.** Put it in a file, or a
> single-quoted string, or a `node -e` reading from a separate module — anywhere the shell is not
> parsing English for syntax.

Backticks are the sharp edge, but `$`, `!` and `\` are all live in the same position. Prose contains
punctuation; shell double quotes give punctuation meaning. The two should not meet.

**[floor] When a file must be duplicated, the comment is the only thing carrying the reason.**

`vitest.config.ts` cannot move into `@arthome/tooling`: `defineConfig` has to be resolved by the
consumer, because the consumer is what knows the vitest version (§4.3). So the file is duplicated per
package **by design**, and `@arthome/contracts` got its copy by reading `@arthome/core`'s.

The copy kept the paragraph explaining the bare-object design and dropped the paragraph explaining
`const config: ReturnType<typeof defineConfig>` — which is not decoration. `lib.json` carries
`isolatedDeclarations`, that option applies to the type check **even under `noEmit`**, and it refuses
an inferred default export:

```
vitest.config.ts(8,16): error TS9037: Default exports can't be inferred with --isolatedDeclarations.
```

The copy kept what looked like design and dropped what looked like verbosity. The load-bearing half
was the verbose one.

> **A duplicate made by reading the code keeps the design and loses the fix.** Where duplication is
> structural, the comment explaining the workaround is part of the file's contract — copy the comment
> first.

This one was cheap: `typecheck` failed on the first run, by name, with a line number. That is the
difference between a duplicated file inside a chain and a duplicated **fact** across artefacts, which
is E2 and stays silent. It is an argument for keeping the copy small and the chain complete, not for
trusting copies.

**[floor] A check is scoped by something, and the scope is invisible in the output unless the output
says so.**

This is the sentence that unifies every measurement fault in this document, and it was
`backend-contracts` who wrote it. Each of these was a correct measurement whose scope did not appear
in its result:

| The check | Scoped by | What it could not see |
|---|---|---|
| the `snake_case` conversion | a **directory** | nine vocabularies outside `vocabulary/` |
| a divergence scan | a **separator** | ten values differing only by case |
| "1015 lines, unchanged" | a **line count** | invariant under the very defect it was ruling out |
| a gate's status | the **last command in a pipe** | the gate's own exit code |
| the quotation exemption | **existence**, not narrowness | a one-character quote passing a whole file |
| `check-enums`' attribution | the **first** declarer | 25 of 179 values have more than one, `'none'` has five |
| `check-enums`' sweep | the **declaring file** | ten files never scanned at all, one of them since it was written |

**The last row is the purest instance, and it is worth its own paragraph.** `check-enums` excluded from
its sweep *any file that declared a vocabulary*. The skip had a real reason — a file legitimately uses
the members of the vocabulary it declares — but it was scoped by the **file** when the thing being
excused is a **value**. So `entitlement/index.ts` was never scanned at all: it declared two
vocabularies of its own, and three inline literals copied from *other* vocabularies sat in it from the
day it was written. Moving the declarations out, for an unrelated reason, revealed them instantly.

The output said `42 file(s) swept` and nothing about the ten it declined. **Incidental scope, invisible
in the output, inside the gate whose entire purpose is finding copies** — this document's own lesson
landing on the tool that taught it.

The fix is not to announce the scope but to **narrow it correctly**: scan every file, ignore only the
values *that file declares*. The sweep went from 42 files to 52, and it now prints both numbers.
Announcing is worth doing on top, and that is the verdict-line rule one level down: **a sweep that
names its coverage cannot quietly become a sweep that covers less.**

**And the counter-example is the instruction.** A set difference has nowhere to hide a narrowing: it
announces its scope by construction, because the scope *is* the question. The asymmetric input/output
table (§5.3.1 b-bis) does that; the case-insensitive grouping did not, which is exactly why a ruling
could break it silently.

> **Prefer a check whose scope is structurally visible.**

**[floor] Incidental scope versus intrinsic scope (D-045).**

The distinction that decides how every gate here gets written:

- **Incidental scope** — a directory, a separator, a line count, a pipe, a naming convention. A
  property of the **instrument**. Invisible in the output, and everything outside it is a silent miss.
- **Intrinsic scope** — *"narrows something that has a name."* A property of the **question**. Visible
  because it **is** the question.

> **Scope the check by a property of the thing you are looking for, never by a property of where you
> happened to look.**

Measured, not argued. The narrowing predicate was tried three ways:

| Scoped by | Hits | Real | Noise |
|---|---|---|---|
| a name | — | missed eight | |
| nothing | 14 | 6 | **8** |
| *"an unannotated block that is a strict subset of a named vocabulary"* | **6** | **6** | **0** |

The eight noise hits were four vocabularies that legitimately nest (`CREW_ROLES ⊂ MEMBER_ROLES` is
true and means something), one pure coincidence (`[low, medium, high]` inside
`[auto, low, medium, high]`), and three artefacts of **where it looked** — a description written on the
array rather than on its `items`. Noise is how a gate gets switched off, so **six that are all real
beats fourteen that are mostly right**, and "unscoped" is not the goal but the other failure mode.

**[floor] The inverse of E2: a fact stated zero times.**

Every remedy in this document attacks one shape — a fact stated **twice**, the copies drifting. One
owning declaration, reference it, a gate comparing two artefacts. The narrowing finding is the
**inverse**, and it is harder:

> `PUT /run/state` accepts `idle rehearsal on_air ended` and not `interrupted`, because an
> interruption is **declared by `raiseIncident`** and never commanded — a control room able to set it
> directly would have two ways into one state and only one raises the incident viewers see.

That is one of the most important rules in either contract, and it was **written nowhere**. It was
carried by an omission. Six such rules sat in the most carefully reviewed blocks of the documents.

**An absence has no owning document.** There is no line to reread, no copy to compare, nothing for a
gate to point at, and — worst — no way to distinguish a deliberate omission from an oversight. Every
instrument here was built for the first shape, which is why the second went unnoticed.

The remedy is to make the absence say its own name: `x-arthome-vocabulary-narrowing`, with a mandatory
reason, checked as "every member is a member of the source". Same discipline as `source: none`, and for
the same reason — **an omission that does not say why is not a rule, it is a gap.**

**[floor] Four ways to mis-measure, and they are one family.**

Each of these is a thing you build and then trust without re-reading. All four cost real time in this
repository, three of them mine.

1. **A forecast wearing a number's clothes.** An allowance set to "what the count will be once X
   lands" fails inscrutably when the forecast is off by one, and the failure does not say
   *your prediction was wrong* — it says whatever the gate normally says. **Is this a count someone
   took, or a count someone expects?** (§5.3.1 c)
2. **A bucket named for what you expect to find in it.** A check compared only separators and filed
   case-divergent values under *"absent from the wire"*, which was read as *"domain-only, not yet
   published"*. Ten values comparing false in silence were sitting in a list that had been printed and
   read. A correct measurement of the wrong quantity, whose **label invited the wrong reading**.
   > **Name a bucket for the criterion that puts things in it, never for what you expect to find
   > there.** "Absent from the wire" describes a conclusion; "no exact match after separator
   > normalisation" describes the test. The first gets read as the second by the person who wrote it,
   > within the hour.
3. **A status read through a pipe.** `$?` after a pipeline is the *last* command's status, so
   `gate | head` reports `head`'s success and a red gate reads as green. This has now happened twice
   here, to two different people, against two different gates — including once while measuring whether
   a gate was red. Measure the gate, then pipe; or use `PIPESTATUS`.
4. **A fixture that is the bug.** Covered below, and it happened three times in one session.

**[floor] A gate fails; it does not throw.**

An unhandled exception reads **exactly** like a finding. Two teammates independently reported
`verify:offline` down for everyone on a `NameError`, and both were right that it was down — but
neither the chain nor a human can tell a traceback from a verdict. A crashing gate and a red gate are
the same observation from outside.

So every gate here wraps its entry point and reports a crash as **a defect in the gate**, with a
distinct exit code — `3`, against `1` for a finding and `2` for a malformed exemption — and a message
that says *nothing has been verified, treat this as UNKNOWN rather than as pass or fail*. The three
states a caller must be able to distinguish are **pass, fail, and did-not-run**; a gate that collapses
the third into the second is the green-gate problem inverted.

**[floor] A gate that discovers beats a gate that is pointed.**

The `snake_case` conversion pass was scoped to `packages/core/src/vocabulary/`. **Nine vocabularies
live outside that directory** — in `i18n/`, `replay/`, `entitlement/` — and the pass did not see them,
while `check-vocabulary` did, because it walks the whole tree and keys on the **shape** of a
declaration rather than on where it sits.

> *"Location is not a property anyone intended to matter, which is exactly why it did."*

Any procedure scoped by path inherits this, and a gate scoped by path inherits it silently. So a gate
here **discovers its inputs**: `check-enums` and `check-vocabulary` find every `as const` export by
walking; `check-language` takes its file list from `git ls-files`; `check-tsconfig` globs for projects
rather than being handed a list. The cost is that a gate sees more than you expected, which is the
point.

**[floor] A word list tuned for detection is not a word list you can reuse for validation.**

`arthome-check-language` exempts a quoted French sentence — a mockup string, a stale comment, the
project owner's own words — because translating a quotation destroys what it is doing. The exemption
names its file, its exact text and its reason, and the text must appear **verbatim**, which was meant
to stop an entry widening into a blanket pass.

It did not. Verbatim guarantees the quotation **exists**; it does not guarantee it is **narrow**. A
quotation of `"e"` appears in almost every line, skips every line, and passes the whole file — a
blanket pass through the front door. Demonstrated in a scratch repository rather than argued, because
the first attempt to demonstrate it used the wrong key name in the fixture and reported a clean pass,
which is the house rule below doing its work.

**The first fix was worse than the hole.** Requiring the quotation to contain a word from the gate's
French list rejected `les quatorze entrées de navigation` — manifestly French — because that list is
deliberately **narrow**: it holds only words that cannot be English and cannot be an identifier, which
is exactly what makes it precise when **detecting**. Reusing it to **validate** inverted its purpose.

> **Detection wants few false positives, so its list is narrow. Validation wants few false negatives,
> so it would need a broad one.** They are not the same instrument, and a list built for one is a
> liability in the other.

The bound that works is **structural, not linguistic**: a quotation may cover a quotation, not a
document — at most three lines. It needs no view about language, it refuses `"e"` on the ground that
actually matters, and it cannot be wrong about French. When a rule can be enforced by counting instead
of by judging, count.

**[floor] Testing a gate: verify the fixture, not just the outcome.**

A fixture assembled with `grep` or string replacement broke the YAML twice in one hour — once by
orphaning a block scalar, once by inserting a duplicate key that the parser silently discarded,
keeping the last. Both times the gate then **passed**, and both times the next step would have been to
conclude the gate had a gap.

> **A broken fixture and a broken gate are indistinguishable from outside.** Both are "the gate did
> not fire". So: **build a fixture in the object model, not in the text**, and **verify the fixture
> before believing the result.**

This is a house rule rather than a note, because two people reached it independently within the hour
from opposite directions — one by breaking their own fixtures, one by deliberately probing all three
branches of this gate on a copy rather than trusting its happy path. **Two independent arrivals at the
same rule in one hour is a rule, not a coincidence.**

It is the same shape as "eight, not five": a scan that looks in the wrong place returns an
honest-looking zero. And it is why every branch of a gate here is exercised against a fixture — a gate
whose branches have never run is a gate whose behaviour is a hypothesis.

**Where the YAML-type rule lives, which is a different question from where it was found.** "Every
vocabulary and enum member must be a string" is the **contract's own conformance rule**, so it belongs
in `check-openapi.py`, which travels with the format and checks the contract against itself. This gate
finding it first is what a new gate should do; it is not an argument for the rule living here.

This gate nevertheless keeps its own boolean check, and that is **not** the same rule duplicated —
which would be the parallel-table fault in gate form. The distinction is worth being exact about:

- `check-openapi.py` asserts a **rule**: a member must be a string, because a contract that says
  `False` where it means `'off'` is wrong for every consumer.
- `check-vocabulary.py` asserts a **precondition**: it cannot compare a boolean to a string, so it
  must detect one to know that it is skipping the block, and say so rather than silently pass.

One is a statement about the artefact; the other is a guard on an operation. A guard that disappeared
because "the other gate covers it" would turn this gate's skip into a silent pass — the failure mode
every section of this document is about.

**Where it lives, and why not in `@arthome/tooling`.** In `tools/`, in Python, next to
`check-openapi.py`. Python because it reads OpenAPI and a gate that reads OpenAPI with a real YAML
parser already exists here — hand-rolling a second YAML reader in Node, for a format with four
distinct flow shapes in these two files alone, would be a parallel implementation of parsing. And
`tools/` rather than the shared package because this is a **one-repository rule**: only
`arthome-core` holds both `@arthome/core` and `openapi/`. `arthome-check-language` moved into the
package because it is a seven-repository rule; this one does not, and the distinction is the test to
apply to every future gate.

### 5.4 The shape of a repository

Common to all seven — what must exist and carry this name:

```
<repository>/
├── .npmrc                  @arthome registry (no token)
├── .gitattributes          * text=auto eol=lf
├── .nvmrc                  24
├── .prettierignore         Markdown, mockups, generated output (§3.7)
├── eslint.config.js        floor + stack + prettier last (§4.3)
├── .prettierrc.mjs         only if overriding — otherwise package.json's "prettier" field
├── tsconfig.json           extends @arthome/tooling/tsconfig/{app|lib}.json
├── package.json            packageManager: "pnpm@<installed>", engines.node
├── README.md               what this repository is, how to run it, how to verify it
└── src/                    organised by domain (§5.2)
```

Two repositories have a pnpm workspace (`arthome-core`, `arthome-platform`): `packages/*` for one,
`services/*` and `infra/` for the other (README §3). The five applications are plain repositories,
each with its own `node_modules` and its own lockfile — which is what makes the Metro/pnpm friction
described in the handoff dossier disappear.

**`README.md` is mandatory and it carries three things**: what the repository is, how to run it, how
to verify it. A showcase repository whose `README` does not say how to run the gates has no gates, as
far as an outside reader is concerned.

### 5.5 Imports and their order

**[floor]** The order is held by `import-x/order`, at `error`, fixable with `--fix`. Prettier does not
sort imports (§3.3), so **no overlap**.

Groups, separated by a blank line, in this order:

1. `builtin` — `node:fs`, always with the `node:` prefix
2. `external` — third-party dependencies
3. `internal` — `@arthome/core`, `@arthome/contracts`
4. `parent`, `sibling`, `index` — relative

Alphabetical within each group, case-insensitive.

**[floor] Forbidden, each with the real defect it prevents:**

| Forbidden | Rule | Defect avoided |
|---|---|---|
| going up more than one level (`../../`) | `import-x/no-relative-parent-imports` (outside tests) | a deep relative path is coupling between domains that nobody saw |
| an import cycle | `import-x/no-cycle` | on NestJS under ESM it is a TDZ at boot or a `TS1272`, and the message does not name the cycle |
| importing a type without `import type` | `@typescript-eslint/consistent-type-imports` | a type import that survives compilation keeps a whole module alive — **the** cause of dead weight on Metro |
| importing from `dist/` or a package's internal path | `no-restricted-imports` | short-circuits `exports`, therefore the contract |

**[floor] A barrel file (an `index.ts` re-exporting everything) is forbidden in
`@arthome/contracts`**, and discouraged everywhere else. This is not a taste: it is **D-012**,
measured independently by two agents — zod's barrel entry point made 64 translation files reachable,
**93 KB gzip versus 7.5 KB**, at a cost that is **fixed, not marginal**. **And versus 85 KB when tree
shaking is off**, which is Metro's default: the third row of D-012's table, without which the first
two read as a saving somebody has collected. The rule holds on the *fixed* half, not on the saving. A barrel defeats tree-shaking
on any bundler that does not do cross-module analysis — which includes Metro by default.

### 5.6 Error handling

**[floor] Three kinds of error, three treatments.** The fault to avoid is conflating them, because
they have neither the same recipient nor the same retry policy.

| Kind | What it is | Treatment |
|---|---|---|
| **Domain error** | a business rule says no: capacity full, replay window closed, missing entitlement | a typed error class from `@arthome/core`, carrying a **stable code**; never a string |
| **Infrastructure error** | the network, the database, the broker | propagated as is, with its cause; retry policy decided at the call site, not at the throw site |
| **Programming defect** | broken invariant, `assertNever` reached | let the process die; do not catch |

**[floor] Checkable rules:**

- `@typescript-eslint/no-floating-promises` at **error** — a type-aware rule, and one of the reasons
  Biome was ruled out (D-013). An orphaned promise is an invisible failure;
- `@typescript-eslint/no-misused-promises` at **error** — an `async` passed where a synchronous
  callback is expected, and the error vanishes;
- `@typescript-eslint/only-throw-error` at **error** — we only throw `Error`s;
- `@typescript-eslint/use-unknown-in-catch-callback-variable` at **error**, plus
  `useUnknownInCatchVariables` in `tsconfig`: a `catch (e)` gives `unknown`, not `any`. This is the
  entry point through which `any` most often returns to a strict project;
- a `catch` that only logs **and** carries on is a defect, not a treatment: either you catch and
  decide, or you let it propagate.

**[floor] A domain error's code comes from `@arthome/core`, like an enumeration value** — and is
therefore subject to the §5.3 gate. This project uses **code-based i18n** (D-012): a library message
cannot be displayed, and a code invented on the spot cannot be translated.

**The boundary error envelope** — its shape, its fields, the "your connection" versus "our servers"
distinction raised by the surface specialists — belongs to `@arthome/contracts` and to
`architecture/context-map.md`. This document only requires that it be **one single shape**, defined
once.

### 5.7 TypeScript — what is not negotiable

**[floor] Locked in `@arthome/tooling/tsconfig/base.json`:**

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,     // array[i] is T | undefined — the #1 production error source
    "exactOptionalPropertyTypes": true,   // { a?: string } does not accept { a: undefined }
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "useUnknownInCatchVariables": true,
    "isolatedModules": true,              // Metro, SWC and esbuild transpile file by file
    "verbatimModuleSyntax": true,         // forces `import type`, removes elision ambiguity
    "forceConsistentCasingInFileNames": true,
    "types": []                           // TS 6 requires it in practice: no more auto-discovery
  }
}
```

`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are the two people grumble about and the
two that pay. They are **on from day one**: turning them on over an existing codebase costs ten times
more, and that is precisely the scheduling reason behind D-013.

**[floor] Forbidden, with their rule:**

| Forbidden | Rule | Exception |
|---|---|---|
| explicit `any` | `@typescript-eslint/no-explicit-any` | `src/generated/**` (§4.5) |
| unchecked `as T` | `@typescript-eslint/consistent-type-assertions` (`objectLiteralTypeAssertions: 'never'`) | `as const`; a `satisfies` almost always does the job |
| the `!` non-null assertion | `@typescript-eslint/no-non-null-assertion` | none: write the check |
| `@ts-ignore` | `@typescript-eslint/ban-ts-comment` | `@ts-expect-error` **with a description**, never `@ts-ignore` — the difference is that `@ts-expect-error` becomes an error the day the problem is fixed |
| `enum` | `no-restricted-syntax` on `TSEnumDeclaration` | none (§5.3) |
| `namespace` | `@typescript-eslint/no-namespace` | third-party declaration files |
| `require()` in TypeScript | `@typescript-eslint/no-require-imports` | `metro.config.js` and other CJS configuration |

**`satisfies` rather than `as`, and this is a writing instruction, not only a ban:** `as` tells the
checker to be quiet; `satisfies` asks it to check **and then** keep the precise inferred type. For a
configuration object or a lookup table, `satisfies` is always the right answer — and it preserves the
narrowing the §5.3 gate depends on.

**Type-aware linting is mandatory** — `parserOptions.projectService: true` in the base configuration.
Without it, `no-floating-promises`, `no-misused-promises`, `await-thenable` and
`no-unnecessary-condition` do not run. That is **what Biome does not have**, and the reason for D-013;
a repository that switches it off to save time has cancelled the decision.

### 5.8 Tests

**[floor] Vitest everywhere** — but not the same version (§4.3): `^4.0.8` on the two Angular
repositories, `5.0.1` elsewhere. A forced divergence, not an accepted one; it disappears with
Angular 23.

**[floor] Location:** the test sits **next to** the file it tests, `<name>.spec.ts`. No `__tests__`
directory, no parallel `test/` tree — a parallel tree always ends up diverging from the structure it
mirrors, and that is E2 wearing another face.

`.spec.ts` rather than `.test.ts`: it is what Angular imposes (`user-profile.spec.ts`), and aligning
the other five costs nothing.

**[floor] Naming a case:** a sentence describing the **expected behaviour**, not the function called.

```
✗ it('calls computeRemainingSeats')
✓ it('reports zero remaining seats once capacity is reached')
```

**[floor] No mocking of anything that comes from `@arthome/core`.** The domain is pure and
deterministic — mocking it means testing the mock. In fact we want the opposite: `@arthome/core`'s
deterministic `fixtures/` (README §3) are the **reference** dataset for the tests of all seven
repositories. A test that hand-builds a value `fixtures` can produce is a **parallel literal table** —
E2, again.

**What the floor deliberately does not impose:** a numeric coverage threshold. On a solo project a
global threshold produces tests written for the number. What is required is targeted: the
`@arthome/core/domain/**` modules (capacity, replay window, commission, entitlements, time zones) are
tested exhaustively on their **boundaries**, because those are what compose the values
`corrections-handoff.md` found diverging everywhere. `definition-of-done.md` has the last word on what
makes a batch finished.

### 5.10 Comments — delete by default

**[floor] The default is no comment.** The first instrument is the NAME: `waitUntilDue` needs no
gloss, `handleRetryTiming` needs one. Name it, then comment only what a name cannot carry (§5.2).

**[floor] A comment survives only if it answers what the code cannot.** The test: *would a reader
with this code in front of them learn something they could not derive from it?*

**Keep** — a measured failure, with what it cost · a constraint invisible at that line · a decision
and its reason, where the code shows only the outcome · a `⚠` where the obvious change is wrong.

**Delete** — a comment on trivial code (a delegate, a getter, a `findAll` calling `Model.findAll`) ·
any block above a name that already carries it · JSDoc restating the signature · narration of a
readable sequence · history ("before this there was no…") · a default or a library behaviour
explained · **prose about what the file does *not* do**, which rots first because nothing fails when
it stops being true · a second copy of `DECISIONS.md` — link instead.

**[floor] TypeScript already documents the types, so JSDoc must not.** The signature gives the
parameter names, their types and the return type; repeating any of it is noise — `@param source - the
source`, `@returns the result`, a line naming a type the annotation states. JSDoc earns its place in
two cases only, never systematically: a parameter whose **meaning** the type cannot give (units, a
range, what must be true before calling, which of two same-typed arguments is which), and a **union
return** — which branch comes back and when. `Promise<'indexed' | 'superseded'>` gives the shapes, not
their causes.

**Where one line does, use one line, and give the scope rather than the whole story.** No account of
the why and the how from A to Z: enough to situate it. A surviving `⚠` is two to four lines, never
ten.

⚠ **NEVER DELETE A RECORDED MEASUREMENT.** Shorten its prose to one sentence; keep the fact. The
failure mode this rule replaces is verbosity, and the one it could create is losing the paragraph
that stopped a defect coming back.

**Two exceptions, narrow.** A gate's header block, which records the defect it was built against and
the scope it does **not** cover. And one line on an exported name saying what it *is* — including
when that restates the code, because `REPOSITORY_MAP.md` is generated from it and a reader of 543
names has no code in front of them. That line names the export and never opens on `⚠`.

**Apply it opportunistically**: any file you read is one you may shrink.

#### Four shapes, each measured on this repository

1. **Paying yourself in comment lines for what the discovery cost** — the mechanism behind the other
   three. A line just fought for feels load-bearing, so each gets a paragraph. The effort of finding
   something out is **not the reader's problem**: it belongs in the commit message.
2. **A default written out with a paragraph defending it.** `migrationsTransactionMode: 'all'` is
   TypeORM's default and had ten lines arguing for it. Delete both, the option included.
3. **A comment on a self-documenting option.** `applicationName` had four lines saying what
   `applicationName` is for.
4. **JSDoc attached to nothing**, which defeats every ratio: TypeScript associates only the **last**
   of consecutive `/** */` blocks. Eighty lines in `packages/core/src/schema/vocabulary.ts` held two
   real findings above a private constant while the function they described seventy-five lines below
   had none. An export with a blank `REPOSITORY_MAP.md` description is how you find them.

⚠ **This rule was itself 989 words and produced dissertations in the code it governed.** A long rule
about concision teaches the register it forbids.

### 5.9 Commit messages

**[floor] `<area>: <subject>`, in English.** The language is D-008's; the format is this document's.

```
<area>: <subject>                  the common case
<area>(<scope>): <subject>         when the area is wide enough to need narrowing
<Milestone>: <subject>             a wave, a time, a phase — which milestone the change belongs to

<optional body: why, never what — the diff already says what>

<optional footer: BREAKING CHANGE:, Refs: …>
```

**Which half of this rule is arbitrated, and which half is not.** D-008 says: "`arthome-core` is
committed at the end of phase 0, then at the end of each of the three times. **Messages in English.**
No remote, no push, ever." It settles cadence, language and pushing. So **"in English" is not this
section's to change** — changing it reopens an arbitration, which §7.1 does not permit. The format is
not in D-008 and never was: it is a convention this document owns and may revise on its own
authority. An earlier version of this section read "[floor] Conventional Commits, in English, per
D-008" and hung both halves on that citation. The citation was never made; §8.4 records how it was
found.

**The area** names where the change lands — a package, a service, a surface or a concern: `core`,
`contracts`, `tooling`, `identity`, `catalog`, `ticketing`, `chat`, `payouts`, `streaming`,
`notifications`, `messaging`, `search-indexer`, `events`, `testing`, `hooks`, `conventions`,
`storefront-web`, `storefront-mobile`, `storefront-tv`, `studio-web`, `studio-mobile`. It may instead
name the **kind** of change, when one kind of change crosses several places: `docs`, `fix`, `feat`,
`chore`, `refactor` are all in use as areas in `arthome-core`, and `docs` is the single most frequent
area in the repository. Lowercase, hyphens allowed. An area that matches nothing on either list is
usually a commit doing two things.

**The scope**, in parentheses, narrows an area wide enough to need it: `fix(openapi)`, `feat(tools)`,
`docs(architecture)`. A decision number is a legitimate scope — `docs(D-069)` — which is why the scope
is the one part of the shape allowed a capital.

**The milestone label** is capitalised and at most four words: `Wave 3`, `Wave 2 scaffolding`,
`Time 3`, `Core wave 5`, `Stage 0`, `Audit fixes`, `Resilience`. It answers a question no area name
can: *which milestone does this change belong to*. Four words is the observed ceiling across both
repositories, and it is what makes the label mechanically distinguishable from a sentence.

**Why Conventional Commits was refused, so that nobody reintroduces it as an obvious improvement.**
Conventional Commits exists to drive two machines from the commit log: a changelog generator and a
semver bump. **Neither is driven from the commit log here, and that is by decision rather than by
omission.** Three packages are published to GitHub Packages (D-014), so "nothing is published" would
be the wrong reason — the right one is that nothing *reads the commits*. No changelog is generated
from git: the only changelog in the repository is `oasdiff changelog`, and it reads OpenAPI
(`definition-of-done.md`). No version is derived from a subject line either: §7.1 gives every bump to
one person, in three regimes, with the majors recorded in `DECISIONS.md` and the versions exactly
pinned — a `feat:` cannot mint a minor when the pin is the decision. So the format would charge the
only currency a subject line has, its width, and buy machinery nobody has wired. It is not that
Conventional Commits is bad; it optimises for something that does not run here, and the
twelve-of-thirteen measurement in §8.4 is what paying that price looks like.

**What the practice buys that `type(scope):` cannot express.** Two things, and both are load-bearing
here. First, the **area** is free to be a place *or* a kind, so `search-indexer:` and `docs:` are both
sayable; the `feat|fix|chore` vocabulary forces every place-shaped change to be filed under a kind,
and `messaging:` becomes `feat(messaging):` — a word longer and no more informative. Second, the
**milestone**: a repository built in waves needs `Wave 2 scaffolding:` to say that a commit is
groundwork for work that has not started, and there is no Conventional Commits type for *groundwork
for a milestone*. Losing that is losing the only record of why an empty tree was committed.

**The subject is prose, and prose is not an imperative.** The practice is a noun phrase naming what
the commit contains, very often in two halves — what was done, and what it cost or revealed: "one
package the seven services share, **and the poison row that forced it**". Fourteen of the last
twenty-six subjects have that shape. It is lowercase unless the first word is a proper noun
(`testing: Kafka Connect and a shared network…`) and carries no trailing period — zero of the last
twenty-six do. **None of that is checked**, because a pattern cannot tell a noun phrase from an
imperative, nor a proper noun from a stray capital, and a gate that misjudges even occasionally
teaches people to pass `--no-verify`. It is style, held by whoever writes it.

**There is no 72-character rule, and there never truthfully was one.** Of the last twenty-six
subjects across the two repositories, fifteen exceed 72 bytes, the mean is 76 and the longest is 107.
A 72-character ceiling would reject more than half of the practice it claims to describe. The only
length the hook enforces is 140 bytes, and that is not a style target: it is there to catch a
paragraph, or a body, pasted onto the subject line. Name the failure it prevents and it is obvious
how loose it should be.

**[floor] A `BREAKING CHANGE:` is mandatory** for any change to the public surface of
`@arthome/core`, `@arthome/contracts` or `@arthome/tooling`. For `@arthome/contracts` it counts as a
**contract change** and triggers the reasoning of §7.1. A `!` before the colon — `contracts!: …` —
may flag it in the subject; the footer is what is mandatory.

**The gate, with no dependency** — `commitlint` would mean a package, a configuration and a hook to
maintain in seven copies. `.githooks/commit-msg` does the same job in eighteen lines of logic, and it
is written, installed and exercised against real history: §8.4.

---

## 6. What legitimately stays specific to each stack

**The principle.** Unify what travels from one repository to another — names, errors, imports, tests,
formatting. **Do not unify what a framework holds for itself**, because forcing alignment costs rule
disables, and a disable you repeat becomes a disable you forget.

The test that settles it: **would forcing uniformity here make me switch off a rule that catches real
faults?** If yes, the divergence is legitimate. Every case below passes that test.

### 6.1 Angular 22 — `arthome-studio-web`, `arthome-studio-mobile`

**What is added:** `angular-eslint@22.5.0` (peer `eslint ^9 || ^10`, `typescript-eslint ^8`,
`@angular-devkit/core >=22 <23`), in two blocks — one for `.ts`, one for `.html`:

```js
// eslint.config.js — the two Angular repositories, shape
export default defineConfig([
  ...base,                                        // @arthome/tooling/eslint/browser
  { files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended, ...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates },  // ⚠ without this, inline templates go unlinted
  { files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended,
              ...angular.configs.templateAccessibility] },
  prettier,                                       // LAST
]);
```

**Why this is legitimate and not laxity:** template linting is **the written reason** Biome was ruled
out (D-013). `@angular-eslint/eslint-plugin-template` catches faults no TypeScript analyser can see —
a binding to a non-existent property, an `*ngFor` without `trackBy`, a badly nested `@if`, a control
with no accessible label. In a broadcast control room, `templateAccessibility` is not a nicety: it is
half the interface faults.

**What diverges from the floor, and why:**

| Divergence | Reason |
|---|---|
| **no `.component` / `.service` suffix on file names**: `user-profile.ts`, class `UserProfile` | this is the Angular convention since v20, and the default of the CLI schematics. Forcing the suffix means passing `type` + `addTypeToClassName` on every generation, forever. The floor does not arbitrate the role suffix (§5.2) |
| `typescript` nailed to `6.0.3` | `@angular/compiler-cli@22.1.7` (§1.2) |
| `vitest ^4.0.8` | outside Angular's peer range otherwise (§4.3) |
| a local `.prettierrc.mjs` with `parser: 'angular'` | a direct consequence of dropping the suffix (§3.6) |
| `OnPush` **is** the default strategy | from Angular 22 on, the opt-out is `ChangeDetectionStrategy.Eager` and `Default` is deprecated |

**Two Angular 22 traps that no ESLint rule catches**, worth writing down here because they are
silent:

- **zoneless.** It is the bootstrap default since Angular 21. In a zoneless application,
  `NgZone.run()` schedules nothing (`NgZone` is bound to `NoopNgZone`, whose `run` is
  `fn.apply(...)`), `runOutsideAngular()` is a pass-through, `isStable` is permanently `true` and
  `onStable` / `onMicrotaskEmpty` never fire. A stale view is fixed **in this order**: write to a
  signal → `ChangeDetectorRef.markForCheck()` → `ApplicationRef.tick()` as a last resort.
- **you do not add `provideZonelessChangeDetection()`** to a new application: zoneless is the
  **absence** of a provider. It is the opt-out that gets written.

### 6.2 React 19.3 — `arthome-storefront-mobile`, `arthome-storefront-tv`, and Next's React side

**What is added:** `eslint-plugin-react-hooks@7.1.1`, flat preset:

```js
import reactHooks from 'eslint-plugin-react-hooks';
// …
{ files: ['**/*.{ts,tsx}'], ...reactHooks.configs.flat.recommended },
```

**The version trap, verified:** at version 7, `configs.recommended` became an `eslintrc`-format object
(16 rules); spreading it into a flat array **fails at load** with a message about `eslintrc` that
looks like a bug in your config. Version 6's `flat/recommended`, `recommended-legacy` and
`recommended-latest-legacy` keys **no longer exist**. In flat config you write
`reactHooks.configs.flat.recommended`, and nothing else.

**To be expected, and it is not a regression:** going from 6 to 7 turns a healthy codebase red —
`recommended` goes from 2 rules to 16 and switches the compiler rules on. **You fix; you do not pin
back.**

**Why this is legitimate:** these rules are the other half of the reason Biome was ruled out (D-013).
And above all, **an `eslint-disable` of a `react-hooks/*` rule makes the React Compiler bail out of
the entire function** — category `Suppression` — emitting it unoptimised, logging nothing, build
green. It is the textbook case of a rule that must stay on: disabling it does not hide a warning, it
**cancels an optimisation** elsewhere.

Hence the practical consequence, worth remembering: **`--report-unused-disable-directives` (§4.5) is
not cosmetic tidying on these two repositories**; it is the only detector of forgotten `react-hooks`
disables, and therefore of silently uncompiled components.

**The React Compiler, if and when it is switched on:** `babel-plugin-react-compiler@1.0.0` is an
opt-in build setting, **never a React 19 default**. Three rules:

- **pin it exactly** — a shift in memoisation granularity can make an Effect over- or under-fire,
  which thin end-to-end coverage will not see;
- **never delete** an existing `useMemo` / `useCallback` / `memo` on the grounds that the compiler is
  on: one that feeds an Effect's dependencies changes behaviour when removed;
- **`'use no memo'` goes inside the function body**; at module scope it silences the file **and**
  still logs `CompileSuccess`, so any coverage script will count it as compiled.

And `eslint-plugin-react-compiler` **is not installed**: last published August 2025, never left RC.
Its rules live in `eslint-plugin-react-hooks`.

### 6.3 Expo — `arthome-storefront-mobile`, `arthome-storefront-tv`

> **D-025 chooses Expo** for both surfaces. What follows holds for Expo as it does for bare React
> Native — it is Metro and the absence of a TypeScript constraint that govern, not the project
> manager. What changes with Expo: `eslint-config-expo` joins the list of stack presets
> `@arthome/tooling` does not carry, and it is **its** `eslint` peer that will have to be checked at
> the mobile stage, alongside `@react-native/eslint-config`'s.

**What is added:** `@react-native/eslint-config@0.87.1`, through its `./flat` entry point.

**Two forced, dated divergences:**

| Divergence | Verified cause | Exit condition |
|---|---|---|
| **ESLint 9.39.5** (not 10.11.0) on these two repositories | `@react-native/eslint-config@0.87.1` has peer `eslint ^8.0.0 \|\| ^9.0.0` — **not 10** | a release of `@react-native/eslint-config` accepting ESLint 10 |
| a **second copy** of `eslint-config-prettier`, at **major 8** | the RN preset depends on it (`^8.5.0`) | the same |

The second row is exactly what D-014 called "a linter installed twice in two versions". It is
**harmless here**, for a precise reason: our `eslint-config-prettier/flat` at 10.1.8 is placed **last**
(§3.2) and therefore takes back control of anything the major-8 copy may have let through — notably
the `@stylistic` rules, which version 8 knows nothing about. But "harmless" is not "verified": the
§3.5 gate is what **proves** it, on these two repositories more than anywhere else, and that is where
it earns its cost.

`@arthome/tooling` declares `eslint: "^9.39.5 || ^10.11.0"` as a peer to cover both worlds (§4.2).

**What else is added, specific to the bundler:**

- **`metro.config.js` does not read `tsconfig.json`.** Metro transpiles via Babel with no type
  checking, so `@arthome/tooling`'s `extends` **never** concerns it (§4.4.4). The `paths` declared in
  TypeScript must however be **replicated** in Metro's configuration. That duplication is
  unavoidable, so treat it as such: a cross-reference comment in both files, and the `tsc --noEmit`
  gate that fails if one diverges from the other (it will fail on the import, not on the duplication —
  indirect proof, and better than nothing).
- **`exports` resolution, by contrast, is settled.** It has been **on by default** in Metro since 0.82
  (React Native 0.79), therefore here: the barrel-free entry point of `@arthome/contracts` (D-012) is
  the one Metro resolves. If a third-party package ever breaks on it, the escape hatch is
  `resolver.unstable_enablePackageExports: false` — **and then the whole repository falls back to
  legacy resolution**, our packages included. Not to be done without measuring.
- **Tree-shaking is not settled.** D-012 records it: the `zod/mini` gain is **conditional on
  tree-shaking that the React Native bundler does not enable by default**, and the measurement
  (7.5 KB versus 93 KB) was taken on an isolated schema compiled by esbuild, not on a real application
  bundle. The rule that follows is firm: **no barrel file** (§5.5), and verification on a real bundle
  at the mobile stage.
- **The TV has no keyboard.** That is not a code convention, but it has a code consequence: any input
  longer than six characters must be a device pairing flow. The contract carries it; this document
  repeats it so that nobody writes a form on the TV out of habit.

**Two repositories and not one**, despite very similar code: that is the multi-repository structure of
README §3, and it is what makes the `react-native-tvos` / Expo conflict in a shared workspace
disappear. The price is duplication; it is paid deliberately, and `@arthome/tooling` plus
`@arthome/core` are what make it bearable.

### 6.4 Next 16 — `arthome-storefront-web`

**What is added:** `eslint-config-next@16.3.5`, as two flat presets:
`eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`, composed as in §4.3.

**Two version points, verified in the Next 16.3.5 documentation:**

- **`next lint` has been removed since Next 16.** You call the ESLint CLI directly, and the `eslint`
  option in `next.config` no longer has any purpose. A recipe that says `next lint` predates Next 16.
- Next's documentation **itself recommends** `eslint-config-prettier` imported from
  `eslint-config-prettier/flat` and placed after `nextVitals`. That is exactly the §3.2 arrangement:
  this document's rule is not a local invention.

**Why this is legitimate:** `@next/eslint-plugin-next` catches framework-specific faults that are
otherwise invisible — a Client Component declared `async`, an `<a>` to an internal route, an `<img>`
instead of `next/image`, `beforeInteractive` outside the document. None of that is a style opinion;
they are performance and rendering regressions, and `core-web-vitals` promotes them from warning to
error, which is the right level for a showcase.

**Mind `types: []`** (§2.3 d): Next needs its global types. The repository's `tsconfig.json` adds
`"types": ["node"]` and keeps the `next-env.d.ts` reference — which stays in `globalIgnores`, because
it is generated.

### 6.5 NestJS 12 — `arthome-platform`

**What is added:** the Node configuration (`@arthome/tooling/eslint/node`) and rules compatible with
decorator-based injection.

**What diverges from the floor, and why it is legitimate:**

| Divergence | Reason |
|---|---|
| **the role suffix on file names is kept**: `booking.service.ts`, `booking.controller.ts`, `booking.module.ts` | this is what the NestJS CLI schematics generate, and the CLI is used. Fighting the generator across seven services is losing. **The exact opposite of Angular (§6.1), and both are right at home** — the floor deliberately declined to arbitrate the role suffix (§5.2) |
| "unused" constructor parameters are tolerated | constructor injection uses them; `@typescript-eslint/no-unused-vars` needs `args: 'after-used'` and an exception for parameter properties |
| `experimentalDecorators` and `emitDecoratorMetadata` | NestJS depends on them for injection. Verified: TypeScript **7.0.2**'s `tsc` still emits `design:paramtypes` — so this is not what will block the upgrade |
| `typescript` at `6.0.3` | `nest build` aborts on TS 7.0 (§1.2) |

**Three build traps, verified, which belong in this document because they are silent:**

- **The choice of builder decides whether the CLI plugins apply.** Measured on `nest-cli` 12.0.3 with
  `@nestjs/swagger` 12.0.1 and a DTO without `@ApiProperty`: `tsc` → the schema carries the
  properties; `swc` → schema **empty, no error**; `rspack` → empty schema, and the build reports
  "compiled successfully". A service publishing an empty OpenAPI and a service publishing a correct
  one have exactly the same build output. **Mandatory gate**: compare the produced `/docs-json`
  against the `openapi/` contract.
- **Non-TypeScript files are not copied** into `dist/` until `assets` lists them. This targets the
  `.proto` files directly (README §3): they must be listed, otherwise the service starts and fails on
  the first gRPC call.
- **One TypeScript version in the pnpm workspace** (§2.5): mixing TS 6 and TS 7 across packages makes
  the Swagger plugin resolve whichever TypeScript is hoisted first, and it fails.

**Why Biome would have failed here too:** `no-floating-promises` and `no-misused-promises` are
**type-aware** rules. In a seven-service system an orphaned promise is a lost message, and that is the
kind of defect that shows up as a data inconsistency three days later.

### 6.6 Ionic 9 and Capacitor 8 — `arthome-studio-mobile`

**What is added** on top of Angular (§6.1), and it is not a matter of style but of runtime:

- the application runs under the **`capacitor://localhost`** (iOS) and **`https://localhost`**
  (Android) origins — which decides CORS, cookies and their attributes, and therefore what the
  authentication contract must provide for (`architecture/adr-auth.md`);
- `android/` and `ios/` are **committed**. They are sources, not artefacts. The repository's
  `.gitignore` must preserve them explicitly, because most `.gitignore` templates exclude them;
- `capacitor.config.ts` is subject to the same rules as the rest of the repository's TypeScript — it
  is a source file, not exempt configuration;
- deep links are a URL contract between the application and the web: their shape belongs to
  `architecture/context-map.md`, not to this document.

**Why this is legitimate:** none of it is arbitrable by a code convention. These are the constraints
of a native host, and ignoring them produces errors that only appear on the device.

---

## 7. Version governance — seven repositories, one person

### 7.1 Who decides, and by what rule

**One person decides**, and every version bump that crosses a major is recorded in `DECISIONS.md` with
its reason. This is not bureaucracy on a solo project: it is the only way to know, six months later,
whether a pin is a constraint or a habit.

**Three regimes, and membership of a regime has to be justified:**

| Regime | What belongs in it | Form |
|---|---|---|
| **A — exactly pinned, a bump handled as a contract change** | what **several repositories** must see the **same way at runtime** | exact version, `peerDependencies` wherever it is exposed |
| **B — exactly pinned, coordinated bump** | the tooling that decides whether the build passes | exact version, `devDependencies` |
| **C — range, bumped as it comes** | everything else | `^`, and the lockfile is the record |

**Regime A — the list, and it is short:**

| Package | Version | Why A |
|---|---|---|
| **`zod`** | **4.6.5** | **Settled by the project lead**: a runtime dependency shared by seven services and five applications. A `peerDependency` of `@arthome/contracts`, exactly pinned. **A zod major is handled as a contract change.** Two zod copies in one process means two schema registries and unintelligible validation errors |
| **`typescript`** | **6.0.3** | §2.2. One version per repository and the same across all seven; Angular's ceiling is hard and type-aware linting depends on it |
| `@arthome/contracts`'s Protobuf runtime | to be fixed with `buf` | the same reasoning as zod: a shared serialisation runtime whose major changes the shape on the wire |

**And nothing else.** That is D-013's instruction — "apply the same reasoning to what deserves it, and
to nothing else". The membership test for A, in one question: **if two repositories hold two different
versions at the same time, does something break at runtime, in a way that is hard to diagnose?**
`zod`: yes. `typescript`: yes, through the `.d.ts` and the lint. The Protobuf runtime: yes. `react`:
no — each application has its own `node_modules` and its own process. `eslint`: no — that is tooling,
regime B.

**Regime B:** `eslint`, `@eslint/js`, `prettier`, `eslint-config-prettier`, `typescript-eslint`,
`vitest`, `@arthome/tooling`, `pnpm`, Node. Exactly pinned, bumped in the order of §7.3.

**Regime C:** everything else. The lockfile is committed in all seven repositories and is the record;
it is what makes a build reproducible, not the ranges.

### 7.2 Node and pnpm — one version, written three times

**Node 24 "Krypton" (LTS)** in all seven repositories. It is the only line satisfying the four floors
read off the registry:

| Requirement | Source |
|---|---|
| `^22.22.3 \|\| ^24.15.0 \|\| >=26` | Angular 22 (`@angular/compiler-cli`) — **the most demanding** |
| `^22.13.0 \|\| ^24.3.0 \|\| >=26` | React Native 0.87.1 |
| `^20.19 \|\| ^22.13 \|\| >=24` | ESLint 10 |
| `>=20.11` | `@nestjs/cli` 12 |

Node 26.9.0 exists but is not yet LTS; 22.23.2 "Jod" would also do and will go end-of-life first.
**Node 24.**

Written in three places, because three different tools read it:

```
.nvmrc                              →  24
package.json → "engines": { "node": "^22.22.3 || ^24.15.0 || >=26" }
package.json → "packageManager": "pnpm@12.4.2"
```

**`engines` carries the constraint, not the day's version.** Writing `^24.21.0` would mean rejecting a
machine on 24.19.0 — which nonetheless satisfies all four floors. The range is Angular's, the most
demanding of the four: it is the one that decides, and the only one worth copying. Likewise `.nvmrc`
carries `24` and not a precise patch, so as not to trigger a download on every upstream patch bump.

**`packageManager` carries an exact version**, because that is its job: Corepack installs that one. We
write **the version actually in use on the machine**, not the registry's latest — otherwise the day's
first `pnpm` goes off to fetch a version nobody chose. It is the measure that costs least and prevents
the most "works on my machine" between a laptop and a runner.

### 7.3 The bump order, and why it is this one

Every bump of a regime-B package follows this order, **one repository at a time**:

1. **`arthome-core`** — it produces `@arthome/tooling` and eats its own cooking (§4.6 e); if it does
   not pass, nothing ships;
2. **`arthome-platform`** — seven services, but one repository and one workspace; it gives the most
   signal for the least handling;
3. **`arthome-storefront-web`** — Next, the most tolerant stack;
4. **`arthome-studio-web`** — Angular, the most constrained; what passes here will pass on studio
   mobile;
5. **`arthome-studio-mobile`** — Angular plus the native layer;
6. **`arthome-storefront-mobile`**, 7. **`arthome-storefront-tv`** — last, because these are the ones
   carrying the forced divergences (ESLint 9) and you want to know the state of the other five before
   touching them.

**The rule that matters more than the order: never two repositories in transit at once.** Seven red
repositories at the same time, for one person, is a lost evening and a temptation to switch rules off.

### 7.4 How the repositories are kept from drifting

Four mechanisms, from the most mechanical to the most human:

1. **`@arthome/tooling`** (§4) — the configuration exists in one place only;
2. **pnpm catalogs**, in the two workspace repositories. `pnpm-workspace.yaml` declares the versions,
   the `package.json` files write `"zod": "catalog:"`, and **pnpm replaces `catalog:` with the real
   version on publish** — an outside consumer never sees the protocol. That settles consistency
   **inside** `arthome-core` and `arthome-platform`;
3. **across the seven repositories there is no catalog** — that is the limit of the multi-repository
   layout, and it is accepted. The substitute is a gate, not a hope: `@arthome/tooling` exposes a
   check comparing the declared and installed regime-A and regime-B versions against the expected
   ones, declared in a file of that package.

   ```bash
   pnpm exec arthome-check-versions
   ```

   It fails if `typescript`, `zod`, `eslint`, `@eslint/js`, `prettier`, `eslint-config-prettier`,
   `typescript-eslint` or `vitest` is not at the version expected for this repository's stack, named
   exceptions included (§1.2, §6.3).

   The expected-version table lives in `@arthome/tooling/versions.json` — **one table, not seven**.
   That is the E2 answer applied to versions: without it, every `package.json` would be one more
   parallel literal table, and we know what happens to parallel tables on this project.

   **It also reads the pnpm store, and that is not decoration.** The design failed here once: because
   `@arthome/tooling` declared `eslint` as a peer without pinning it in its own `devDependencies`,
   pnpm auto-installed a peer for the workspace package and chose the **lowest** member of the range —
   `eslint@9.39.5`, while the root had `10.11.0`. Two copies, both working, differently, and nothing
   was red. The gate now scans `node_modules/.pnpm` for two versions of any singleton, because the
   store is where duplication is visible and `package.json` is where it is invisible.
4. **the bump log** (§7.5), the only non-mechanical piece, and therefore the most fragile.

### 7.5 Keeping §1 up to date

The §1 table goes stale. **The rule: never answer about a version from memory.** The four commands
that rebuild it:

```bash
# what `latest` is today, for the packages that decide
npm view eslint prettier eslint-config-prettier typescript typescript-eslint version
npm view angular-eslint eslint-config-next eslint-plugin-react-hooks vitest version

# what the stacks actually require — the only source that counts
npm view @angular/compiler-cli@latest peerDependencies
npm view typescript-eslint@latest peerDependencies
```

When a §1 row changes, update it **in this file**, with the date. A dated and correct table is
infinitely better than an undated one nobody knows the currency of.

### 7.6 A bump pins a version that is already mature

**This section exists because two decisions in this document contradicted each other, and the
contradiction only appeared at the first `pnpm install`.**

The facts. §1 pins the versions **verified on the day** (21 September 2026). §4.6 f sets
`minimumReleaseAge: 10080` — pnpm refuses anything published less than seven days ago. Both cannot
hold: **pinning the day's latest guarantees it will be too fresh.** Five packages were refused on the
first install — `prettier@3.9.8`, `eslint@10.11.0`, `vitest@5.0.1` and two `@vitest/*`.

Neither decision is wrong on its own. The conjunction is, and it is the kind of defect no amount of
re-reading finds, because each half is defensible in isolation.

**The durable rule, and it replaces nothing above — it completes it:**

> **A version bump pins a version that is ALREADY MATURE — never the day's.** Read the registry, then
> pin the most recent version that is **older than `minimumReleaseAge`**. In practice: the newest
> version published more than seven days ago.

Which means §7.5's commands are not quite enough on their own. `npm view <pkg> version` gives the
day's latest; what is needed is the latest *mature* one:

```bash
# publication dates, to pick the newest version older than a week
npm view eslint time --json | tail -20
npm view prettier time --json | tail -20
```

**Three consequences worth stating, because they are not obvious:**

1. **This costs nothing in practice.** A tool version one week old is not an old version; it is a
   version whose regressions someone else has already hit. For a solo maintainer that is a straight
   gain, not a compromise.
2. **The first install of a new repository is the exception, not the rule.** Bootstrapping a
   repository against a table pinned the same day will hit this. The remedy is a **named, dated
   exception** in `minimumReleaseAgeExclude`, never a lowered global threshold — lowering it would
   remove the settling period from every third-party package to fix a handful.
3. **An exception must expire, and the gate enforces it.** Each temporary entry carries a
   `remove-after: YYYY-MM-DD` marker, and `arthome-check-versions` turns red once that date has
   passed. An exception nobody removes is a lowered threshold that does not say its name — and the
   marker is read from an explicit field, never from prose, because a date mentioned in an
   explanation is not a commitment.

```yaml
# pnpm-workspace.yaml — the shape of a bootstrap exception
minimumReleaseAge: 10080
minimumReleaseAgeExclude:
  - '@arthome/*'          # permanent: our own packages must install immediately
  - 'eslint'              # 10.11.0 published 2026-09-18 — mature 2026-09-25
  # remove-after: 2026-09-25
```

**And the same reasoning applies to `@arthome/*` itself, in reverse.** Our own packages are excluded
permanently, because a package published moments ago must be installable at once by the repository
waiting for it. That exclusion is safe precisely because we control what is published — the settling
period exists to protect against a compromised third party, not against ourselves.

---

### 7.7 One pnpm behaviour that will cost the next repository an hour

**Adding a `bin` to a workspace package does not relink it.** `pnpm install` decides whether there is
anything to do by looking at the **lockfile**, and a new `bin` entry in a workspace package does not
change the lockfile. So the install prints `Already up to date`, exits 0, and the new command is not
there:

```
$ pnpm exec arthome-check-language
  × Command "arthome-check-language" not found
```

Reproduced deliberately: deleting `node_modules/.bin/<name>` and running `pnpm install` restores
nothing — it still reports `Already up to date`. The fix is one flag:

```bash
pnpm install --force      # relinks the workspace binaries
```

**Why this earns a section rather than a footnote.** The error message points at the wrong thing. It
says the command does not exist, so the reflex is to check the `bin` entry, the file path, the shebang
and the executable bit — all of which are correct. Nothing in the message suggests the install was
skipped. Every repository born after this one adds gates to `@arthome/tooling` and will hit it once.

The general shape, worth carrying: **`pnpm install` is a lockfile operation, not a "make
`node_modules` correct" operation.** Anything that changes what a workspace package *exposes* rather
than what it *depends on* is invisible to it.

---

## 8. The gates — everything is checkable locally

The account's Actions quota is exhausted. No gate assumes a remote runner.

### 8.1 The table

| # | Gate | Command | Expected | Section |
|---|---|---|---|---|
| 1 | **Zero ESLint / Prettier conflict** | `pnpm exec arthome-check-prettier-conflict` | `PASS no ESLint rule conflicts with Prettier` | §3.5 |
| 2 | Formatting | `pnpm exec prettier --check .` | no file listed | §5.1 |
| 3 | Lint | `pnpm exec eslint . --max-warnings 0` | no output | §5 |
| 4 | Orphaned disables | `pnpm exec eslint . --report-unused-disable-directives --max-warnings 0` | none | §4.5, §6.2 |
| 5 | Typing | `pnpm exec tsc --noEmit` | no error | §5.7 |
| 6 | **`.d.ts` under TypeScript 6.0.3** | `pnpm --filter dts-check exec tsc --noEmit` | no error | §2.4 |
| 7 | **`.d.ts` under TypeScript 7.0.2** | `pnpm --filter dts-check exec tsgo --noEmit` | no error | §2.4 |
| 8 | Reproducible `.d.ts` | `git diff --exit-code -- packages/*/dist/**/*.d.ts` | no diff | §2.4 |
| 9 | **No parallel literal table** | `pnpm exec arthome-check-enums` | no occurrence | §5.3 |
| 10 | Versions aligned, one copy each | `pnpm exec arthome-check-versions` | no discrepancy | §7.4 |
| 11 | **tsconfig locks not loosened** | `pnpm exec arthome-check-tsconfig` | no loosened lock | §4.5.1 |
| 12 | Tooling out of production | `pnpm why -P @arthome/tooling` | no dependency | §4.7 |
| 13 | `@arthome/core` dependency-free | the script in §4.7 | empty | §4.7 |
| 14 | Tests | `pnpm exec vitest run` | green | §5.8 |
| 15 | Commit message | `.githooks/commit-msg`, on every commit — **armed per clone** by `git config core.hooksPath .githooks` (§8.4) | a subject that is not `<area>: <subject>` is refused; unarmed clones check nothing | §5.9, §8.4 |
| 16 | OpenAPI conformance | `python3 tools/check-openapi.py openapi/*.yaml` | `✓ conformant` | `definition-of-done.md` |
| 17 | No French prose committed | `pnpm exec arthome-check-language` | `PASS` | D-024 |
| 18 | **Contracts and domain share one vocabulary** | `python3 tools/check-vocabulary.py openapi/*.yaml` | `PASS` | §5.3.1 |

Gate 18 is five checks, and **three of them need no annotation**, which is why it was worth
building before the 120-block migration rather than after it:

| Check | Needs `-source`? | Catches |
|---|---|---|
| agreement, per block | yes | a member on one side only, asymmetric by kind (§5.3.1 b-bis) |
| **cross-boundary spelling** | **no** | a whole member set matching the domain only once case and separators are ignored — `WATCH_DENIAL_REASONS`' ten values, each differently cased |
| **one value, one spelling** | **no** | the same value spelled two ways across the two contracts — `co-production` / `co_production` |
| **domain member unreachable** | **no** | a value the domain can return that appears in neither contract — the `NOT_PUBLISHED` class |
| **undocumented narrowing** | **no** | an unannotated block that is a strict subset of a named vocabulary — a rule carried by an omission |
| **wire vocabulary with no owner** | **no** | the same member set in *both* contracts that no domain vocabulary declares — two copies, no owner |
| declared narrowing | yes | a `narrowing` label that adds members, or that narrows nothing |
| YAML 1.1 type trap | no | a member that parses as a boolean or null rather than a string |

**Five of the eight need no annotation.** That is not an accident of design; it is §5.3.1 a-bis applied
each time the gate had to grow: when a check needs data that does not exist yet, look for the
formulation that needs none. The three that do need it are the three that genuinely cannot be answered
without knowing *which* vocabulary a block mirrors.

**Gates 9, 10, 11, 16, 17 and 18 run without `node_modules`** — the first three are pure Node shipped by
`@arthome/tooling`, the fourth is Python with no dependency beyond PyYAML. That is deliberate: a gate
that needs an install in order to exist does not exist on the day a repository is created, which is
the day it would help most. Hence the second script in §8.2.

Gates **1, 6, 7 and 9** are the ones D-013 and D-014 require by name. They are also the four a
project would abandon first, because none of them corresponds to an established habit.

### 8.2 `pnpm run verify` — one command per repository

A gate you run when you think of it is not a gate. All seven repositories expose the same command,
chaining **the ones that concern them**:

```jsonc
// package.json — all seven repositories, the same script names
{
  "scripts": {
    "format":       "prettier --write .",
    "format:check": "prettier --check .",
    "lint":         "eslint . --max-warnings 0 --report-unused-disable-directives",
    "typecheck":    "tsc --noEmit",
    "test":         "vitest run",

    "check:prettier-conflict": "arthome-check-prettier-conflict",
    "check:enums":    "arthome-check-enums",
    "check:versions": "arthome-check-versions",
    "check:tsconfig": "arthome-check-tsconfig",
    "check:openapi":  "python3 tools/check-openapi.py openapi/storefront.yaml openapi/studio.yaml",

    "verify": "pnpm run verify:offline && pnpm run check:prettier-conflict && pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run test",
    "verify:offline": "pnpm run check:versions && pnpm run check:tsconfig && pnpm run check:enums && pnpm run check:openapi"
  }
}
```

In `arthome-core`, `verify` adds gates 6, 7, 8 and 13.

**The same names in all seven repositories** — for one person moving between them, that is the only
way never to have to wonder how verification works here.

**`verify:offline` is not a convenience subset**: it is the set of gates that need nothing installed.
It runs on a freshly cloned repository, before the first `pnpm install`, and that is what makes it
possible to create the other six repositories with their gates already green. `verify` calls it and
then adds what requires `node_modules`.

**⚠ And the split has a failure mode this document walked into.** Because `verify:offline` is the one
everybody runs — it is fast, it needs no install, and it is what gets quoted as "green" — the four
steps that exist only in `verify` can go unexercised indefinitely. They did: the root `typecheck` had
been failing with `TS2688` since the day `types: ["node"]` was written into `tsconfig.json` against a
`@types/node` that was never installed. **A broken step in a chain nobody runs is indistinguishable
from a step that works.**

Two things follow, and the second is the general one:

1. `verify:offline` now **prints what it did not run**, so "green" cannot be read as "verified".
   A subset that does not announce itself as one gets quoted as the whole.
2. **The routine command is `verify`; `verify:offline` is for bootstrapping.** If a chain has two
   entry points, the shorter one becomes the real one — so the shorter one has to say what it leaves
   out.

**The order is deliberate and must not change:** versions and `tsconfig` locks first (a gate going red
because a package slipped or a `strict: false` is lying around is time wasted reading an error that
does not exist), then the Prettier conflict (it conditions the meaning of the next two), then
formatting, lint, typing, enumerations and tests. From fastest and most explanatory to slowest.

### 8.3 Turborepo, only where it earns its place

In `arthome-core` and `arthome-platform` these tasks go through Turborepo — **for the cache, and
nothing else** (D-005, README §3). `typecheck` and `build` declare their dependencies
(`"dependsOn": ["^build"]`) because a service does not type-check before `@arthome/contracts` has
emitted its `.d.ts`; `lint` and `format:check` declare none.

The five applications have **no** Turborepo: a single-application repository has no task graph to
cache, and adding one would be tooling to maintain for nothing. **No Nx**, in any of the seven
(README §3).

### 8.4 The git hooks — two files, and the one command per clone that arms them

No husky, no lint-staged, no commitlint. Three packages, three configurations and three version bumps
to maintain in seven copies, for what git does natively:

```bash
git config core.hooksPath .githooks       # once per repository, after cloning
```

**`.githooks/pre-commit`** — two jobs: Prettier on staged files only, then refuse a red commit.

```sh
#!/bin/sh
set -e

files=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(ts|tsx|js|mjs|json|html|css|scss)$' || true)
if [ -n "$files" ]; then
  echo "$files" | xargs pnpm exec prettier --write
  echo "$files" | xargs git add
fi

if ! pnpm run verify; then
  echo ''
  echo 'pre-commit: `pnpm run verify` failed — nothing was committed.'
  exit 1
fi
```

**⚠ THE SECOND JOB WAS ADDED AFTER THE SAME FAULT RECURRED THREE TIMES**, and it is the reason this
section is no longer one command. A compound shell line of the shape

```sh
pnpm run verify > log 2>&1; echo "EXIT=$?" && git commit …
```

reads as though the commit were gated and is not: `;` discards verify's status, and `echo` always
succeeds. Twice that pushed a red tree; the third time it committed one. **Writing "chain with `&&`,
never `;`" into the agent files did not prevent the third occurrence** — a rule about how to write a
shell line is enforced by whoever is writing it, which is exactly the party that got it wrong. The
hook holds whatever the line happens to say.

It is affordable because `verify` runs in about a second and a half and needs no Docker. That is a
property worth protecting rather than a happy accident: it is why the integration tests are named
`*.itest.ts` and sit behind their own command (§8.2). A gate that cost half a minute would be
skipped, and then it would stop being true.

`git commit --no-verify` still skips it, and that is git's design rather than a hole to plug: a hook
is a reflex, not an authority. What it removes is the accident, not the deliberate exception.

(Note the absence of `md` in that pattern: Markdown is outside Prettier's scope here — §3.7.)

**`.githooks/commit-msg`** — written, installed and **identical in `arthome-core` and
`arthome-platform`** (same file, byte for byte; a difference between the two is a bug in whichever was
edited alone). It enforces §5.9's `<area>: <subject>`. Checked on 2026-09-25: `.githooks/` now holds
`pre-commit` and `commit-msg` in both repositories.

**It was written against the practice, not against a format, and that was verified before it was
installed.** All thirteen of the last thirteen subjects pass in each repository — twenty-six of
twenty-six — and so do the last 119 consecutive commits of `arthome-core` and all 18 of
`arthome-platform`. That test is the point: *a hook that rejects the practice it was written to encode
is worse than no hook*, because the first honest commit it refuses teaches everyone that
`--no-verify` is the way to commit.

**What it replaced, and the measurement that condemned it.** The pattern below — Conventional
Commits, as §5.9 used to prescribe — rejects **twelve of the thirteen commits ending at `bf41b03`**
in arthome-platform, the count as taken on 2026-09-25. (On a later HEAD the same pattern rejects
eleven of thirteen, because two short `docs:` subjects have since entered the window; the window
moves, the finding does not. In `arthome-core` it rejects twelve of thirteen as well, passing only
`feat(tooling): …`.) The drift was one consistent shape rather than carelessness: this project writes
`<area>: <prose subject>`, where the areas used — `messaging`, `catalog`, `testing`, `events`,
`search-indexer` — are valid §5.9 *scopes* with no type in front, and the wave labels (`Wave 1:`,
`Wave 2 scaffolding:`) carry which milestone a change belongs to, which the `feat|fix|refactor|…`
vocabulary cannot express. The one subject that did pass was a `docs:`; a second `docs:` failed on
length at 82 characters (an earlier note here said 81 — re-measured, it is 82 bytes and 82
characters; the point it was making is unchanged).

That last figure understated the problem. Measured across the last twenty-six subjects of the two
repositories: **fifteen exceed 72 bytes**, the mean is 76 and the longest is 107. The 72-character
ceiling was not grazed by an outlier, it was contradicted by the majority.

```sh
# THE REJECTED PATTERN — kept so the measurements above stay reproducible. Do not reinstate it.
#!/bin/sh
pattern='^(feat|fix|refactor|perf|test|docs|build|chore|revert)(\([a-z0-9-]+\))?!?: .{1,72}$'
head -n1 "$1" | grep -qE "$pattern" && exit 0
grep -q '^Merge' "$1" && exit 0
echo "Commit message not conformant (§5.9 of architecture/code-conventions.md)." >&2
echo "Shape: type(scope): imperative subject, 72 characters max." >&2
exit 1
```

It carried a second defect worth recording, independent of the format: `grep -q '^Merge' "$1"` reads
the **whole message**, not the subject, so any commit whose body happened to contain a line starting
with "Merge" was waved through entirely. A whitelist must be anchored to the line it is about.

⚠ **AND §5.9 CITED A DECISION THAT DOES NOT MAKE THE RULE.** §5.9 read "[floor] Conventional
Commits, in English, per D-008". D-008 says: "`arthome-core` is committed at the end of phase 0, then
at the end of each of the three times. Messages in English. No remote, no push, ever." It arbitrates
cadence, language and pushing — and says nothing about the format. So "in English" is backed by an
arbitration and "Conventional Commits" was an unsourced `[floor]` rule. That was never a decision to
reopen; it was a citation that was never made.

**Settled on 2026-09-25 — the practice wins.** The choice was between a format that rejects thirteen
commits of deliberate prose and a practice that no rule described. Conventional Commits optimises for
changelog generation and semver automation from the commit log; nothing here reads the commit log —
the only changelog is `oasdiff`'s, from OpenAPI, and §7.1 gives every version bump to a person and an
exact pin — so the format would have cost subject width and the milestone label to serve two machines
that are not wired. §5.9 now states the practice and this hook enforces it. The reasoning belongs to
§5.9; what belongs here is that the gate stopped being a specification and became a file.

The hook, zero dependencies, eighteen lines of logic. The comment block at the top of the real file
says what it deliberately does **not** check and why — language, body, a closed area list, style —
and is not copied here, because two copies of a rule are two rules. `.githooks/commit-msg` is
authoritative:

```sh
#!/bin/sh
# … header comment: the shape, and what this hook deliberately does not check …

subject=$(sed -e '/^#/d' -e '/^[[:space:]]*$/d' "$1" | head -n 1)

# git writes these subjects itself; their shape is not ours to choose.
case "$subject" in
  'Merge '*|'Revert '*|'fixup! '*|'squash! '*|'amend! '*) exit 0 ;;
esac

shape='^([a-z][a-z0-9.-]*(\([A-Za-z0-9._-]+\))?|[A-Z][A-Za-z0-9]*( [A-Za-z0-9@._/-]+){0,3})!?: [^ ].*$'

if [ -z "$subject" ]; then
  …  # "the message is empty"
  exit 1
fi

if ! printf '%s\n' "$subject" | grep -qE "$shape"; then
  …  # the three accepted shapes, with an example of each, then the subject it got
  exit 1
fi

if [ "$(printf '%s' "$subject" | wc -c)" -gt 140 ]; then
  …  # "that length is a pasted paragraph or a body on the subject line"
  exit 1
fi

exit 0
```

**Three judgements inside that pattern**, each with the failure it is avoiding:

- **The area is not checked against a list.** Areas are born with services, and a list here would
  need the same edit in seven repositories every time one appears — the day it is not edited, the gate
  refuses honest work, which is the failure this section exists to document. What is checked is that
  an area is *there*: a subject with no `<label>: ` prefix at all is refused.
- **`Revert`, `fixup!`, `squash!` and `amend!` join `Merge` in the exemption**, for the same reason a
  merge is exempt: git writes those subjects itself and their shape is not the author's to choose.
  `fixup!` commits are transient besides — they exist to be autosquashed away.
- **140 bytes, not 72.** The cap exists only to catch a paragraph or a body pasted onto the subject
  line, and it sits 33 bytes above the longest real subject on purpose. It is counted in bytes, so an
  em dash costs three; nothing in either history comes near enough for that to decide a case.

**What it costs to be wrong here, and what it does not.** The hook refuses only the *shape*. It
cannot tell whether a subject is in English — `arthome-check-language` (§8.1, gate 17) reads every
committed file and is the gate that can — and it reads no part of the body, because §5.9 asks the body
for *why*, and no pattern separates a reason from a restatement. It would reject 22 of
`arthome-core`'s first 51 commits, which are bare prose from before the repository was translated to
English; those are history, and history is not re-committed.

**What the hooks do not do:** they run neither `eslint`, nor `tsc`, nor the tests. A slow hook is a
hook you bypass with `--no-verify`, and a bypassed hook is worth less than no hook at all, because it
gives the illusion of a gate. Lint, typing and tests are in `pnpm run verify`, run before pushing.

**The day the Actions quota returns:** the workflow file calls `pnpm run verify` and nothing else.
That is why everything sits behind a single command — the remote CI will not add a second definition
of what is checked, so there will never be two lists to keep in agreement.

### 8.5 A repository-wide rewrite is a stop-the-world operation

**The rule.** A repository-wide `--write`, a codemod, a rename sweep or any reformat that touches
files you do not own is **announced, then everyone stops, then one agent runs it, then everyone
resumes**. Never while another agent is mid-file.

**Why it is a rule and not a courtesy.** This document cost 151 keys in `openapi/storefront.yaml`
learning it. A `prettier --write .` run across a working tree that nine agents were editing landed
between another agent's two passes — it had extracted French units with their line numbers and was
about to write English back at those line numbers. The reformat moved every one of them by up to
835. The next batch wrote sixty blocks into the wrong places, and the document stopped parsing.

Three properties made it undetectable at the moment it happened, and they are the reason this needs
a rule rather than care:

- **The reformat was correct.** Prettier did exactly what it was asked. Nothing failed, nothing
  warned, and the command exited 0.
- **The damage was in a file the runner had no reason to be looking at.** I reported it as another
  agent's transient breakage, because that is what it looked like from outside: a file that had been
  green, was briefly red, and went green again.
- **`git status` does not distinguish "my change" from "my change on top of someone's half-finished
  change".** There is no signal to read.

**So the default scope is narrowed, and that is the part that generalises:**

> `prettier --write .` is not the same operation as `prettier --write` **on the files you own**. The
> second is the default. The first is a stop-the-world operation and needs the announcement.

```bash
# the default: format what you touched
pnpm exec prettier --write $(git diff --name-only --diff-filter=ACMR)

# stop-the-world: announced first, one agent, nobody else mid-file
pnpm exec prettier --write .
```

The `pre-commit` hook (§8.4) already has the right scope — staged files only — and that is not a
coincidence: a hook that reformatted the whole repository on every commit would have caused this
weekly.

**What this rule is not.** It is not "avoid repo-wide commands". They are necessary, and postponing
them is how a repository ends up with two formatting styles. It is: **name the moment**. The cost of
announcing is one message; the cost of not announcing was a full rebuild of a 6,300-line contract.

---

## 9. What is not settled here

Recorded so that it does not get lost, and so that it is **not** handled from memory when the day
comes:

1. ~~**Expo or bare React Native**~~ — **settled since: D-025 chooses Expo** for `storefront-mobile`
   and `storefront-tv`. The consequence for this document is slight: `eslint-config-expo` joins the
   list of stack presets **`@arthome/tooling` does not carry** (§4.2), alongside `angular-eslint` and
   `eslint-config-next` — its version must track the Expo SDK installed in the repository. §6.3
   remains correct on the substance: Metro, tree-shaking and `exports` resolution are Expo's as much
   as bare React Native's. **Still to be verified at the mobile stage**, and not from memory: which
   ESLint `eslint-config-expo` accepts — that is what will decide whether the two repositories stay on
   ESLint 9 (§6.3) or can move to 10.
2. **`@arthome/contracts`'s Protobuf runtime** — its name and version are not fixed
   (`architecture/events.md` and `proto/buf.yaml` will decide). Its place in **regime A** (§7.1) is
   decided, though, by the same reasoning as zod.
3. **A numeric coverage threshold** — deliberately absent (§5.8). If `definition-of-done.md` sets one,
   it prevails and this section falls in line.
4. **The date of the move to TypeScript 7** — conditional on three external releases (§2.6), none of
   which is announced. Anticipate nothing; gate 7 guarantees that the day will be a non-event.
5. **The return of the Actions quota** — §8.4 says what the workflow will contain; it does not write
   it.

---

## Appendix — what was verified online on 21 September 2026

This document quotes no version from memory. Readings taken that day, each against its source.

| Verified | Source | Result |
|---|---|---|
| Versions of every package in §1 | `registry.npmjs.org` (`dist-tags`, version documents) | the §1 table |
| Angular 22's TypeScript ceiling | `@angular/compiler-cli@22.1.7` → `peerDependencies` | `>=6.0 <6.1` — **hard** |
| `typescript-eslint`'s TypeScript ceiling | `typescript-eslint@8.70.0` → `peerDependencies`, and `typescript-eslint.io/users/dependency-versions` | `>=4.8.4 <6.1.0` |
| TypeScript 7 support in `typescript-eslint` | issue `typescript-eslint#12518` | **closed "not planned"** — no TS 7 API |
| Absence of a TypeScript constraint on the React Native side | `react-native@0.87.1` → `peerDependencies`; `@types/react@19.3.0` → `typesVersions` | **none**; TS 5.1+ is enough |
| The NestJS CLI's refusal of TypeScript 7 | `nest-cli` 12.0.3, `UNSUPPORTED_TYPESCRIPT_VERSION` | `tsc`, `swc` and `rspack` alike |
| The nature of TypeScript 7.0 | `devblogs.microsoft.com/typescript/announcing-typescript-7-0/` | Go port, checking parity, **no new syntax**, no programmatic API |
| `stableTypeOrdering` under TS 6.0 | TypeScript 6.0 release notes | 7.0's deterministic ordering backported to 6.0; up to 25% slower |
| **`stableTypeOrdering` under TS 7.0** | official TypeScript 7.0 announcement | "is `true` by default, and **cannot be turned off**" → the only option in the setup that does not hold on both sides (§4.4.1). **Not verified**: whether writing it explicitly as `true` under 7.0 is accepted or rejected — hence the §4.4.2 rule, which makes the question moot |
| Options that became **hard errors** in TypeScript 7.0 | official TypeScript 7.0 announcement | `target: es5`, `downlevelIteration`, `moduleResolution: node/node10/classic`, `module: amd/umd/systemjs/none`, **`baseUrl`**, `esModuleInterop: false`, `allowSyntheticDefaultImports: false`, `alwaysStrict: false`, `outFile`, `module Foo {}`, `assert` on imports; `ignoreDeprecations` no longer silences them |
| Defaults changed in TypeScript 6.0 | TypeScript 6.0 release notes | `types: []`, `rootDir: "."`, `strict`, `module: esnext` |
| `@typescript/typescript6` | npm registry, maintainers | **official Microsoft package**, `tsc6` binary, published at **6.0.2** |
| **`extends` and the `exports` field** | `microsoft/TypeScript#48665`, **PR #50955** (merged Dec 2022) | the historical defect — `extends` ignoring `exports` — is **fixed**; subpaths must therefore be listed in `exports` (§4.4.4) |
| **Relative paths in an extended `tsconfig`** | `typescriptlang.org/tsconfig/extends.html` | "All relative paths found in the configuration file will be resolved relative to the configuration file they originated in"; `files`/`include`/`exclude` **override**, `references` is **not inherited** → no path-bearing option in the base (§4.4.4) |
| **Inheritance of `angularCompilerOptions` through `extends`** | `angular/angular` commits (`d7e5bbf`, `e3ccd56`), `angular.dev/reference/configs/angular-compiler-options` | Angular **explicitly implemented** it, at the same level as `compilerOptions` |
| **Metro and `tsconfig`** | Metro and React Native documentation | Metro **does not read** `tsconfig.json`; `exports` resolution **on by default** since Metro 0.82 / React Native 0.79, therefore in RN 0.87 |
| `eslint-config-prettier`: position, `/flat` entry, CLI | the repository's `README` and `CHANGELOG` | last in the array; `/flat` separated since 10.1.1; `npx eslint-config-prettier <file>` |
| `eslint-plugin-prettier` discouraged | `prettier.io/docs/integrating-with-linters` | the three reasons quoted in §3.3 |
| `arrow-body-style` / `prefer-arrow-callback` | `eslint-config-prettier`'s `README` | "safe to use if you don't use eslint-plugin-prettier" |
| ESLint 10: `eslintrc` removed, config lookup | `eslint.org/docs/latest/use/migrate-to-10.0.0` | flat only; lookup from the file's directory |
| Next 16 + Prettier arrangement | `nextjs.org/docs/app/api-reference/config/eslint` (v16.3.5, updated 2026-08-25) | `next lint` removed; `eslint-config-prettier/flat` recommended, placed after |
| `eslint-plugin-react-hooks` 7 presets | `react-compiler-lint`, read on 6.1.1 and 7.1.1 | `flat.recommended`; `flat/recommended` and `*-legacy` removed |
| `@react-native/eslint-config`: ESLint 10 and the `eslint-config-prettier` copy | `@react-native/eslint-config@0.87.1` → `peerDependencies`, `dependencies` | `eslint ^8 \|\| ^9`; depends on `eslint-config-prettier@^8.5.0` |
| Prettier's parser for Angular templates | Prettier's `src/language-html/languages.evaluate.js` | `angular` bound **only** to `.component.html` |
| Angular naming convention | `angular.dev/style-guide` | no `.component` suffix; by domain, not by nature |
| pnpm's `minimumReleaseAge` | pnpm documentation | default **1440** since pnpm 11; patterns accepted in `minimumReleaseAgeExclude` since 10.17 |
| pnpm catalogs and publishing | `pnpm.io/catalogs` | `catalog:` **replaced by the real version** on publish |
| Node LTS | `nodejs.org/dist/index.json` | 24.21.0 "Krypton"; 26.9.0 not yet LTS |
| Prettier 4 | `prettier`'s `dist-tags` | `next` = 4.0.0-**alpha**.13 → we stay on 3.x |

**Read from the project's own sources** — added after another teammate found an invented enumeration
in §5.3 (the episode is recorded there). Every enumeration value written in this document now comes
from a named file.

| Verified | Source | Result |
|---|---|---|
| Chat modes | `proto/arthome/chat/v1/events.proto` → `enum ChatMode` | `OPEN`, `EMOJI`, `READ_ONLY`, `OFF` → `open \| emoji \| read-only \| off` |
| — cross-check | `shared/i18n/storefront.json`, `shared/fixtures.js` | `enums.chatMode.open \| emoji \| read-only \| off` — in agreement |
| Publication states | `shared/catalogue.json` → `publicationStates` | `draft`, `reserve`, `scheduled`, `technical`, `live`, `ended`, `replay-online` |
| — the parallel table | `mockups/Studio.dc.html` → `EV_MOVES`, via `corrections-handoff.md` § D2 | `draft`, `hidden`, `sched`, `tech`, `live`, `done`, `replay` — `catalogue.json` is authoritative |
| The three moderation axes | `proto/arthome/chat/v1/events.proto` | `MessageState`, `ModerationItemState` (where `reported` lives) and `ModerationVerdict` are **separate** — do not merge them under one name (§5.3, E3) |
| The shape of i18n keys | `shared/i18n/storefront.json` | dotted `camelCase` segments (`chat.collapse`, `account.alerts.alertHint`); enumeration labels under `enums.<enum>.<value>` |
| The `chat.*` copy family | `shared/i18n/storefront.json`, via `corrections-handoff.md` § E2 | `chat.free \| emoji \| off` shadows `enums.chatMode.*` and diverges on the very first value (`free` versus `open`) |

**Found by running the tooling, not by reading it** — the four defects the first implementation
revealed, each recorded in the section it corrects.

| Found | How | Section |
|---|---|---|
| `@arthome/tooling` resolved `eslint@9.39.5` while the root had `10.11.0` | `pnpm why eslint` after the first install | §4.2, §7.4 |
| `eslint-config-prettier` unresolvable from the repository root | running the §3.5 gate | §3.5, §4.2 |
| Prettier would rewrite all fifteen architecture documents | `prettier --check .` | §3.7 |
| `minimumReleaseAge` refuses versions pinned on their publication day | the first `pnpm install` | §7.6 |

### 5.5.1 The fast loop — which check answers which question

**Measured, not estimated (D-068):**

| command | time | the question it answers |
|---|---|---|
| `pnpm run typecheck` | **2 s** | does it compile? a missing import, a wrong name, a bad shape |
| `pnpm run check:emit-diff` | 5 s | does this schema reproduce the document it publishes? |
| `pnpm run verify` | **29 s** | is this ready to hand back? |

**Iterate on the first, finish on the second, hand back on the third.** Four workers writing schemas
in parallel ran `verify` after every edit — fourteen times the price per turn, to find a missing
import that `typecheck` names in two seconds. Nothing told them otherwise, and nothing in `verify`'s
own output says it is the wrong tool for that.

**And `verify` is the only one of the three that is a promise.** The other two are questions. A
green `typecheck` says the file compiles and nothing more; it says nothing about whether the schema
emits its contract, which is what this package exists to do.


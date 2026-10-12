## Generating a service, an aggregate, a command, a consumer handler

`tools/schematics` is this repository's own collection on `@angular-devkit/schematics`, run with the
`schematics` CLI from the repository root. Not `nest g`: it passes a fixed option list, swallows a
generator's errors and expects a `nest-cli.json` this pnpm workspace does not have. The templates
are ticketing's and catalog's current code; the service's pins and its connector are copied from
the siblings at generation time, so neither can drift from them.

**A local collection runs as a dry run by default.** `--no-dry-run` writes; `--dry-run=false` is
still a dry run. **Run it as below, with `--config.verify-deps-before-run=false`:** a bare
`pnpm exec` checks the workspace's dependencies first and installs when they are out of sync, so a
dry run after `service --skip-install` rewrites `pnpm-lock.yaml` and links the new app's
`node_modules` before the generator even starts. Options are kebab-case (`--skip-install`,
`--occurred-at`): the CLI refuses camelCase. Every run formats what it touched with the repository's
Prettier, then `pnpm run verify` and the app's `test:integration` are the check. Proven on
2026-10-03 with a throwaway `sample` built from all four, an aggregate taking `--plural` and a
command through it included, then deleted: both passed as generated.

```bash
pnpm --config.verify-deps-before-run=false exec schematics ./tools/schematics:service \
  --name sample --port 3905 --topics widget:3 --consumer --sweeper --no-dry-run
pnpm --config.verify-deps-before-run=false exec schematics ./tools/schematics:aggregate \
  --app sample --module widgets --name widget --no-dry-run
pnpm --config.verify-deps-before-run=false exec schematics ./tools/schematics:command \
  --app sample --module widgets --name rename-widget --aggregate widget --event WidgetRenamed \
  --route 'v1/widgets/:widgetId/rename' --no-dry-run
pnpm --config.verify-deps-before-run=false exec schematics ./tools/schematics:consumer-handler \
  --app sample --module dates --name record-date-drafted --topic arthome.catalog.date \
  --type catalog.date.drafted.v1 --schema DateDraftedSchema --key dateId --no-dry-run
```

| generator | writes | edits |
| --- | --- | --- |
| `service` | ticketing's shape: the API with `edgeProviders`, split probes and shutdown hooks; `--consumer`'s process on `ConsumerHostModule`; `--sweeper`'s loop; `env.ts`, the data source and the first migration (outbox, processed-message, idempotency); the `outboxWriter` topic table; `boot.itest.ts`; the tsconfigs, vitest config, pinned `package.json`, `HANDOVER.md` stub; then `pnpm install` unless `--skip-install` | `init-databases.sql`, a connector in `infra/debezium`, `topics.json` (with retry and dead-letter topics for a consumer), `connector-config.spec.ts`, the ops, purge and republish tools, the README's table, this file's migration and connector lines |
| `aggregate` | the aggregate, its events, row, repository port and TypeORM adapter on `saveVersioned`, its events' outbox mapping, a migration and a spec | the app's transaction (its repository, keyed by `--plural` when the name plus s is wrong: `person` takes `--plural people`), the data source |
| `command` | a command deciding through `--aggregate` in the app's transaction runner, `commit()` left to the runner, its events to outbox rows inside the transaction; its handler and a unit spec; with `--route`, an idempotent route, its schema and an HTTP suite | the aggregate (the method, `advancedFrom`, the event, its spec), `record-<aggregate>-events.ts` (the event's null wire form), the feature module (created and imported by `AppModule` when absent), its controller; the repository is the transaction's member typed `<Aggregate>Repository`, whatever its key |
| `consumer-handler` | one type read into a command that claims the message (`messageIdOf`, `claimMessage`, `Outcome`) and keeps the fact only when its `occurred_at` is not older; its table, a spec and an integration suite | `consumed-messages.ts`, `CONSUMED_TOPICS`, the feature's consumer module, the data source |

**What they do not do.** No event reaches a topic: the proto is arthome-core's, so the topic table
starts empty and each event's `wireFormOf` answers null until someone builds its payload. A name
that is not in core's `Service` vocabulary stays a literal in `src/service.ts` until core has it.
The service's database is created by `init-databases.sql` on an empty data directory only, and
nobody registers its connector or provisions its topics. Every service publishes: `--topics` is
required, and each gets an outbox, a connector and the slot probes, so a consumer alone, shaped like
search-indexer, is not generated. A consumer subscribes to nothing until its first
`consumer-handler`, and KafkaJS refuses an empty list; a sweeper has no pass. An aggregate holds its
id and `version` alone, a command's body `expectedVersion` alone, and a route's one parameter is the
aggregate's id. A consumer handler's table is a placeholder for the real effect, a refusal it raises
is dead-lettered (a fact that waits for an earlier one, as ticketing's do for `drafted`, is made
transient by hand), and its key must be a string field. A type `READERS` reads already is refused:
one type has one handler, which is the one to extend. An anchor the service cannot find in the
README, this file or a tool is a warning to act on, not a failure. Nothing is ever deleted or
renamed, and a file that exists is refused. So is a service name used anywhere: an app directory, a
database, a topic (its retry and dead-letter ones included), a connector's name, slot or
publication, a consumer group. The one exception is a topic declared before its service, as
`arthome.chat.date` is for catalog to consume: `--topics date:12` owns it, at exactly its
declared partitions (`streaming` was generated that way, owning `arthome.streaming.run`).

The collection is ESM TypeScript loaded without a build: the engine's `require()` reaches it
through Node's `require(esm)` and type stripping, so its code stays erasable (no enum, no parameter
property) and its imports across files go through `#schematics/*`. **It needs Node 22.18 or later
on 22.x**, where type stripping is on by default; the `engines` floor, 22.22.3, already holds it.
Run on 24.19 and, in a container, on 22.23.3. Its specs run in `pnpm run test`, through
`SchematicTestRunner` on a tree of the committed files.


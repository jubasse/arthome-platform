import {
  SchematicsException,
  apply,
  applyTemplates,
  chain,
  filter,
  mergeWith,
  move,
  url,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';

import { aggregateNames, type AggregateNames } from '#schematics/aggregate-names';
import { ensureFeatureModule, register, type FeatureModuleSpec } from '#schematics/feature-module';
import { formatTouchedFiles } from '#schematics/format';
import { kebab, snake, spellings, type Spellings } from '#schematics/names';
import {
  addClassMember,
  addImports,
  addNullCase,
  addStatementBefore,
  addToDescribe,
  addUnionMember,
  hasClassMember,
  hasDeclaration,
  memberTyped,
  renderImports,
} from '#schematics/source-file';
import { editText, existingApp, readText, type AppNames } from '#schematics/workspace';

export interface CommandOptions {
  readonly app: string;
  readonly module: string;
  readonly name: string;
  /** The aggregate the command decides through, in the same feature directory. */
  readonly aggregate: string;
  /** The event its decision applies, a class of the aggregate's events file. */
  readonly event: string;
  /** `v1/rigs/:rigId/focus`: an idempotent route whose only parameter is the aggregate's id. */
  readonly route?: string;
  readonly method: 'POST' | 'PUT' | 'PATCH';
}

type Aggregate = AggregateNames;

interface Route {
  readonly method: string;
  readonly path: string;
  /** The request's path with the id interpolated, as the fingerprint takes it. */
  readonly requestPath: string;
}

function routeOf(options: CommandOptions, aggregate: Aggregate): Route | null {
  if (options.route === undefined || options.route === '') return null;
  const path = options.route.replace(/^\/+/, '');
  const parameters = [...path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]);
  if (parameters.length !== 1 || parameters[0] !== aggregate.id) {
    throw new SchematicsException(
      `--route "${options.route}" must take one parameter, :${aggregate.id}, the aggregate's id`,
    );
  }
  return {
    method: options.method,
    path,
    requestPath: `/${path.replace(`:${aggregate.id}`, `\${${aggregate.id}}`)}`,
  };
}

function decisionOf(aggregate: Aggregate, method: string, event: string): string {
  return `
  /** Refuses a command that read another version; applies ${event} at \`now\`. */
  public ${method}(expectedVersion: number, now: Instant): void {
    const version = this.advancedFrom(expectedVersion);
    this.current = frozen({ ...this.current, version });
    this.apply(new ${event}(this.current.${aggregate.id}, now));
  }`;
}

const ADVANCED_FROM = `
  /** Refuses a command that read another version, naming the current one; else the next version. */
  private advancedFrom(expectedVersion: number): number {
    const { version } = this.current;
    if (version !== expectedVersion) {
      throw new DomainError({ code: DomainErrorCode.STATE_CONFLICT, params: { version } });
    }
    return version + 1;
  }`;

const REFUSAL_OF = `function refusalOf(decide: () => unknown): DomainError {
  try {
    decide();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}`;

/** The decision method on the aggregate, its event, the event's null wire form, and its spec. */
function decideThroughAggregate(
  directory: string,
  aggregate: Aggregate,
  method: string,
  event: string,
): Rule {
  return (tree) => {
    const base = `${directory}/${aggregate.kebab}`;
    editText(tree, `${base}.events.ts`, (text) => {
      if (hasDeclaration(text, event)) throw new Error(`${event} exists already`);
      const withClass = addStatementBefore(
        text,
        aggregate.event,
        `export class ${event} implements IEvent {
  public readonly kind = '${event}';

  public constructor(
    public readonly ${aggregate.id}: string,
    public readonly occurredAt: Instant,
  ) {}
}`,
      );
      return addImports(addUnionMember(withClass, aggregate.event, event), [
        { name: 'IEvent', from: '@nestjs/cqrs', typeOnly: true },
        { name: 'Instant', from: '@arthome/core', typeOnly: true },
      ]);
    });
    editText(tree, `${base}.aggregate.ts`, (text) => {
      if (hasClassMember(text, aggregate.pascal, method)) {
        throw new Error(`${aggregate.pascal}.${method} exists already`);
      }
      const withGuard = hasClassMember(text, aggregate.pascal, 'advancedFrom')
        ? text
        : addClassMember(text, aggregate.pascal, ADVANCED_FROM);
      const withDecision = addClassMember(
        withGuard,
        aggregate.pascal,
        decisionOf(aggregate, method, event),
        'advancedFrom',
      );
      return addImports(withDecision, [
        { name: 'frozen', from: '@arthome-platform/transactions' },
        { name: 'DomainError', from: '@arthome/core' },
        { name: 'DomainErrorCode', from: '@arthome/core' },
        { name: 'Instant', from: '@arthome/core', typeOnly: true },
        { name: event, from: `./${aggregate.kebab}.events.js` },
      ]);
    });
    editText(tree, `${directory}/record-${aggregate.kebab}-events.ts`, (text) =>
      addNullCase(text, 'wireFormOf', `'${event}'`),
    );
    const spec = `${base}.aggregate.spec.ts`;
    if (!tree.exists(spec)) return;
    editText(tree, spec, (text) => {
      const constant = `${aggregate.constant}_ID`;
      const withHelper = hasDeclaration(text, 'refusalOf')
        ? text
        : `${text.trimEnd()}\n\n${REFUSAL_OF}\n`;
      const withCases = addToDescribe(
        withHelper,
        aggregate.pascal,
        `it('${method} advances the version it was given, applying ${event}', () => {
    const ${aggregate.camel} = ${aggregate.pascal}.restore({ ${aggregate.id}: ${constant}, version: 1 });
    ${aggregate.camel}.${method}(1, NOW);
    expect(${aggregate.camel}.snapshot.version).toBe(2);
    expect(${aggregate.camel}.getUncommittedEvents()).toEqual([new ${event}(${constant}, NOW)]);
  });

  it('${method} refuses a version it was not given, naming the current one', () => {
    const ${aggregate.camel} = ${aggregate.pascal}.restore({ ${aggregate.id}: ${constant}, version: 2 });
    const refusal = refusalOf(() => ${aggregate.camel}.${method}(1, NOW));
    expect([refusal.code, refusal.params]).toEqual([DomainErrorCode.STATE_CONFLICT, { version: 2 }]);
    expect(${aggregate.camel}.getUncommittedEvents()).toEqual([]);
  });`,
      );
      return addImports(withCases, [
        { name: 'DomainError', from: '@arthome/core' },
        { name: 'DomainErrorCode', from: '@arthome/core' },
        { name: event, from: `./${aggregate.kebab}.events.js` },
      ]);
    });
  };
}

function controllerMethod(command: Spellings, aggregate: Aggregate, route: Route): string {
  const decorator = `${route.method.charAt(0)}${route.method.slice(1).toLowerCase()}`;
  return `
  @${decorator}('${route.path}')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public ${command.camel}(
    @Param('${aggregate.id}', { schema: z.uuid() }) ${aggregate.id}: string,
    @Body({ schema: ${command.pascal}Schema }) body: ${command.pascal}Body,
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<${command.pascal}Answer>> {
    return this.commands.execute(
      new ${command.pascal}(
        ${aggregate.id},
        body,
        parseTraceparent(traceparent)?.traceparent ?? null,
        idempotentRequestOf(
          '${route.method}',
          \`${route.requestPath}\`,
          body,
          200,
          idempotencyKey,
          principal.accountId,
        ),
      ),
    );
  }`;
}

/** The feature's controller, created when absent, with the command's route and its registration. */
function routeThroughController(
  names: AppNames,
  module: string,
  command: Spellings,
  aggregate: Aggregate,
  route: Route,
): Rule {
  return (tree: Tree) => {
    const feature = ensureFeatureModule(tree, names, module, apiFeature(module));
    const className = `${spellings(module).pascal}Controller`;
    const path = `${names.src}/${module}/${module}.controller.ts`;
    if (!tree.exists(path)) {
      tree.create(
        path,
        `${renderImports([
          { name: 'Controller', from: '@nestjs/common' },
          { name: 'CommandBus', from: '@nestjs/cqrs' },
        ])}

/** \`${module}\`'s routes, each dispatching its command. */
@Controller()
export class ${className} {
  public constructor(private readonly commands: CommandBus) {}
}
`,
      );
    }
    editText(tree, path, (text) => {
      if (hasClassMember(text, className, command.camel)) {
        throw new Error(`${className}.${command.camel} exists already`);
      }
      return addImports(
        addClassMember(text, className, controllerMethod(command, aggregate, route)),
        [
          { name: 'CurrentPrincipal', from: '@arthome-platform/http-edge' },
          { name: 'idempotentRequestOf', from: '@arthome-platform/http-edge' },
          { name: 'parseTraceparent', from: '@arthome-platform/http-edge' },
          { name: 'MemorisedResponse', from: '@arthome-platform/http-edge', typeOnly: true },
          { name: 'Principal', from: '@arthome-platform/http-edge', typeOnly: true },
          { name: 'Body', from: '@nestjs/common' },
          { name: 'Header', from: '@nestjs/common' },
          { name: 'Headers', from: '@nestjs/common' },
          { name: 'HttpCode', from: '@nestjs/common' },
          { name: 'Param', from: '@nestjs/common' },
          {
            name: route.method.charAt(0) + route.method.slice(1).toLowerCase(),
            from: '@nestjs/common',
          },
          { name: 'z', from: 'zod' },
          { name: command.pascal, from: `./${command.kebab}.command.js` },
          {
            name: `${command.pascal}Answer`,
            from: `./${command.kebab}.command.js`,
            typeOnly: true,
          },
          { name: `${command.pascal}Schema`, from: `./${command.kebab}.schema.js` },
          { name: `${command.pascal}Body`, from: `./${command.kebab}.schema.js`, typeOnly: true },
        ],
      );
    });
    register(tree, feature, 'controllers', className, `./${module}.controller.js`);
  };
}

function apiFeature(module: string): FeatureModuleSpec {
  return {
    file: module,
    purpose: `The \`${module}\` feature, in the API process.`,
    root: 'app.module',
    clock: true,
  };
}

function registerHandler(names: AppNames, module: string, handler: string, file: string): Rule {
  return (tree: Tree) => {
    const feature = ensureFeatureModule(tree, names, module, apiFeature(module));
    register(tree, feature, 'providers', handler, `./${file}.handler.js`);
  };
}

/** The aggregate's names, its repository's key read from the transaction that declares it. */
function aggregateNamed(tree: Tree, names: AppNames, directory: string, name: string): Aggregate {
  const naive = aggregateNames(name);
  readText(tree, `${directory}/${naive.kebab}.aggregate.ts`);
  const key = memberTyped(
    readText(tree, names.transactionsFile),
    names.transactionScope,
    naive.repository,
  );
  if (key === null) {
    throw new SchematicsException(
      `${names.transactionsFile}: ${names.transactionScope} has no member typed ${naive.repository}`,
    );
  }
  return aggregateNames(name, key);
}

export function command(options: CommandOptions): Rule {
  return (tree) => {
    const names = existingApp(tree, options.app);
    const module = kebab(options.module);
    const directory = `${names.src}/${module}`;
    const aggregate = aggregateNamed(tree, names, directory, options.aggregate);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(options.event)) {
      throw new SchematicsException(`--event "${options.event}": a class name, such as RigFocused`);
    }
    const commandNames = spellings(options.name);
    if (tree.exists(`${directory}/${commandNames.kebab}.command.ts`)) {
      throw new SchematicsException(`${directory}/${commandNames.kebab}.command.ts exists already`);
    }
    const route = routeOf(options, aggregate);

    const files = apply(url('./files'), [
      filter((path) => route !== null || !/\.(schema|http\.itest)\.ts\.template$/.test(path)),
      applyTemplates({
        command: commandNames,
        file: commandNames.kebab,
        aggregate,
        app: names,
        event: options.event,
        route,
        feature: spellings(module),
        database: `${snake(names.app)}_${commandNames.snake}_http_itest`.slice(0, 63),
        imports: renderImports,
      }),
      move(directory),
    ]);
    return chain([
      mergeWith(files),
      decideThroughAggregate(directory, aggregate, commandNames.camel, options.event),
      registerHandler(names, module, `${commandNames.pascal}Handler`, commandNames.kebab),
      route === null
        ? () => undefined
        : routeThroughController(names, module, commandNames, aggregate, route),
      formatTouchedFiles(),
    ]);
  };
}

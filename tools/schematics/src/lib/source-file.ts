import ts from 'typescript';

/**
 * Edits of TypeScript source that locate their target in the syntax tree, never by text: a file
 *   a person has since reformatted or reordered is edited all the same. Each takes and returns the
 *   whole text; Prettier lays out the result afterwards (`formatTouchedFiles`).
 */

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('edited.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function applied(text: string, edits: readonly Edit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((current, { start, end, text: inserted }) => {
      return current.slice(0, start) + inserted + current.slice(end);
    }, text);
}

const insertion = (at: number, text: string): Edit => ({ start: at, end: at, text });

function located<T>(found: T | undefined, what: string): T {
  if (found === undefined) throw new Error(`${what} not found`);
  return found;
}

function descendants(node: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (child: ts.Node): void => {
    found.push(child);
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

// ------------------------------------------------------------------------------------ imports

export interface ImportSpec {
  readonly name: string;
  readonly from: string;
  readonly typeOnly?: boolean;
}

const GROUP_BUILTIN = 0;
const GROUP_EXTERNAL = 1;
const GROUP_INTERNAL = 2;
const GROUP_RELATIVE = 3;

/** The groups of the repository's `import-x/order`: builtin, external, `@arthome/**`, relative. */
function groupOf(from: string): number {
  if (from.startsWith('node:')) return GROUP_BUILTIN;
  if (from.startsWith('.')) return GROUP_RELATIVE;
  if (from.startsWith('@arthome/')) return GROUP_INTERNAL;
  return GROUP_EXTERNAL;
}

const RELATIVE_DOTS = new Set(['.', '..']);

/** `import-x/order`'s alphabetize comparator, as its `getSorter` computes it, case-insensitive. */
export function compareModules(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (!a.includes('/') && !b.includes('/')) return a < b ? -1 : a > b ? 1 : 0;
  const segmentsA = a.split('/');
  const segmentsB = b.split('/');
  let result = 0;
  for (let index = 0; index < Math.min(segmentsA.length, segmentsB.length); index += 1) {
    const x = segmentsA[index] ?? '';
    const y = segmentsB[index] ?? '';
    if (index === 0 && RELATIVE_DOTS.has(x) && RELATIVE_DOTS.has(y)) {
      if (x !== y) break;
      continue;
    }
    result = x < y ? -1 : x > y ? 1 : 0;
    if (result !== 0) break;
  }
  if (result === 0 && segmentsA.length !== segmentsB.length) {
    result = segmentsA.length < segmentsB.length ? -1 : 1;
  }
  // A tie for import-x, broken as the services write it: the sibling before the parent.
  if (result === 0 && segmentsA[0] !== segmentsB[0]) result = segmentsA[0] === '.' ? -1 : 1;
  return result;
}

const moduleOf = (declaration: ts.ImportDeclaration): string =>
  (declaration.moduleSpecifier as ts.StringLiteral).text;

function namedBindingsOf(declaration: ts.ImportDeclaration): ts.NamedImports | undefined {
  const bindings = declaration.importClause?.namedBindings;
  return bindings !== undefined && ts.isNamedImports(bindings) ? bindings : undefined;
}

/** Values in ASCII order, then types, as the services write them. */
function specifierRank(specifier: string): [number, string] {
  return specifier.startsWith('type ') ? [1, specifier.slice(5)] : [0, specifier];
}

function comesBefore(specifier: string, other: string): boolean {
  const [kind, name] = specifierRank(specifier);
  const [otherKind, otherName] = specifierRank(other);
  return kind !== otherKind ? kind < otherKind : name < otherName;
}

function withSpecifier(bindings: ts.NamedImports, specifier: string): Edit {
  const next = bindings.elements.find((element) => comesBefore(specifier, element.getText()));
  if (next !== undefined) return insertion(next.getStart(), `${specifier}, `);
  const last = bindings.elements[bindings.elements.length - 1];
  if (last === undefined) return insertion(bindings.getStart() + 1, ` ${specifier} `);
  return insertion(last.end, `, ${specifier}`);
}

function newDeclaration(
  source: ts.SourceFile,
  imports: readonly ts.ImportDeclaration[],
  statement: string,
  from: string,
): Edit {
  const group = groupOf(from);
  const ranked = imports.filter((declaration) => declaration.importClause !== undefined);
  const next = ranked.find((declaration) => {
    const other = groupOf(moduleOf(declaration));
    return other > group || (other === group && compareModules(moduleOf(declaration), from) > 0);
  });
  if (next !== undefined) {
    const before = ranked[ranked.indexOf(next) - 1];
    if (groupOf(moduleOf(next)) === group) return insertion(next.getStart(), `${statement}\n`);
    if (before !== undefined && groupOf(moduleOf(before)) === group) {
      return insertion(before.end, `\n${statement}`);
    }
    return insertion(next.getStart(), `${statement}\n\n`);
  }
  const last = imports[imports.length - 1];
  if (last === undefined) {
    const first = source.statements[0];
    return insertion(first === undefined ? 0 : first.getStart(), `${statement}\n\n`);
  }
  const lastRanked = ranked[ranked.length - 1];
  const joins = lastRanked !== undefined && groupOf(moduleOf(lastRanked)) === group;
  return insertion(last.end, `${joins ? '\n' : '\n\n'}${statement}`);
}

function addImport(text: string, { name, from, typeOnly = false }: ImportSpec): string {
  const source = parse(text);
  const imports = source.statements.filter(ts.isImportDeclaration);
  const sameModule = imports.filter((declaration) => moduleOf(declaration) === from);
  const importsName = (declaration: ts.ImportDeclaration): boolean =>
    namedBindingsOf(declaration)?.elements.some((element) => element.name.text === name) ?? false;
  if (sameModule.some(importsName)) return text;

  const valueImport = sameModule.find(
    (declaration) => declaration.importClause?.isTypeOnly !== true && namedBindingsOf(declaration),
  );
  const typeImport = sameModule.find(
    (declaration) => declaration.importClause?.isTypeOnly === true && namedBindingsOf(declaration),
  );
  if (typeOnly && typeImport !== undefined) {
    return applied(text, [withSpecifier(located(namedBindingsOf(typeImport), 'import'), name)]);
  }
  if (valueImport !== undefined) {
    const specifier = typeOnly ? `type ${name}` : name;
    return applied(text, [
      withSpecifier(located(namedBindingsOf(valueImport), 'import'), specifier),
    ]);
  }
  if (typeImport !== undefined) {
    const types = located(namedBindingsOf(typeImport), 'import').elements.map(
      (element) => `type ${element.getText()}`,
    );
    const statement = `import { ${name}, ${types.join(', ')} } from '${from}';`;
    return applied(text, [{ start: typeImport.getStart(), end: typeImport.end, text: statement }]);
  }
  const statement = `import ${typeOnly ? 'type ' : ''}{ ${name} } from '${from}';`;
  return applied(text, [newDeclaration(source, imports, statement, from)]);
}

export function addImports(text: string, imports: readonly ImportSpec[]): string {
  return imports.reduce(addImport, text);
}

/** A file's import declarations, grouped and ordered as the repository's `import-x/order` wants. */
export function renderImports(imports: readonly ImportSpec[]): string {
  return addImports('', imports).trim();
}

// ------------------------------------------------------------------------ object literals

export type ObjectLocator =
  | { readonly decorator: string }
  | { readonly newExpression: string }
  | { readonly call: string }
  | { readonly variable: string };

function unwrapped(expression: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return unwrapped(expression.expression);
  }
  return expression;
}

function firstObjectArgument(
  call: ts.CallExpression | ts.NewExpression,
): ts.ObjectLiteralExpression {
  const [argument] = call.arguments ?? [];
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
    throw new Error(`${call.expression.getText()}(…) takes no object literal`);
  }
  return argument;
}

function objectAt(source: ts.SourceFile, locator: ObjectLocator): ts.ObjectLiteralExpression {
  const nodes = descendants(source);
  if ('decorator' in locator) {
    const decorator = nodes.find(
      (node): node is ts.Decorator =>
        ts.isDecorator(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText() === locator.decorator,
    );
    return firstObjectArgument(
      located(decorator, `@${locator.decorator}(…)`).expression as ts.CallExpression,
    );
  }
  if ('newExpression' in locator) {
    const created = nodes.find(
      (node): node is ts.NewExpression =>
        ts.isNewExpression(node) && node.expression.getText() === locator.newExpression,
    );
    return firstObjectArgument(located(created, `new ${locator.newExpression}(…)`));
  }
  if ('call' in locator) {
    const call = nodes.find(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && node.expression.getText() === locator.call,
    );
    return firstObjectArgument(located(call, `${locator.call}(…)`));
  }
  const declaration = nodes.find(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && node.name.getText() === locator.variable,
  );
  const initializer = located(declaration?.initializer, `const ${locator.variable}`);
  const object = unwrapped(initializer);
  if (!ts.isObjectLiteralExpression(object)) {
    throw new Error(`${locator.variable} is not an object literal`);
  }
  return object;
}

function propertyNamed(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText().replace(/['"]/g, '') === name,
  );
}

function appendedProperty(object: ts.ObjectLiteralExpression, property: string): Edit {
  const closing = object.end - 1;
  if (object.properties.length === 0) return insertion(closing, ` ${property} `);
  return insertion(closing, object.properties.hasTrailingComma ? ` ${property},` : `, ${property}`);
}

/** Appends `element` to the array held by `property`, creating the property when absent. */
export function addToArrayProperty(
  text: string,
  locator: ObjectLocator,
  property: string,
  element: string,
): string {
  const object = objectAt(parse(text), locator);
  const assignment = propertyNamed(object, property);
  if (assignment === undefined) {
    return applied(text, [appendedProperty(object, `${property}: [${element}]`)]);
  }
  return appendedElement(text, arrayOf(assignment.initializer, property), element);
}

/** Adds `key: value` to an object literal, or leaves it when the key is there already. */
export function addProperty(
  text: string,
  locator: ObjectLocator,
  key: string,
  value: string,
): string {
  const object = objectAt(parse(text), locator);
  if (propertyNamed(object, key) !== undefined) return text;
  const written = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
  return applied(text, [appendedProperty(object, `${written}: ${value}`)]);
}

// ---------------------------------------------------------------------------------- classes

function classNamed(source: ts.SourceFile, name: string): ts.ClassDeclaration {
  return located(
    source.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && statement.name?.text === name,
    ),
    `class ${name}`,
  );
}

export function hasClassMember(text: string, className: string, member: string): boolean {
  return classNamed(parse(text), className).members.some(
    (existing) => existing.name?.getText() === member,
  );
}

/** Appended to the class, or placed before the member named `before` when it has one. */
export function addClassMember(
  text: string,
  className: string,
  member: string,
  before?: string,
): string {
  const declaration = classNamed(parse(text), className);
  const next =
    before === undefined
      ? undefined
      : declaration.members.find((existing) => existing.name?.getText() === before);
  if (next !== undefined) return applied(text, [insertion(next.getFullStart(), `\n${member}\n`)]);
  return applied(text, [insertion(declaration.end - 1, `\n${member}\n`)]);
}

/** A statement placed before the top-level declaration named `name`, and its comment. */
export function addStatementBefore(text: string, name: string, statement: string): string {
  const target = located(
    parse(text).statements.find(
      (candidate) =>
        (ts.isTypeAliasDeclaration(candidate) ||
          ts.isInterfaceDeclaration(candidate) ||
          ts.isClassDeclaration(candidate) ||
          ts.isFunctionDeclaration(candidate)) &&
        candidate.name?.text === name,
    ),
    name,
  );
  return applied(text, [insertion(target.getFullStart(), `\n\n${statement}`)]);
}

export function hasDeclaration(text: string, name: string): boolean {
  return parse(text).statements.some(
    (statement) =>
      (ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement)) &&
      statement.name?.text === name,
  );
}

// -------------------------------------------------------------------------- types, functions

/** `type A = B | C`, or a lone `type A = B`, gains `| member`. */
export function addUnionMember(text: string, typeName: string, member: string): string {
  const alias = located(
    parse(text).statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
    ),
    `type ${typeName}`,
  );
  const members = ts.isUnionTypeNode(alias.type) ? alias.type.types : [alias.type];
  if (members.some((existing) => existing.getText() === member)) return text;
  return applied(text, [insertion(alias.type.end, ` | ${member}`)]);
}

function functionNamed(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  return located(
    source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    ),
    `function ${name}`,
  );
}

const returnsNull = (clause: ts.CaseOrDefaultClause): boolean =>
  clause.statements.some(
    (statement) =>
      ts.isReturnStatement(statement) && statement.expression?.kind === ts.SyntaxKind.NullKeyword,
  );

/**
 * A `case label:` in the first `switch` of `functionName`, falling through to the clause that
 *   returns null, or returning null before `default` when none does.
 */
export function addNullCase(text: string, functionName: string, label: string): string {
  const declaration = functionNamed(parse(text), functionName);
  const switched = located(
    descendants(declaration).find((node): node is ts.SwitchStatement => ts.isSwitchStatement(node)),
    `switch in ${functionName}`,
  );
  const clauses = switched.caseBlock.clauses;
  if (clauses.some((clause) => ts.isCaseClause(clause) && clause.expression.getText() === label)) {
    return text;
  }
  const nullClause = clauses.find((clause) => ts.isCaseClause(clause) && returnsNull(clause));
  if (nullClause !== undefined) {
    return applied(text, [insertion(nullClause.getStart(), `case ${label}:\n`)]);
  }
  const fallback = clauses.find(ts.isDefaultClause);
  const at = fallback === undefined ? switched.caseBlock.end - 1 : fallback.getStart();
  return applied(text, [insertion(at, `case ${label}:\nreturn null;\n`)]);
}

/** A parameter appended to a function declaration's list, unless one has that name already. */
export function addParameter(text: string, functionName: string, parameter: string): string {
  const declaration = functionNamed(parse(text), functionName);
  const name = parameter.split(':')[0]?.trim();
  if (declaration.parameters.some((existing) => existing.name.getText() === name)) return text;
  const last = declaration.parameters[declaration.parameters.length - 1];
  const at = last === undefined ? declaration.parameters.pos : last.end;
  return applied(text, [insertion(at, `${last === undefined ? '' : ', '}${parameter}`)]);
}

/** A property added first to the object literal `functionName` returns. */
export function addReturnedProperty(text: string, functionName: string, property: string): string {
  const declaration = functionNamed(parse(text), functionName);
  const returned = located(
    descendants(declaration).find(
      (node): node is ts.ReturnStatement =>
        ts.isReturnStatement(node) &&
        node.expression !== undefined &&
        ts.isObjectLiteralExpression(node.expression),
    ),
    `returned object in ${functionName}`,
  ).expression as ts.ObjectLiteralExpression;
  const key = property.split(':')[0]?.trim();
  if (returned.properties.some((existing) => existing.name?.getText() === key)) return text;
  const first = returned.properties[0];
  if (first === undefined) return applied(text, [insertion(returned.end - 1, ` ${property} `)]);
  return applied(text, [insertion(first.getStart(), `${property}, `)]);
}

/**
 * A member added to interface `name`; a `type name = Base` alias becomes
 *   `interface name extends Base`, since an empty interface is what lint refuses.
 */
export function addInterfaceMember(text: string, name: string, member: string): string {
  const source = parse(text);
  const statement = located(
    source.statements.find(
      (candidate) =>
        (ts.isInterfaceDeclaration(candidate) || ts.isTypeAliasDeclaration(candidate)) &&
        candidate.name.text === name,
    ),
    `interface ${name}`,
  );
  if (ts.isInterfaceDeclaration(statement)) {
    const key = member
      .replace(/^readonly\s+/, '')
      .split(':')[0]
      ?.trim();
    if (statement.members.some((existing) => existing.name?.getText() === key)) return text;
    return applied(text, [insertion(statement.end - 1, `\n${member}\n`)]);
  }
  const alias = statement as ts.TypeAliasDeclaration;
  const exported = alias.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
  const rewritten = `${exported === true ? 'export ' : ''}interface ${name} extends ${alias.type.getText()} {\n${member}\n}`;
  return applied(text, [{ start: alias.getStart(), end: alias.end, text: rewritten }]);
}

/** An `it(…)` appended to the `describe(title, …)` block. */
export function addToDescribe(text: string, title: string, testCase: string): string {
  const describe = located(
    descendants(parse(text)).find(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        node.expression.getText() === 'describe' &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === title,
    ),
    `describe('${title}')`,
  );
  const body = describe.arguments[1];
  if (body === undefined || !(ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
    throw new Error(`describe('${title}') has no function body`);
  }
  return applied(text, [insertion(body.body.end - 1, `\n${testCase}\n`)]);
}

function arrayOf(expression: ts.Expression, what: string): ts.ArrayLiteralExpression {
  const inner = unwrapped(expression);
  if (ts.isArrayLiteralExpression(inner)) return inner;
  if (ts.isNewExpression(inner)) {
    const [argument] = inner.arguments ?? [];
    if (argument !== undefined && ts.isArrayLiteralExpression(argument)) return argument;
  }
  throw new Error(`${what} holds no array literal`);
}

function appendedElement(text: string, array: ts.ArrayLiteralExpression, element: string): string {
  if (array.elements.some((existing) => existing.getText().replace(/"/g, "'") === element)) {
    return text;
  }
  const last = array.elements[array.elements.length - 1];
  if (last === undefined) return applied(text, [insertion(array.getStart() + 1, element)]);
  return applied(text, [insertion(last.end, `, ${element}`)]);
}

/** Appends to `const name = [...]`, `new Set([...])` or `new Map([...])`, unless already there. */
export function addToCollection(text: string, variable: string, element: string): string {
  const declaration = located(
    descendants(parse(text)).find(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && node.name.getText() === variable,
    ),
    `const ${variable}`,
  );
  const array = arrayOf(located(declaration.initializer, `${variable}'s value`), variable);
  return appendedElement(text, array, element);
}

/** Sorts the string elements of the array literal whose elements all match `pattern`, adding one. */
export function addToSortedStringArray(text: string, pattern: RegExp, value: string): string {
  const array = located(
    descendants(parse(text)).find(
      (node): node is ts.ArrayLiteralExpression =>
        ts.isArrayLiteralExpression(node) &&
        node.elements.length > 0 &&
        node.elements.every((element) => ts.isStringLiteral(element) && pattern.test(element.text)),
    ),
    `array of ${String(pattern)}`,
  );
  const values = array.elements.map((element) => (element as ts.StringLiteral).text);
  if (values.includes(value)) return text;
  const sorted = [...values, value].sort().map((element) => `'${element}'`);
  return applied(text, [
    { start: array.getStart(), end: array.end, text: `[${sorted.join(', ')}]` },
  ]);
}

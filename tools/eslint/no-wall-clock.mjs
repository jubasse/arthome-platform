/**
 * The machine's time is read through the injected `Clock`: e52e1ab fixed a handler that stamped its
 *   outbox row with `new Date()` while its suite fixed the clock, and that failed once real time
 *   passed the suite's instant. `new Date(x)` converts and stays allowed.
 */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global']);

/** The name a member or a destructured property reads: `a.now`, `a['now']`, `{ now }`. */
function nameOf(key, computed) {
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return key.value;
  return undefined;
}

/** `name`, or `globalThis.name`. */
function isGlobal(node, name) {
  if (node.type === 'Identifier') return node.name === name;
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    GLOBAL_OBJECTS.has(node.object.name) &&
    nameOf(node.property, node.computed) === name
  );
}

export const noWallClock = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid reading the machine time outside the injected Clock' },
    schema: [],
    messages: {
      wallClock:
        'Read the time through the injected `Clock` (`clock.now()`, `clock.nowMs()`), which a suite can fix. ' +
        'A real wait or timer disables this line with its reason: `-- <why the machine time>`.',
    },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'wallClock' });
    return {
      NewExpression(node) {
        if (node.arguments.length === 0 && isGlobal(node.callee, 'Date')) report(node);
      },
      CallExpression(node) {
        if (isGlobal(node.callee, 'Date')) report(node);
      },
      MemberExpression(node) {
        const name = nameOf(node.property, node.computed);
        if (name === 'now' && isGlobal(node.object, 'Date')) report(node);
        if (name === 'Now' && isGlobal(node.object, 'Temporal')) report(node);
      },
      VariableDeclarator(node) {
        const destructuresNow =
          node.id.type === 'ObjectPattern' &&
          node.id.properties.some(
            (p) => p.type === 'Property' && nameOf(p.key, p.computed) === 'now',
          );
        if (destructuresNow && node.init !== null && isGlobal(node.init, 'Date')) report(node);
      },
    };
  },
};

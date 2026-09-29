/**
 * The machine's time is read through the injected `Clock`: e52e1ab fixed a handler that stamped its
 *   outbox row with `new Date()` while its suite fixed the clock, and that failed once real time
 *   passed the suite's instant. `new Date(x)` converts and stays allowed.
 */
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
      "NewExpression[callee.name='Date'][arguments.length=0]": report,
      "CallExpression[callee.name='Date']": report,
      "MemberExpression[object.name='Date'][property.name='now']": report,
    };
  },
};

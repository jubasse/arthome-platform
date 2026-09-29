import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import { noWallClock } from './no-wall-clock.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const wallClock = [{ messageId: 'wallClock' }];

new RuleTester().run('no-wall-clock', noWallClock, {
  valid: [
    'new Date(0)',
    'new Date(clock.nowMs())',
    'Date.parse(instant)',
    'clock.now()',
    'performance.now()',
    'new globalThis.Date(0)',
    'const { parse } = Date;',
    'clock.Now',
  ],
  invalid: [
    { code: 'new Date()', errors: wallClock },
    { code: 'new Date', errors: wallClock },
    { code: 'Date.now()', errors: wallClock },
    { code: 'const read = Date.now;', errors: wallClock },
    { code: 'Date()', errors: wallClock },
    { code: 'new Date(Date.now())', errors: wallClock },
    { code: 'function stamp(now = new Date()) { return now; }', errors: wallClock },
    { code: 'new globalThis.Date()', errors: wallClock },
    { code: 'globalThis.Date.now()', errors: wallClock },
    { code: "Date['now']()", errors: wallClock },
    { code: 'const { now } = Date;', errors: wallClock },
    { code: 'Temporal.Now.instant()', errors: wallClock },
    { code: 'globalThis.Temporal.Now.plainDateISO()', errors: wallClock },
  ],
});

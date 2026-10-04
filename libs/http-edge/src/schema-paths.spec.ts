import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sensitive } from '@arthome/contracts/http';

import { REDACTED, redactSensitive, withoutPath } from './schema-paths.js';

describe('withoutPath', () => {
  it('removes the field at a path, through arrays and records, leaving no key behind', () => {
    const body = {
      data: {
        items: [
          { id: 'a', revenue: 1 },
          { id: 'b', revenue: 2 },
        ],
        byDate: { d1: { revenue: 3, seats: 4 } },
      },
    };

    expect(withoutPath(body, 'data.items[].revenue')).toEqual({
      data: { items: [{ id: 'a' }, { id: 'b' }], byDate: { d1: { revenue: 3, seats: 4 } } },
    });
    expect(withoutPath(body, 'data.byDate.*.revenue')).toMatchObject({
      data: { byDate: { d1: { seats: 4 } } },
    });
    expect(body.data.items[0]).toHaveProperty('revenue');
  });

  it('leaves a body without the field as it is', () => {
    expect(withoutPath({ data: { id: 'a' } }, 'data.revenue')).toEqual({ data: { id: 'a' } });
  });
});

describe('redactSensitive', () => {
  const schema = z.object({
    email: z.string(),
    password: sensitive(z.string()),
    devices: z.array(z.object({ name: z.string(), token: sensitive(z.string()) })),
  });

  it('replaces every sensitive field, and nothing else', () => {
    expect(
      redactSensitive(schema, {
        email: 'marie@example.test',
        password: 'a-long-password',
        devices: [{ name: 'tv', token: 'dev_123' }],
      }),
    ).toEqual({
      email: 'marie@example.test',
      password: REDACTED,
      devices: [{ name: 'tv', token: REDACTED }],
    });
  });

  it('adds no field a body did not carry', () => {
    expect(redactSensitive(schema, { email: 'marie@example.test' })).toEqual({
      email: 'marie@example.test',
    });
  });
});

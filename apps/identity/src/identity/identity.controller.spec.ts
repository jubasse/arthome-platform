import { describe, expect, it } from 'vitest';

import { IdentityController } from './identity.controller.js';
import type { RegisterAccountBody } from './register-account.schema.js';
import type { RegisterAccountCommand, RegisterAccountService } from './register-account.service.js';

/** A service that records the command it was handed, and registers nothing. */
function recordingService(commands: RegisterAccountCommand[]): RegisterAccountService {
  return {
    register: (command: RegisterAccountCommand) => {
      commands.push(command);
      return Promise.resolve({
        accountId: '0199a5c0-1f3e-7b4a-8c2d-6f1e9b7a4c35',
        messageId: 'message-1',
      });
    },
  } as unknown as RegisterAccountService;
}

const body: RegisterAccountBody = {
  publicHandle: '@marie.j',
  email: 'marie@example.test',
  locale: 'fr',
  country: 'FR',
};

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('IdentityController', () => {
  it('returns the public handle and never the internal account id', async () => {
    // `account.entity.ts` SAYS OF THE PRIMARY KEY "UUIDv7, never exposed", AND
    //   THE ROUTE RETURNED IT. `data-model.md` §7.1 gives the cost: a UUIDv7
    //   reveals its own creation instant and is orderable, so a caller holding two
    //   can order the population and date every account. The service still
    //   produces the id — it is the aggregate's identity and the partition key —
    //   and it simply does not leave.
    const commands: RegisterAccountCommand[] = [];
    const result = await new IdentityController(recordingService(commands)).register(body);

    expect(result).toEqual({ publicHandle: '@marie.j' });
    expect(JSON.stringify(result)).not.toContain('0199a5c0');
  });

  it('carries the traceparent the request arrived with', async () => {
    const commands: RegisterAccountCommand[] = [];
    const controller = new IdentityController(recordingService(commands));

    await controller.register(body, TRACEPARENT);
    expect(commands[0]?.traceparent).toBe(TRACEPARENT);
  });

  it('carries null rather than an empty traceparent when the header is absent', async () => {
    const commands: RegisterAccountCommand[] = [];
    await new IdentityController(recordingService(commands)).register(body);
    expect(commands[0]?.traceparent).toBeNull();
  });

  it('registers the account anyway when the traceparent is malformed, carrying none', async () => {
    // BOTH HALVES MATTER, AND THE FIRST IS THE DECIDED ONE. A broken trace is an
    //   observability fault, never a business one, so the registration MUST still
    //   happen — refusing it here would reopen a settled decision. The second half
    //   is why the check exists at all: the value would otherwise reach
    //   `outbox_event.tracecontext`, the one outbox column with no CHECK
    //   constraint, and from there a Kafka header and `notifications.welcome_email`.
    const commands: RegisterAccountCommand[] = [];
    const controller = new IdentityController(recordingService(commands));

    const result = await controller.register(body, 'garbage');

    expect(result).toEqual({ publicHandle: '@marie.j' });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.traceparent).toBeNull();
  });

  it('does not pass an all-zero trace context through as though it were a trace', async () => {
    const commands: RegisterAccountCommand[] = [];
    await new IdentityController(recordingService(commands)).register(
      body,
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    );
    expect(commands[0]?.traceparent).toBeNull();
  });

  it('hands the service exactly the four validated fields', async () => {
    const commands: RegisterAccountCommand[] = [];
    await new IdentityController(recordingService(commands)).register(body, TRACEPARENT);

    expect(commands[0]).toEqual({
      publicHandle: '@marie.j',
      email: 'marie@example.test',
      locale: 'fr',
      country: 'FR',
      traceparent: TRACEPARENT,
    });
  });
});

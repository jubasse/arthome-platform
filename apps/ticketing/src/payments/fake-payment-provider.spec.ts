import { describe, expect, it } from 'vitest';

import {
  FixedClock,
  money,
  plusSeconds,
  IntentStatus,
  PaymentEventKind,
  PaymentProviderUnavailable,
  type PaymentIntentRequest,
} from '@arthome/core';

import { FakePaymentProvider, FakePaymentScenario, intentRefOf } from './fake-payment-provider.js';
import { NextActionKind } from './next-action.js';

const NOW = '2026-09-28T10:00:00.000Z';
const SECRET = 'a-webhook-secret-long-enough-to-pass';
const ORDER = '01a0f500-0000-7000-8000-000000000001';

function request(orderId = ORDER): PaymentIntentRequest {
  return {
    orderId,
    amount: money(4800, 'EUR'),
    expiresAt: '2026-09-28T10:15:00.000Z',
    returnUrl: 'http://localhost:3000/order/x',
  };
}

function provider(): FakePaymentProvider {
  return new FakePaymentProvider(SECRET, new FixedClock(NOW));
}

describe('the fake payment provider', () => {
  it('answers a retried intent with the one it created, under the order id', async () => {
    const fake = provider();
    const first = await fake.createIntent(request());
    fake.scenarioOf = () => FakePaymentScenario.DECLINE;

    expect(await fake.createIntent(request())).toEqual(first);
    expect(first).toMatchObject({ ref: intentRefOf(ORDER), status: IntentStatus.SUCCEEDED });
  });

  it('plays each scenario: action required, declined, and no answer at all', async () => {
    const fake = provider();
    fake.scenarioOf = ({ orderId }) =>
      orderId.endsWith('1')
        ? FakePaymentScenario.REQUIRE_ACTION
        : orderId.endsWith('2')
          ? FakePaymentScenario.DECLINE
          : FakePaymentScenario.UNAVAILABLE;

    expect(await fake.createIntent(request())).toMatchObject({
      status: IntentStatus.REQUIRES_ACTION,
      nextAction: { kind: NextActionKind.REDIRECT_TO_URL },
    });
    expect(await fake.createIntent(request(ORDER.replace(/1$/, '2')))).toMatchObject({
      status: IntentStatus.DECLINED,
      declineCode: 'card_declined',
    });
    await expect(fake.createIntent(request(ORDER.replace(/1$/, '3')))).rejects.toBeInstanceOf(
      PaymentProviderUnavailable,
    );
  });

  it('refunds once per idempotency key, and only money it took', async () => {
    const fake = provider();
    const { ref } = await fake.createIntent(request());
    const refund = {
      intentRef: ref,
      amount: money(4800, 'EUR'),
      idempotencyKey: `refund:${ORDER}`,
      refundApplicationFee: true,
    };

    const first = await fake.refund(refund);
    expect(await fake.refund(refund)).toEqual(first);
    expect(fake.refundsMade).toBe(1);

    fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
    const pending = await fake.createIntent(request(ORDER.replace(/1$/, '4')));
    await expect(
      fake.refund({ ...refund, intentRef: pending.ref, idempotencyKey: 'refund:other' }),
    ).rejects.toThrow(/no money/);
  });

  it("refunds an intent another instance created, as the worker's fake is asked the API's", async () => {
    const api = provider();
    const worker = provider();
    const { ref } = await api.createIntent(request());

    const { refundRef } = await worker.refund({
      intentRef: ref,
      amount: money(4800, 'EUR'),
      idempotencyKey: `refund:${ORDER}`,
      refundApplicationFee: true,
    });

    expect(refundRef).toMatch(/^re_fake_/);
    await worker.cancelIntent(ref, `cancel:${ORDER}`);
    expect(worker.isCanceled(ref)).toBe(false);
    const neverAsked = (await api.createIntent(request(ORDER.replace(/1$/, '9')))).ref;
    expect(() => worker.isCanceled(neverAsked)).toThrow(/no intent/);
    expect(() => worker.completeAction(neverAsked)).toThrow(/no intent/);
    await expect(
      worker.refund({
        intentRef: 'pi_other',
        amount: money(1, 'EUR'),
        idempotencyKey: 'x',
        refundApplicationFee: true,
      }),
    ).rejects.toThrow(/no intent pi_other/);
  });

  it('cancels an intent still waiting, and leaves a succeeded one succeeded', async () => {
    const fake = provider();
    fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
    const waiting = await fake.createIntent(request());
    fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
    const paid = await fake.createIntent(request(ORDER.replace(/1$/, '2')));

    await fake.cancelIntent(waiting.ref, `cancel:${ORDER}`);
    await fake.cancelIntent(paid.ref, 'cancel:other');

    expect(fake.isCanceled(waiting.ref)).toBe(true);
    expect(fake.isCanceled(paid.ref)).toBe(false);
  });

  it('signs a webhook the webhook port verifies and parses back', async () => {
    const fake = provider();
    fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
    const { ref } = await fake.createIntent(request());

    const webhook = fake.completeAction(ref);

    expect(fake.verifySignature(webhook.body, webhook.signature, NOW)).toBe(true);
    expect(fake.parse(webhook.body)).toEqual({
      eventId: 'evt_fake_000001',
      kind: PaymentEventKind.INTENT_SUCCEEDED,
      intentRef: ref,
      orderId: ORDER,
      occurredAt: NOW,
      declineCode: null,
      refundRef: null,
      amountRefunded: null,
    });
  });

  it('refuses a body the signature does not cover, a missing signature, and a stale one', async () => {
    const fake = provider();
    const { ref } = await fake.createIntent(request());
    const webhook = fake.webhookOf(ref, PaymentEventKind.INTENT_SUCCEEDED);
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(webhook.body.toString()), null, 2));

    expect(fake.verifySignature(reformatted, webhook.signature, NOW)).toBe(false);
    expect(fake.verifySignature(webhook.body, undefined, NOW)).toBe(false);
    expect(fake.verifySignature(webhook.body, webhook.signature, plusSeconds(NOW, 301))).toBe(
      false,
    );
    expect(fake.verifySignature(webhook.body, webhook.signature, plusSeconds(NOW, 300))).toBe(true);
  });

  it('parses nothing out of bytes that are not one of its events', () => {
    const fake = provider();

    expect(fake.parse(Buffer.from('not json'))).toBeNull();
    expect(fake.parse(Buffer.from('{"id":"evt_1"}'))).toBeNull();
  });

  it('reaches nothing while it is down', async () => {
    const fake = provider();
    const { ref } = await fake.createIntent(request());
    fake.down = true;

    await expect(fake.cancelIntent(ref, 'cancel:x')).rejects.toBeInstanceOf(
      PaymentProviderUnavailable,
    );
    expect(fake.calls).toEqual([`createIntent ${ORDER}`, 'cancelIntent cancel:x']);
  });
});

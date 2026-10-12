## 0g. The payment ports (T3)

`@arthome/core` carries `adr-payments.md` §4's ports: `PaymentPort` (`createIntent`, keyed by the
order id, `cancelIntent`, keyed `cancel:{orderId}`, `refund`, keyed by its refund's row, §0m) and `PaymentWebhookPort`
(`verifySignature` on the exact bytes, `parse`). They are interfaces, so
`payments/payment-tokens.ts` holds the two injection tokens, `PAYMENT_PORT` and
`PAYMENT_WEBHOOK_PORT`, as `CLOCK` does. A provider's references are opaque strings, a next action's
`kind` too: `payments/next-action.ts` names the two kinds the fake and the suites speak.
`PaymentProviderUnavailable` says the provider could not say what it did, so the caller retries
under the same key.

`FakePaymentProvider` is the adapter bound by default (`payments.module.ts`), both ports on one
instance, since a webhook speaks of the intents it created. Deterministic: an intent's reference is
derived from its order id, event ids are counted, and each intent plays `scenarioOf(request)`:
`confirm` (the default, confirmed synchronously), `require_action` (then `completeAction` or
`failAction` hands back the signed webhook saying how it ended), `decline`, `unavailable`. `down`
makes every call fail, the provider-down drill. Each process binds an instance of its own:
the worker's, asked to refund or cancel an intent the API's created, knows it by its reference,
its order's, as confirmed, which is what the running fake makes of every intent (PT0, since the
refunds left the API process); its test helpers stay strict. **For PT4's drills on a running
stack**: a cancellation there does nothing the API's fake sees (an intent known as confirmed is
not cancelled), and a refund there skips the "has taken no money" refusal. Prove those in a
suite, where one fake serves every port. Its signature is Stripe's scheme on its own header,
`x-fake-payment-signature: t=<seconds>,v1=<HMAC-SHA256 of "t.body">`, refused past core's
`PAYMENT_WEBHOOK_TOLERANCE_SECONDS`, adr-payments.md §7.1's five minutes. The secret is `PAYMENT_WEBHOOK_SECRET` (`@arthome-platform/config`'s
`readPaymentWebhookSecret`), defaulted outside production only, 32 characters at least.


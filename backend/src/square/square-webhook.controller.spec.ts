import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { SquareWebhookController } from './square-webhook.controller';

// Pure unit tests — hand-rolled mocks for the Mongoose model,
// IntegrationsService and the matching service, no real Mongo, no real
// HTTP server. Verifies the signature scheme confirmed live against
// Square's own docs + community-verified behavior (HMAC-SHA256 over
// notificationUrl+rawBody, base64, constant-time compare), scoped
// per-organization (each org's own saved app/secret — see
// square.service.ts's class comment on why there's no platform-wide one),
// and the event_id dedup contract.
describe('SquareWebhookController', () => {
  const ORG = 'org-1';
  const NOTIFICATION_URL = `https://haive.test/square/webhooks/${ORG}`;
  const SIGNING_KEY = 'super-secret-signing-key';

  function sign(rawBody: Buffer, notificationUrl = NOTIFICATION_URL, key = SIGNING_KEY): string {
    return createHmac('sha256', key).update(notificationUrl).update(rawBody).digest('base64');
  }

  function build(overrides: { webhookSecret?: string | null; notificationUrl?: string; resolveAuth?: jest.Mock; upsertFromPayment?: jest.Mock } = {}) {
    const create = jest.fn().mockResolvedValue(undefined);
    const updateOne = jest.fn().mockResolvedValue(undefined);
    const model = { create, updateOne };
    const integrations = {
      resolveWebhookSigningSecret: jest.fn().mockResolvedValue(overrides.webhookSecret === undefined ? SIGNING_KEY : overrides.webhookSecret),
      resolveOAuthAppCredentials: jest.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y', meta: { webhookNotificationUrl: overrides.notificationUrl ?? NOTIFICATION_URL } }),
      resolveAuth: overrides.resolveAuth ?? jest.fn().mockResolvedValue({ credentials: { accessToken: 'sq-at' }, oauthMeta: { environment: 'sandbox' } }),
    };
    const matching = { upsertFromPayment: overrides.upsertFromPayment ?? jest.fn().mockResolvedValue(undefined) };
    const controller = new SquareWebhookController(model as never, integrations as never, matching as never);
    return { controller, create, updateOne, integrations, matching };
  }

  function fakeRequest(body: Record<string, unknown>) {
    const raw = Buffer.from(JSON.stringify(body));
    return { rawBody: raw } as never;
  }

  it('accepts and stores an event with a valid signature, scoped to the organization in the path', async () => {
    const { controller, create } = build();
    const payload = { event_id: 'evt_1', type: 'payment.updated' };
    const req = fakeRequest(payload);
    const signature = sign((req as { rawBody: Buffer }).rawBody);

    const result = await controller.handle(ORG, req, signature);

    expect(result).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({ eventId: 'evt_1', organizationId: ORG, eventType: 'payment.updated', payload });
  });

  it('rejects a request with an invalid signature', async () => {
    const { controller, create } = build();
    const req = fakeRequest({ event_id: 'evt_2', type: 'payment.updated' });

    await expect(controller.handle(ORG, req, 'totally-wrong-signature')).rejects.toThrow(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a request signed with another organization\'s key (cross-org isolation)', async () => {
    const { controller } = build();
    const req = fakeRequest({ event_id: 'evt_3', type: 'payment.updated' });
    const wrongOrgSignature = sign((req as { rawBody: Buffer }).rawBody, NOTIFICATION_URL, 'a-different-orgs-key');

    await expect(controller.handle(ORG, req, wrongOrgSignature)).rejects.toThrow(BadRequestException);
  });

  it('rejects when this organization has no webhook signing secret configured yet (e.g. a Personal-Access-Token connection)', async () => {
    const { controller } = build({ webhookSecret: null });
    const req = fakeRequest({ event_id: 'evt_4', type: 'payment.updated' });

    await expect(controller.handle(ORG, req, 'anything')).rejects.toThrow(BadRequestException);
  });

  it('rejects a request missing the signature header entirely', async () => {
    const { controller } = build();
    const req = fakeRequest({ event_id: 'evt_5', type: 'payment.updated' });

    await expect(controller.handle(ORG, req, undefined)).rejects.toThrow(BadRequestException);
  });

  it('acknowledges a duplicate delivery as a no-op instead of throwing (Square retries for up to 24h)', async () => {
    const { controller, create, matching } = build();
    create.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    const req = fakeRequest({ event_id: 'evt_dup', type: 'payment.updated' });
    const signature = sign((req as { rawBody: Buffer }).rawBody);

    const result = await controller.handle(ORG, req, signature);

    expect(result).toEqual({ ok: true, duplicate: true });
    expect(matching.upsertFromPayment).not.toHaveBeenCalled();
  });

  it('rejects a payload missing event_id', async () => {
    const { controller } = build();
    const req = fakeRequest({ type: 'payment.updated' });
    const signature = sign((req as { rawBody: Buffer }).rawBody);

    await expect(controller.handle(ORG, req, signature)).rejects.toThrow(BadRequestException);
  });

  it('processes a payment.updated event\'s payment object through the matching service and marks it processed', async () => {
    const { controller, updateOne, matching } = build();
    const payment = { id: 'pay_1', status: 'COMPLETED', amount_money: { amount: 1000, currency: 'USD' } };
    const payload = { event_id: 'evt_6', type: 'payment.updated', data: { object: { payment } } };
    const req = fakeRequest(payload);
    const signature = sign((req as { rawBody: Buffer }).rawBody);

    await controller.handle(ORG, req, signature);

    expect(matching.upsertFromPayment).toHaveBeenCalledWith(ORG, 'sq-at', 'sandbox', payment, 'evt_6');
    expect(updateOne).toHaveBeenCalledWith({ eventId: 'evt_6' }, { $set: { processed: true } });
  });

  it('still stores the event (never re-throws) if processing the payment fails, so Square doesn\'t keep retrying an already-recorded delivery', async () => {
    const upsertFromPayment = jest.fn().mockRejectedValue(new Error('matching failed'));
    const { controller, create } = build({ upsertFromPayment });
    const payload = { event_id: 'evt_7', type: 'payment.updated', data: { object: { payment: { id: 'pay_2', status: 'COMPLETED' } } } };
    const req = fakeRequest(payload);
    const signature = sign((req as { rawBody: Buffer }).rawBody);

    const result = await controller.handle(ORG, req, signature);

    expect(result).toEqual({ ok: true });
    expect(create).toHaveBeenCalled();
  });

  it('does not process a payload with no payment object at all (e.g. an event type not yet handled)', async () => {
    const { controller, matching } = build();
    const payload = { event_id: 'evt_8', type: 'some.other.event' };
    const req = fakeRequest(payload);
    const signature = sign((req as { rawBody: Buffer }).rawBody);

    await controller.handle(ORG, req, signature);

    expect(matching.upsertFromPayment).not.toHaveBeenCalled();
  });
});

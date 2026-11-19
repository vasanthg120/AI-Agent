import { SquareReconciliationService } from './square-reconciliation.service';

// Pure unit tests against hand-rolled mocks of IntegrationsService/
// SquareService/SquarePaymentMatchingService — same technique as
// square.service.spec.ts, no real network calls, no real Mongo. Covers the
// reconciliation cron's own 6-hour lookback, the initial-sync full-history
// pull a new connection triggers (square.controller.ts), pagination, and
// the "no connection, nothing to do" / "one org failing never stops the
// others" resilience the class comment describes.
describe('SquareReconciliationService', () => {
  function build(overrides: { resolveAuth?: jest.Mock; listPayments?: jest.Mock; upsertFromPayment?: jest.Mock; listConnectedOrganizationIds?: jest.Mock } = {}) {
    const integrations = {
      resolveAuth: overrides.resolveAuth ?? jest.fn().mockResolvedValue({ credentials: { accessToken: 'tok' }, oauthMeta: { environment: 'sandbox' } }),
      listConnectedOrganizationIds: overrides.listConnectedOrganizationIds ?? jest.fn().mockResolvedValue([]),
    };
    const square = { listPayments: overrides.listPayments ?? jest.fn().mockResolvedValue({ payments: [] }) };
    const matching = { upsertFromPayment: overrides.upsertFromPayment ?? jest.fn().mockResolvedValue(undefined) };
    const service = new SquareReconciliationService(integrations as never, square as never, matching as never);
    return { service, integrations, square, matching };
  }

  it('reconcileOrganization defaults to a bounded lookback window (the 30-minute cron\'s own safety-net scope), not full history', async () => {
    const listPayments = jest.fn().mockResolvedValue({ payments: [] });
    const { service } = build({ listPayments });

    await service.reconcileOrganization('org-1');

    const [, filters] = listPayments.mock.calls[0];
    expect(filters.beginTime).toBeDefined();
    expect(new Date(filters.beginTime).getTime()).toBeLessThan(Date.now());
    expect(new Date(filters.beginTime).getTime()).toBeGreaterThan(Date.now() - 7 * 60 * 60 * 1000);
  });

  it('initialSync pulls full history — no beginTime at all, so Square\'s own default (the last year) applies', async () => {
    const listPayments = jest.fn().mockResolvedValue({ payments: [] });
    const { service } = build({ listPayments });

    await service.initialSync('org-1');

    const [, filters] = listPayments.mock.calls[0];
    expect(filters.beginTime).toBeUndefined();
  });

  it('pages through every payment via the cursor and upserts each one through the matching service', async () => {
    const listPayments = jest
      .fn()
      .mockResolvedValueOnce({ payments: [{ id: 'p1' }, { id: 'p2' }], cursor: 'next-page' })
      .mockResolvedValueOnce({ payments: [{ id: 'p3' }] });
    const upsertFromPayment = jest.fn().mockResolvedValue(undefined);
    const { service } = build({ listPayments, upsertFromPayment });

    const result = await service.initialSync('org-1');

    expect(listPayments).toHaveBeenCalledTimes(2);
    expect(listPayments.mock.calls[1][1]).toMatchObject({ cursor: 'next-page' });
    expect(upsertFromPayment).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ count: 3 });
  });

  it('an organization with no Square connection is a no-op, not an error', async () => {
    const resolveAuth = jest.fn().mockResolvedValue(null);
    const { service, square } = build({ resolveAuth });

    const result = await service.reconcileOrganization('org-1');

    expect(result).toEqual({ count: 0 });
    expect(square.listPayments).not.toHaveBeenCalled();
  });

  it('reconcileAll keeps going when one organization fails, and never touches an organization twice in one pass', async () => {
    const listConnectedOrganizationIds = jest.fn().mockResolvedValue(['org-bad', 'org-good']);
    const resolveAuth = jest.fn().mockResolvedValue({ credentials: { accessToken: 'tok' }, oauthMeta: { environment: 'sandbox' } });
    const listPayments = jest.fn().mockImplementation((organizationId: string) => {
      if (organizationId === 'org-bad') throw new Error('Square is down');
      return Promise.resolve({ payments: [] });
    });
    const { service, square } = build({ listConnectedOrganizationIds, resolveAuth, listPayments });

    await expect(service.reconcileAll()).resolves.toBeUndefined();
    expect(square.listPayments).toHaveBeenCalledTimes(2);
  });
});

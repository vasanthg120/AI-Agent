import { SquareReconciliationService } from './square-reconciliation.service';

// Pure unit tests against hand-rolled mocks of IntegrationsService/
// SquareService/SquarePaymentMatchingService — same technique as
// square.service.spec.ts, no real network calls, no real Mongo. Covers the
// reconciliation cron's own 6-hour lookback, the initial-sync full-history
// pull a new connection triggers (square.controller.ts), pagination, and
// the "no connection, nothing to do" / "one org failing never stops the
// others" resilience the class comment describes.
describe('SquareReconciliationService', () => {
  function build(overrides: { resolveAuth?: jest.Mock; listPayments?: jest.Mock; upsertFromPayment?: jest.Mock; listConnectedOrganizationIds?: jest.Mock; listInvoiceRefsByOrder?: jest.Mock } = {}) {
    const integrations = {
      resolveAuth: overrides.resolveAuth ?? jest.fn().mockResolvedValue({ credentials: { accessToken: 'tok' }, oauthMeta: { environment: 'sandbox' } }),
      listConnectedOrganizationIds: overrides.listConnectedOrganizationIds ?? jest.fn().mockResolvedValue([]),
    };
    const square = { listPayments: overrides.listPayments ?? jest.fn().mockResolvedValue({ payments: [] }), listInvoiceRefsByOrder: overrides.listInvoiceRefsByOrder ?? jest.fn().mockResolvedValue(new Map()) };
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
    expect(result).toMatchObject({ count: 3, failed: 0 });
  });

  it('an organization with no Square connection is a no-op, not an error', async () => {
    const resolveAuth = jest.fn().mockResolvedValue(null);
    const { service, square } = build({ resolveAuth });

    const result = await service.reconcileOrganization('org-1');

    expect(result).toMatchObject({ count: 0 });
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

  describe('historical reconciliation (full history)', () => {
    it('reads the invoices of the org once, hands them to every upsert, and reports linked / without-invoice counts', async () => {
      const invoices = new Map([['o1', { number: '4546', title: '4546 - Surry Hills' }]]);
      const listInvoiceRefsByOrder = jest.fn().mockResolvedValue(invoices);
      const listPayments = jest.fn().mockResolvedValue({ payments: [{ id: 'p1', order_id: 'o1' }, { id: 'p2', order_id: 'o2' }] });
      const upsertFromPayment = jest.fn().mockResolvedValue(undefined);
      const { service } = build({ listInvoiceRefsByOrder, listPayments, upsertFromPayment });

      const result = await service.initialSync('org-1');

      expect(listInvoiceRefsByOrder).toHaveBeenCalledTimes(1);
      expect(listInvoiceRefsByOrder).toHaveBeenCalledWith('org-1');
      expect(upsertFromPayment.mock.calls[0][5]).toBe(invoices);
      expect(result).toEqual({ count: 2, invoiceLinked: 1, withoutInvoice: 1, failed: 0 });
    });

    it('is idempotent: a second run reports the same counts and upserts the same payments (no duplicates are created by it)', async () => {
      const listPayments = jest.fn().mockResolvedValue({ payments: [{ id: 'p1' }, { id: 'p2' }] });
      const upsertFromPayment = jest.fn().mockResolvedValue(undefined);
      const { service } = build({ listPayments, upsertFromPayment });
      const first = await service.initialSync('org-1');
      const second = await service.initialSync('org-1');
      expect(second).toEqual(first);
      expect(upsertFromPayment.mock.calls.slice(0, 2).map((c) => c[3].id)).toEqual(upsertFromPayment.mock.calls.slice(2).map((c) => c[3].id));
    });

    it('one payment failing is counted and skipped — the rest still reconcile', async () => {
      const listPayments = jest.fn().mockResolvedValue({ payments: [{ id: 'p1' }, { id: 'bad' }, { id: 'p3' }] });
      const upsertFromPayment = jest.fn().mockImplementation((_o, _t, _e, payment) => (payment.id === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve()));
      const { service } = build({ listPayments, upsertFromPayment });
      const result = await service.initialSync('org-1');
      expect(result).toMatchObject({ count: 2, failed: 1 });
    });

    it('falls back to the per-payment lookup when the invoice pre-read fails, and the bounded cron never pre-reads', async () => {
      const listInvoiceRefsByOrder = jest.fn().mockRejectedValue(new Error('403'));
      const upsertFromPayment = jest.fn().mockResolvedValue(undefined);
      const listPayments = jest.fn().mockResolvedValue({ payments: [{ id: 'p1' }] });
      const { service } = build({ listInvoiceRefsByOrder, upsertFromPayment, listPayments });
      await service.initialSync('org-1');
      expect(upsertFromPayment.mock.calls[0][5]).toBeUndefined();
      await service.reconcileOrganization('org-1');
      expect(listInvoiceRefsByOrder).toHaveBeenCalledTimes(1);
    });
  });
});

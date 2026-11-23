import { PaymentEvents } from '../common/payments/payment-events';
import { SquarePaymentMatchingService } from '../square/square-payment-matching.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';

describe('payment change signals trigger reconciliation', () => {
  afterEach(() => jest.useRealTimers());

  it('a burst of signals for one organization reconciles it once (debounced), each organization separately', () => {
    jest.useFakeTimers();
    const events = new PaymentEvents();
    const service = new PaymentReconciliationService({} as never, { invalidate: jest.fn() } as never, {} as never, {} as never, events);
    const run = jest.spyOn(service, 'reconcileOrganization').mockResolvedValue({} as never);
    service.onModuleInit();
    events.notify('org-a', 'gateway-payment');
    events.notify('org-a', 'refund');
    events.notify('org-a', 'crm-sync');
    events.notify('org-b', 'quote-payment');
    jest.advanceTimersByTime(5_000);
    expect(run.mock.calls.map((c) => c[0]).sort()).toEqual(['org-a', 'org-b']);
  });

  it('a failing subscriber never breaks the publisher', () => {
    const events = new PaymentEvents();
    events.subscribe(() => {
      throw new Error('boom');
    });
    expect(() => events.notify('org', 'manual')).not.toThrow();
  });

  it('a Square payment upsert (webhook or reconciliation) and a refund publish the signal', async () => {
    const events = new PaymentEvents();
    const seen: [string, string][] = [];
    events.subscribe((org, reason) => seen.push([org, reason]));
    const model = { updateOne: jest.fn().mockResolvedValue({}), findOne: jest.fn(() => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) })) };
    const service = new SquarePaymentMatchingService(model as never, { get: jest.fn(), post: jest.fn() } as never, { emitToOrg: jest.fn() } as never, events);
    await service.upsertFromPayment('org-1', 'tok', 'sandbox', { id: 'p1', status: 'COMPLETED', amount_money: { amount: 100, currency: 'AUD' } });
    await service.upsertFromPayment('org-1', 'tok', 'sandbox', { id: 'p1', status: 'COMPLETED', amount_money: { amount: 100, currency: 'AUD' }, refunded_money: { amount: 50, currency: 'AUD' } });
    expect(seen).toEqual([['org-1', 'gateway-payment'], ['org-1', 'refund']]);
  });
});

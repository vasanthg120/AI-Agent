import { of } from 'rxjs';
import { mapSquarePaymentStatus, SquarePaymentMatchingService } from './square-payment-matching.service';

// Pure unit tests against hand-rolled mocks (HttpService + the Mongoose
// model) — no real network calls, no real Mongo. Covers the status mapping
// (confirmed live against Square's real 5-value Payment.status enum — see
// this file's own comment) and the idempotent-upsert/customer-matching
// behavior the approved plan's test list calls for.
describe('mapSquarePaymentStatus', () => {
  it('maps COMPLETED with no refund to completed', () => {
    expect(mapSquarePaymentStatus({ id: 'p1', status: 'COMPLETED', amount_money: { amount: 1000 } })).toBe('completed');
  });

  it('maps COMPLETED with a partial refund to partially_refunded', () => {
    expect(mapSquarePaymentStatus({ id: 'p1', status: 'COMPLETED', amount_money: { amount: 1000 }, refunded_money: { amount: 300 } })).toBe('partially_refunded');
  });

  it('maps COMPLETED with a full refund to refunded', () => {
    expect(mapSquarePaymentStatus({ id: 'p1', status: 'COMPLETED', amount_money: { amount: 1000 }, refunded_money: { amount: 1000 } })).toBe('refunded');
  });

  it('maps APPROVED to authorized (funds held, not yet captured) — never "completed"', () => {
    expect(mapSquarePaymentStatus({ id: 'p1', status: 'APPROVED', amount_money: { amount: 1000 } })).toBe('authorized');
  });

  it('maps PENDING to pending — never counted as revenue downstream', () => {
    expect(mapSquarePaymentStatus({ id: 'p1', status: 'PENDING', amount_money: { amount: 1000 } })).toBe('pending');
  });

  it('maps CANCELED to cancelled and FAILED to failed', () => {
    expect(mapSquarePaymentStatus({ id: 'p1', status: 'CANCELED', amount_money: { amount: 1000 } })).toBe('cancelled');
    expect(mapSquarePaymentStatus({ id: 'p1', status: 'FAILED', amount_money: { amount: 1000 } })).toBe('failed');
  });
});

describe('SquarePaymentMatchingService', () => {
  // findOne's chain (sort -> select -> lean) returns `reused` — null by
  // default, meaning "nothing on file yet for this providerCustomerId, go
  // fetch it fresh" (every pre-existing test here exercises that path).
  function build(overrides: { get?: jest.Mock; reused?: Record<string, unknown> | null } = {}) {
    const get = overrides.get ?? jest.fn().mockReturnValue(of({ data: { customer: {} } }));
    const http = { get };
    const updateOne = jest.fn().mockResolvedValue(undefined);
    const lean = jest.fn().mockResolvedValue(overrides.reused ?? null);
    const select = jest.fn().mockReturnValue({ lean });
    const sort = jest.fn().mockReturnValue({ select });
    const findOne = jest.fn().mockReturnValue({ sort });
    const model = { updateOne, findOne };
    const service = new SquarePaymentMatchingService(model as never, http as never);
    return { service, http, updateOne, findOne };
  }

  it('resolves the customer\'s email/phone and stores them as normalized keys, never the raw value', async () => {
    const get = jest.fn().mockReturnValue(of({ data: { customer: { email_address: 'Akash@Example.com', phone_number: '+91 98765 43210' } } }));
    const { service, updateOne } = build({ get });

    await service.upsertFromPayment('org-1', 'token', 'sandbox', { id: 'pay_1', status: 'COMPLETED', customer_id: 'CUST1', amount_money: { amount: 800000, currency: 'INR' } });

    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ organizationId: 'org-1', provider: 'square', providerPaymentId: 'pay_1' });
    expect(update.$set.matchedEmailKey).toBe('akash@example.com');
    expect(update.$set.matchedPhoneKey).toBe('9876543210');
    expect(update.$set.amount).toBe(800000);
    expect(update.$set.paymentStatus).toBe('completed');
  });

  it('never discards a payment with no customer_id — stored unmatched instead', async () => {
    const get = jest.fn();
    const { service, updateOne } = build({ get });

    await service.upsertFromPayment('org-1', 'token', 'sandbox', { id: 'pay_2', status: 'COMPLETED', amount_money: { amount: 500, currency: 'USD' } });

    expect(get).not.toHaveBeenCalled();
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.matchedEmailKey).toBeUndefined();
    expect(update.$set.matchedPhoneKey).toBeUndefined();
    expect(update.$set.providerPaymentId).toBe('pay_2');
  });

  it('is idempotent: upserting the same payment twice targets the SAME filter both times, never creating a duplicate', async () => {
    const { service, updateOne } = build();

    await service.upsertFromPayment('org-1', 'token', 'sandbox', { id: 'pay_3', status: 'PENDING', amount_money: { amount: 100, currency: 'USD' } });
    await service.upsertFromPayment('org-1', 'token', 'sandbox', { id: 'pay_3', status: 'COMPLETED', amount_money: { amount: 100, currency: 'USD' } });

    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne.mock.calls[0][0]).toEqual(updateOne.mock.calls[1][0]);
    // The second call must still be {upsert: true} (not a plain update that
    // would fail silently if the first write somehow hadn't landed).
    expect(updateOne.mock.calls[1][2]).toEqual({ upsert: true });
  });

  it('never blocks storing the payment when the customer lookup itself fails', async () => {
    const get = jest.fn().mockImplementation(() => {
      throw new Error('network error');
    });
    const { service, updateOne } = build({ get });

    await service.upsertFromPayment('org-1', 'token', 'sandbox', { id: 'pay_4', status: 'COMPLETED', customer_id: 'CUST1', amount_money: { amount: 100, currency: 'USD' } });

    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it('reuses an already-resolved providerCustomerId mapping instead of calling Square\'s Customers API again', async () => {
    const get = jest.fn().mockReturnValue(of({ data: { customer: { email_address: 'should-not-be-used@example.com' } } }));
    const { service, updateOne, findOne } = build({ get, reused: { matchedEmailKey: 'akash@example.com', matchedPhoneKey: undefined } });

    await service.upsertFromPayment('org-1', 'token', 'sandbox', { id: 'pay_5', status: 'COMPLETED', customer_id: 'CUST1', amount_money: { amount: 100, currency: 'USD' } });

    expect(get).not.toHaveBeenCalled();
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', provider: 'square', providerCustomerId: 'CUST1' }));
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.matchedEmailKey).toBe('akash@example.com');
  });

  it('falls through to a fresh Customers API lookup when nothing has resolved this providerCustomerId before', async () => {
    const get = jest.fn().mockReturnValue(of({ data: { customer: { email_address: 'fresh@example.com' } } }));
    const { service, updateOne } = build({ get, reused: null });

    await service.upsertFromPayment('org-1', 'token', 'sandbox', { id: 'pay_6', status: 'COMPLETED', customer_id: 'CUST2', amount_money: { amount: 100, currency: 'USD' } });

    expect(get).toHaveBeenCalledTimes(1);
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.matchedEmailKey).toBe('fresh@example.com');
  });
});

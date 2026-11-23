import { computeNet, extractSquarePaymentDetails, safeReceiptUrl } from './square-payment-details';
import { computeGatewayPaymentSummary, GatewayPaymentRecord, linkGatewayPayment } from '../customer-intelligence/customer-directory.service';

const full = {
  id: 'p1',
  updated_at: '2026-01-02T00:00:00Z',
  total_money: { amount: 1000, currency: 'aud' },
  approved_money: { amount: 1000, currency: 'AUD' },
  refunded_money: { amount: 200, currency: 'AUD' },
  source_type: 'CARD',
  card_details: {
    status: 'CAPTURED',
    entry_method: 'KEYED',
    card: { card_brand: 'VISA', last_4: '1111', card_type: 'DEBIT', fingerprint: 'sq-1-SECRET', bin: '411111' },
    cvv_status: 'CVV_ACCEPTED',
    auth_result_code: 'AUTH123',
    card_payment_timeline: { authorized_at: 'a', captured_at: 'c' },
  },
  processing_fee: [{ effective_at: 'e', type: 'INITIAL', amount_money: { amount: 50, currency: 'AUD' } }],
  location_id: 'L1', order_id: 'O1', customer_id: 'C1', reference_id: 'Q-100', team_member_id: 'T1',
  receipt_number: 'abcd', receipt_url: 'https://squareup.com/receipt/preview/abcd', note: 'hello',
  application_details: { square_product: 'VIRTUAL_TERMINAL' }, refund_ids: ['r1'],
};

describe('extractSquarePaymentDetails', () => {
  it('maps general, card, fee, reference and receipt fields', () => {
    const d = extractSquarePaymentDetails(full);
    expect(d).toMatchObject({
      totalMoney: { amount: 1000, currency: 'AUD' },
      refundedMoney: { amount: 200, currency: 'AUD' },
      card: { brand: 'VISA', last4: '1111', cardType: 'DEBIT', entryMethod: 'KEYED', status: 'CAPTURED' },
      processingFees: [{ type: 'INITIAL', amount: 50, currency: 'AUD' }],
      orderId: 'O1', customerId: 'C1', locationId: 'L1', referenceId: 'Q-100', teamMemberId: 'T1',
      receiptNumber: 'abcd', productName: 'VIRTUAL_TERMINAL', authorizedAt: 'a', capturedAt: 'c', refundIds: ['r1'],
    });
  });

  it('never carries fingerprint, BIN, CVV or auth codes', () => {
    const json = JSON.stringify(extractSquarePaymentDetails(full));
    for (const secret of ['SECRET', '411111', 'CVV', 'AUTH123', 'fingerprint']) expect(json).not.toContain(secret);
  });

  it('omits everything Square did not send', () => {
    expect(extractSquarePaymentDetails({ id: 'p2' })).toEqual({});
  });
});

describe('safeReceiptUrl', () => {
  it('keeps Square https receipts only', () => {
    expect(safeReceiptUrl('https://squareup.com/receipt/preview/x')).toBeDefined();
    expect(safeReceiptUrl('https://squareupsandbox.com/receipt/x')).toBeDefined();
    expect(safeReceiptUrl('http://squareup.com/r')).toBeUndefined();
    expect(safeReceiptUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeReceiptUrl('https://evilsquareup.com/r')).toBeUndefined();
    expect(safeReceiptUrl(undefined)).toBeUndefined();
  });
});

describe('computeNet', () => {
  it('subtracts fees in the same currency', () => {
    expect(computeNet(1000, 'AUD', [{ amount: 30, currency: 'AUD' }, { amount: 20, currency: 'aud' }])).toEqual({ feeTotal: 50, net: 950 });
  });
  it('refuses to mix currencies and returns null without fees', () => {
    expect(computeNet(1000, 'AUD', [{ amount: 30, currency: 'USD' }])).toBeNull();
    expect(computeNet(1000, 'AUD', undefined)).toBeNull();
  });
});

describe('linkGatewayPayment', () => {
  const docs = {
    quotes: [{ id: 'q1', number: 'Q-100' }],
    invoices: [{ id: 'i1', number: 'INV-7' }],
    jobs: [{ id: 'j1', number: 'J-9', quotationId: 'q1' }],
  };
  it('links by exact reference only, plus the quote\'s job', () => {
    expect(linkGatewayPayment('q-100', docs)).toEqual({ quote: docs.quotes[0], job: { id: 'j1', number: 'J-9' } });
    expect(linkGatewayPayment('INV-7', docs)).toEqual({ invoice: docs.invoices[0] });
  });
  it('never guesses: no or unknown reference links nothing', () => {
    expect(linkGatewayPayment(undefined, docs)).toEqual({});
    expect(linkGatewayPayment('Q-1', docs)).toEqual({});
  });
});

describe('computeGatewayPaymentSummary currency totals', () => {
  const rec = (id: string, amount: number, currency: string, day: number, refundedAmount = 0, status: GatewayPaymentRecord['status'] = 'completed'): GatewayPaymentRecord =>
    ({ id, provider: 'square', amount, currency, status, date: new Date(2026, 0, day), refundedAmount });
  it('keeps each currency separate and handles refunds', () => {
    const s = computeGatewayPaymentSummary([rec('a', 1000, 'AUD', 1, 200), rec('b', 500, 'USD', 2), rec('c', 300, 'AUD', 3, 0, 'failed')]);
    expect(s.currencyTotals).toEqual(
      expect.arrayContaining([
        { currency: 'AUD', totalPaid: 1000, totalRefunded: 200, netPaid: 800, count: 2 },
        { currency: 'USD', totalPaid: 500, totalRefunded: 0, netPaid: 500, count: 1 },
      ]),
    );
    expect(s.currency).toBe('AUD'); // newest payment is the failed AUD one; USD is never folded in
  });
});

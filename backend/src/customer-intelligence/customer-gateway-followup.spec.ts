import { computeGatewayPaymentSummary, crmFollowUpStep, gatewayPaidOnInvoice, GatewayPaymentRecord } from './customer-directory.service';
import { buildCustomerProfile, ProfileInput } from './customer-profile.builder';

const NOW = new Date('2026-10-10T12:00:00Z');
const base = (over: Partial<ProfileInput> = {}): ProfileInput => ({
  now: NOW,
  currency: 'AUD',
  paymentsTracked: false,
  enquiries: [],
  deals: [],
  quotations: [],
  invoices: [],
  payments: [],
  email: { hasAddress: true, received: 0, sent: 0, unanswered: 0 },
  ...over,
});
const tx = (over: Partial<GatewayPaymentRecord> = {}): GatewayPaymentRecord => ({
  id: 'p1',
  provider: 'square',
  amount: 95910,
  currency: 'AUD',
  status: 'completed',
  date: new Date('2026-10-01'),
  refundedAmount: 0,
  transactionReference: 'INV-0052',
  ...over,
});
const invoice = (gatewayPaid?: number) => ({ id: 'i1', number: 'INV-0052', date: new Date('2026-09-30'), value: 959.1, status: 'invoiced' as const, gatewayPaid });

describe('gatewayPaidOnInvoice', () => {
  it('counts a completed payment whose reference is exactly the invoice number', () => {
    expect(gatewayPaidOnInvoice('INV-0052', 'AUD', [tx()])).toBe(959.1);
    expect(gatewayPaidOnInvoice('inv-0052 ', 'AUD', [tx()])).toBe(959.1);
  });
  it('never infers a payment from an amount match alone', () => {
    expect(gatewayPaidOnInvoice('INV-0052', 'AUD', [tx({ transactionReference: undefined })])).toBe(0);
    expect(gatewayPaidOnInvoice('INV-0052', 'AUD', [tx({ transactionReference: 'INV-0053' })])).toBe(0);
    expect(gatewayPaidOnInvoice(undefined, 'AUD', [tx()])).toBe(0);
  });
  it('supports partial and multiple payments, and ignores pending/failed ones', () => {
    const rows = [tx({ id: 'a', amount: 40000 }), tx({ id: 'b', amount: 20000 }), tx({ id: 'c', status: 'pending' }), tx({ id: 'd', status: 'failed' })];
    expect(gatewayPaidOnInvoice('INV-0052', 'AUD', rows)).toBe(600);
  });
  it('nets refunds off', () => {
    expect(gatewayPaidOnInvoice('INV-0052', 'AUD', [tx({ status: 'partially_refunded', refundedAmount: 10000 })])).toBe(859.1);
    expect(gatewayPaidOnInvoice('INV-0052', 'AUD', [tx({ status: 'refunded', refundedAmount: 95910 })])).toBe(0);
  });
  it('keeps currencies apart', () => {
    expect(gatewayPaidOnInvoice('INV-0052', 'AUD', [tx({ currency: 'USD' })])).toBe(0);
  });
  it('a duplicated record of the same payment id is not double counted by the customer join (de-duped by id upstream)', () => {
    const unique = [...new Map([tx(), tx()].map((r) => [r.id, r])).values()];
    expect(gatewayPaidOnInvoice('INV-0052', 'AUD', unique)).toBe(959.1);
  });
});

describe('invoice payment summary with a matched gateway payment', () => {
  it('without any payment record stays Not recorded', () => {
    const p = buildCustomerProfile(base({ invoices: [invoice()] }));
    expect(p.payment).toMatchObject({ status: 'not_recorded', paid: null, outstanding: null });
    expect(p.invoiceList[0]).toMatchObject({ paid: null, outstanding: null });
  });
  it('a matched Square payment is reflected as paid, with no outstanding', () => {
    const p = buildCustomerProfile(base({ invoices: [invoice(959.1)] }));
    expect(p.payment).toMatchObject({ status: 'paid', paid: 959.1, outstanding: 0 });
    expect(p.invoiceList[0]).toMatchObject({ paid: 959.1, outstanding: 0 });
  });
  it('a partial payment leaves the balance outstanding', () => {
    const p = buildCustomerProfile(base({ invoices: [invoice(400)] }));
    expect(p.payment.status).toBe('partially_paid');
    expect(p.invoiceList[0].outstanding).toBeCloseTo(559.1);
  });
});

describe('gateway payment summary — provider is the source, never a status', () => {
  it('names Square as provider while the transaction status stays Paid', () => {
    const s = computeGatewayPaymentSummary([tx()]);
    expect(s.providers).toEqual(['Square']);
    expect(s.status).toBe('paid');
  });
  it('keeps an unrecognised source (e.g. Remittance) as recorded', () => {
    expect(computeGatewayPaymentSummary([tx({ provider: 'Remittance' })]).providers).toEqual(['Remittance']);
  });
  it('does not add across currencies', () => {
    const s = computeGatewayPaymentSummary([tx({ id: 'a', date: new Date('2026-10-02') }), tx({ id: 'b', currency: 'USD', amount: 5000, date: new Date('2026-10-01') })]);
    expect(s).toMatchObject({ currency: 'AUD', netPaid: 95910, transactionCount: 2 });
  });
});

describe('crmFollowUpStep (Hoops status → follow-up step)', () => {
  it('reads numbered follow-up steps in any casing', () => {
    expect(crmFollowUpStep('FOLLOW UP 1')).toEqual({ step: 'FOLLOW UP 1', number: 1 });
    expect(crmFollowUpStep('Follow up 3')).toEqual({ step: 'Follow up 3', number: 3 });
    expect(crmFollowUpStep('follow-up 2')).toMatchObject({ number: 2 });
  });
  it('does not turn other statuses or missing data into follow-ups', () => {
    for (const v of ['SENT', 'ON HOLD', 'Provide Samples!', 'Follow up with Bob', '', undefined, null, 5]) expect(crmFollowUpStep(v)).toBeNull();
  });
});

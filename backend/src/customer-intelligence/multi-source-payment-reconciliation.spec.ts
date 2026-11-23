import { crmPaymentTexts, GatewayPaymentRecord, linkGatewayPayment } from './customer-directory.service';
import { readCrmPaymentReport } from './crm-payment-report';
import { QuotePaymentInput, summarizeQuotePayment } from './quote-payment-status';

// The pure multi-source calculation every screen reads: Hoops (a CRM report) never overrides a verified payment, and
// is never silently discarded either; the same money is never counted twice, two genuine payments never collapse.
const docs = { quotes: [{ id: 'q4550', number: '4550' }, { id: 'q4551', number: '4551' }], invoices: [], jobs: [] };
const pay = (o: Partial<GatewayPaymentRecord> = {}): GatewayPaymentRecord => ({
  id: 'p1', provider: 'square', amount: 100000, currency: 'AUD', status: 'completed', date: new Date('2026-11-18T10:00:00Z'), refundedAmount: 0, paymentMethodType: 'CARD',
  details: { squareInvoiceNumber: '4550 - Customer', squareInvoiceTitle: '4550 - Customer' }, ...o,
});
const linked = (r: GatewayPaymentRecord) => ({ ...r, links: { crmSources: [], ...linkGatewayPayment(r, docs) } }) as QuotePaymentInput;
const run = (
  o: { payments?: GatewayPaymentRecord[]; crm?: string[]; recorded?: { id: string; amount: number; date: Date; method?: string; reference?: string }[]; recordedPaid?: number; total?: number; currency?: string; crmChangedAt?: Date } = {},
) =>
  summarizeQuotePayment({
    quoteId: 'q4550', quoteNumber: '4550', quoteTotal: o.total ?? 1000, currency: o.currency ?? 'AUD',
    gatewayPayments: (o.payments ?? []).map(linked), recordedPayments: o.recorded, recordedPaid: o.recordedPaid,
    crmReport: readCrmPaymentReport(o.crm ?? []), crmSource: 'Hoops', crmChangedAt: o.crmChangedAt,
  });

describe('Hoops vs verified payments', () => {
  it('Hoops says Not Paid but Square confirms the full amount → PAID, and the CRM is flagged out of date', () => {
    const s = run({ crm: ['Not Paid'], payments: [pay({ amount: 100000 })] });
    expect(s).toMatchObject({ status: 'paid', paidAmount: 1000, outstandingAmount: 0, basis: 'verified', crmOutdated: true, gateway: 'Square' });
    expect(s.sources).toEqual([{ name: 'Square', verified: true }]);
  });
  it('Hoops says 50% Paid and Square pays the remaining 50% → PAID', () => {
    // Hoops last changed before the Square payment was made → the payment is new money Hoops has not seen.
    const s = run({ crm: ['50% Paid'], payments: [pay({ amount: 50000 })], crmChangedAt: new Date('2026-11-01') });
    expect(s).toMatchObject({ status: 'paid', paidAmount: 1000, verifiedPaid: 500, reportedPaid: 500, basis: 'mixed' });
    expect(s.sources.map((x) => x.name)).toEqual(['Square', 'Hoops']);
    expect(s.sources[1].verified).toBe(false);
  });
  it('Hoops says 50% Paid and Square shows the same 50% with no sign it is newer → one payment, partially paid (never overstated)', () =>
    expect(run({ crm: ['50% Paid'], payments: [pay({ amount: 50000 })] })).toMatchObject({ status: 'partially_paid', paidAmount: 500 }));
  it('Hoops says 50% Paid and Square pays a different amount that is not the remainder, non-complementary amount → the larger, never the sum', () =>
    expect(run({ crm: ['50% Paid'], payments: [pay({ amount: 70000 })] }).paidAmount).toBe(700));
  it('Hoops says Paid but no verifiable transaction → Paid, preserved as source-reported and flagged unverified', () => {
    const s = run({ crm: ['Paid'] });
    expect(s).toMatchObject({ status: 'paid', basis: 'reported', verifiedPaid: 0, reportedPaid: 1000, crmUnverified: true });
    expect(s.sources).toEqual([{ name: 'Hoops', verified: false }]);
  });
  it('"Paid In square" with no Square transaction is NOT proof: reported, with Square only as an unverified hint', () => {
    const s = run({ crm: ['Paid In square'] });
    expect(s.basis).toBe('reported');
    expect(s.sources).toEqual([{ name: 'Hoops', verified: false }, { name: 'Square', verified: false }]);
    expect(s.transactionIds).toEqual([]);
  });
  it('Hoops Not Paid with nothing verified stays Unpaid', () => expect(run({ crm: ['Not Paid'] })).toMatchObject({ status: 'unpaid', paidAmount: 0, basis: 'none' }));
  it('Square with no CRM word at all still pays the quote', () => expect(run({ payments: [pay()] }).status).toBe('paid'));
});

describe('remittance', () => {
  it('a recorded remittance payment counts, labelled Remittance (not a gateway)', () => {
    const s = run({ recorded: [{ id: 'r1', amount: 1000, date: new Date('2026-11-10'), method: 'Remittance' }], recordedPaid: 1000 });
    expect(s).toMatchObject({ status: 'paid', basis: 'verified' });
    expect(s.gateway).toBeUndefined();
    expect(s.sources).toEqual([{ name: 'Remittance', verified: true }]);
  });
  it('Hoops "Remittance" alone is only a method: no amount is invented, nothing is assumed paid', () => {
    const s = run({ crm: ['Remittance'] });
    expect(s).toMatchObject({ status: 'unpaid', paidAmount: 0 });
    expect(s.crmReported?.methods).toEqual(['Remittance']);
  });
  it('Hoops "Paid" + method Remittance and no record → reported, source shown as Remittance (unverified)', () => {
    const s = run({ crm: ['Paid', 'Remittance'] });
    expect(s.sources).toEqual([{ name: 'Remittance', verified: false }]);
  });
});

describe('duplicates and genuine separate payments', () => {
  it('a recorded payment that carries the Square payment id is the same money — counted once', () => {
    const s = run({ payments: [pay({ id: 'sq_1', amount: 100000 })], recorded: [{ id: 'r1', amount: 1000, date: new Date('2026-12-30'), reference: 'sq_1' }], recordedPaid: 1000 });
    expect(s.paidAmount).toBe(1000);
    expect(s.transactions.find((t) => t.id === 'r1')).toMatchObject({ counted: false, duplicateOf: 'sq_1' });
  });
  it('a recorded payment of the same amount on the same day (both tied to the quote) is the same money', () => {
    const s = run({ payments: [pay({ amount: 40000 })], recorded: [{ id: 'r1', amount: 400, date: new Date('2026-11-19T01:00:00Z') }], recordedPaid: 400 });
    expect(s.paidAmount).toBe(400);
  });
  it('two genuine payments (different amounts/dates) from two sources add up', () => {
    const s = run({ payments: [pay({ amount: 40000 })], recorded: [{ id: 'r1', amount: 600, date: new Date('2026-10-01'), method: 'Remittance' }], recordedPaid: 600 });
    expect(s).toMatchObject({ paidAmount: 1000, status: 'paid' });
    expect(s.sources.map((x) => x.name)).toEqual(['Square', 'Remittance']);
  });
  it('two equal Square payments on different days are NOT collapsed', () =>
    expect(run({ payments: [pay({ id: 'a', amount: 30000 }), pay({ id: 'b', amount: 30000, date: new Date('2026-11-25') })] }).paidAmount).toBe(600));
  it('the same payment arriving by webhook, sync and reconciliation counts once', () => expect(run({ payments: [pay(), pay(), pay()] }).paidAmount).toBe(1000));
  it('two payments of the same amount recorded the same day are both kept (itemized records are separate)', () =>
    expect(run({ recorded: [{ id: 'a', amount: 300, date: new Date('2026-11-10') }, { id: 'b', amount: 300, date: new Date('2026-11-10') }], recordedPaid: 600 }).paidAmount).toBe(600));
});

describe('refunds, partial and overpayment, currencies, providers', () => {
  it('a partial refund reduces what is paid and shows refund info', () => {
    const s = run({ payments: [pay({ status: 'partially_refunded', refundedAmount: 20000 })] });
    expect(s).toMatchObject({ status: 'partially_paid', paidAmount: 800, refundedAmount: 200, outstandingAmount: 200 });
  });
  it('a full refund brings the quote back to unpaid', () => expect(run({ payments: [pay({ status: 'refunded', refundedAmount: 100000 })] }).status).toBe('unpaid'));
  it('partial payment', () => expect(run({ payments: [pay({ amount: 25000 })] })).toMatchObject({ status: 'partially_paid', outstandingAmount: 750 }));
  it('multiple transactions', () => expect(run({ payments: [pay({ id: 'a', amount: 25000 }), pay({ id: 'b', amount: 75000, date: new Date('2026-11-20') })] }).status).toBe('paid'));
  it('overpaid', () => expect(run({ payments: [pay({ amount: 120000 })] })).toMatchObject({ status: 'overpaid', outstandingAmount: 0 }));
  it('currencies are never combined', () => {
    expect(run({ payments: [pay({ currency: 'USD' })] }).status).toBe('unpaid');
    expect(run({ payments: [pay({ id: 'a', amount: 50000 }), pay({ id: 'b', amount: 50000, currency: 'USD' })] }).paidAmount).toBe(500);
  });
  it('multiple providers are all named', () =>
    expect(run({ payments: [pay({ id: 's', amount: 50000 }), pay({ id: 't', amount: 50000, provider: 'stripe', date: new Date('2026-11-21') })] }).gateway).toBe('Square, Stripe'));
  it('pending / failed / cancelled / authorized never count', () =>
    expect(run({ payments: ['pending', 'failed', 'cancelled', 'authorized'].map((status, i) => pay({ id: `x${i}`, status: status as never })) }).status).toBe('unpaid'));
});

describe('quote-number matching is exact and never by amount', () => {
  it('a payment for quote 4551 never settles 4550', () => expect(run({ payments: [pay({ details: { squareInvoiceNumber: '4551 - Other' } })] }).status).toBe('unpaid'));
  it('an unmatched quote number links to nothing', () => expect(linkGatewayPayment(pay({ details: { squareInvoiceNumber: '9999 - X' } }), docs)).toEqual({}));
  it('an amount equal to the quote total, with no identifier, links to nothing', () => expect(linkGatewayPayment(pay({ amount: 100000, details: {} }), docs)).toEqual({}));
  it('a quote number shared by two quotes is ambiguous and links to neither', () =>
    expect(linkGatewayPayment(pay(), { ...docs, quotes: [...docs.quotes, { id: 'qdup', number: '4550' }] }).quote).toBeUndefined());
});

describe('finding the CRM payment words', () => {
  it('reads status labels, the Hoops status and any payment-named string field — by name, no hardcoded provider field', () => {
    const texts = crmPaymentTexts({ paymentStatus: 'Not Paid', quoteStatus: 'approved' }, { sourceData: { status: 'Paid In square', payment_method: 'Remittance', unrelated: 'x', summary: { paymentStatus: '50% Paid' } } });
    expect(texts).toEqual(expect.arrayContaining(['Not Paid', 'Paid In square', 'Remittance', '50% Paid']));
    expect(texts).not.toContain('x');
  });
});

import { GatewayPaymentRecord, invoiceIdentifier, linkGatewayPayment } from './customer-directory.service';
import { buildCustomerProfile } from './customer-profile.builder';
import { quotePaymentStatus, QuotePaymentInput, summarizeQuotePayment } from './quote-payment-status';

const docs = {
  quotes: [
    { id: 'q1', number: '4546' },
    { id: 'q2', number: '4547' },
  ],
  invoices: [{ id: 'i1', number: 'INV-0056', quotationId: 'q1' }],
  jobs: [{ id: 'j1', number: 'JOB-12', quotationId: 'q2' }],
};
const pay = (o: Partial<GatewayPaymentRecord> = {}): GatewayPaymentRecord => ({
  id: 'p1', provider: 'square', amount: 36850, currency: 'AUD', status: 'completed', date: new Date('2026-11-18'), refundedAmount: 0, paymentMethodType: 'CARD', ...o,
});
const withInvoice = (title: string, o: Partial<GatewayPaymentRecord> = {}) => pay({ details: { squareInvoiceNumber: title, squareInvoiceTitle: title }, ...o });
const linked = (r: GatewayPaymentRecord) => ({ ...r, links: { crmSources: [], ...linkGatewayPayment(r, docs) } }) as QuotePaymentInput;
const sum = (payments: GatewayPaymentRecord[], total = 368.5, extra: { recordedPaid?: number; currency?: string } = {}) =>
  summarizeQuotePayment({ quoteId: 'q1', quoteNumber: '4546', quoteTotal: total, currency: extra.currency ?? 'AUD', gatewayPayments: payments.map(linked), recordedPaid: extra.recordedPaid });
const ref = (o: Partial<GatewayPaymentRecord> = {}) => withInvoice('4546 - Surry Hills', o);

describe('Mark Coles: Square Invoice "4546 - Surry Hills" settles quote 4546', () => {
  it('links through the Square invoice number (payment has no reference_id) and shows Paid', () => {
    const s = sum([ref()]);
    expect(s).toMatchObject({ status: 'paid', paidAmount: 368.5, outstandingAmount: 0, gateway: 'Square', paymentMethod: 'CARD', quoteNumber: '4546' });
    expect(linkGatewayPayment(ref(), docs)).toMatchObject({ quote: { id: 'q1' }, invoice: { id: 'i1' } });
  });
  it('the profile (customer summary, order, invoice) agrees with the quote status', () => {
    const now = new Date('2026-11-20');
    const quote = { id: 'q1', number: '4546', date: now, amount: 368.5, paidAmount: 0, gatewayPaid: sum([ref()]).paidAmount, state: 'accepted' };
    const profile = buildCustomerProfile({
      now, currency: 'AUD', paymentsTracked: false, enquiries: [], deals: [], payments: [], followUps: [], overrides: {},
      quotations: [quote as never], invoices: [{ id: 'i1', number: 'INV-0056', date: now, value: 368.5, status: 'draft', quotationId: 'q1' } as never],
      email: { received: 0, sent: 0, unanswered: 0, hasAddress: true } as never,
    } as never);
    expect(profile.payment).toMatchObject({ status: 'paid', paid: 368.5, outstanding: 0 });
    expect(profile.invoiceList[0]).toMatchObject({ paid: 368.5, outstanding: 0 });
  });
});

describe('invoiceIdentifier', () => {
  it('reads the leading document number only', () => {
    expect(invoiceIdentifier('4546 - Surry Hills')).toBe('4546');
    expect(invoiceIdentifier('INV-0056')).toBe('inv-0056');
    expect(invoiceIdentifier('Surry Hills 4546')).toBeUndefined();
    expect(invoiceIdentifier('Quote 4536')).toBe('4536');
    expect(invoiceIdentifier('Quote - 4530 - SURRYHILLS')).toBe('4530');
    expect(invoiceIdentifier('Quote #4512 - SURRY HILLS')).toBe('4512');
    expect(invoiceIdentifier('Quote')).toBe('quote'); // harmless: no quote is numbered "quote"
    expect(invoiceIdentifier('Delivery charge')).toBeUndefined();
  });
});

describe('status rules', () => {
  it('unpaid when nothing was paid', () => expect(sum([])).toMatchObject({ status: 'unpaid', paidAmount: 0, outstandingAmount: 368.5 }));
  it('partial payment', () => expect(sum([ref({ amount: 10000 })])).toMatchObject({ status: 'partially_paid', paidAmount: 100, outstandingAmount: 268.5 }));
  it('multiple Square transactions add up', () =>
    expect(sum([ref({ id: 'a', amount: 10000 }), ref({ id: 'b', amount: 26850 })])).toMatchObject({ status: 'paid', paidAmount: 368.5, transactionIds: ['a', 'b'] }));
  it('refund reduces paid and recalculates (never stays Paid)', () => {
    expect(sum([ref({ status: 'partially_refunded', refundedAmount: 10000 })])).toMatchObject({ status: 'partially_paid', paidAmount: 268.5 });
    expect(sum([ref({ status: 'refunded', refundedAmount: 36850 })])).toMatchObject({ status: 'unpaid', paidAmount: 0 });
  });
  it('overpayment', () => expect(sum([ref({ amount: 40000 })])).toMatchObject({ status: 'overpaid', paidAmount: 400, outstandingAmount: 0 }));
  it('failed, cancelled, pending and authorized never count', () =>
    expect(sum(['failed', 'cancelled', 'pending', 'authorized'].map((status, i) => ref({ id: `x${i}`, status: status as never }))).status).toBe('unpaid'));
  it('quotePaymentStatus boundaries', () => {
    expect(quotePaymentStatus(0, 100)).toBe('unpaid');
    expect(quotePaymentStatus(100, 100)).toBe('paid');
    expect(quotePaymentStatus(100.01, 100)).toBe('overpaid');
    expect(quotePaymentStatus(99.99, 100)).toBe('partially_paid');
  });
});

describe('linking only by identifier', () => {
  it('quote number as reference_id', () => expect(sum([pay({ transactionReference: '4546' })]).status).toBe('paid'));
  it('through an invoice reference', () => expect(sum([pay({ transactionReference: 'INV-0056' })]).status).toBe('paid'));
  it('through an invoice number in the note', () => expect(sum([pay({ details: { note: 'Payment for INV-0056' } })]).status).toBe('paid'));
  it('through a job number (job converted from the quote)', () => {
    expect(linkGatewayPayment(pay({ transactionReference: 'JOB-12' }), docs).quote?.id).toBe('q2');
    expect(linkGatewayPayment(pay({ transactionReference: 'JOB-12' }), docs).job?.id).toBe('j1');
  });
  it('exact quote number only: 45466 / 4546x never match 4546', () => {
    expect(linkGatewayPayment(withInvoice('45466 - Surry Hills'), docs).quote).toBeUndefined();
    expect(linkGatewayPayment(pay({ transactionReference: '4546x' }), docs).quote).toBeUndefined();
  });
  it('an unreferenced payment stays unmatched even when the amount equals the quote', () => {
    expect(linkGatewayPayment(pay({ amount: 36850 }), docs)).toEqual({});
    expect(sum([pay({ amount: 36850 })]).status).toBe('unpaid');
  });
  it('a payment for another quote never updates this one', () => expect(sum([withInvoice('4547 - Surry Hills')]).status).toBe('unpaid'));
  it('a number shared by two quotes is ambiguous and links to neither', () => {
    const dup = { ...docs, quotes: [...docs.quotes, { id: 'q9', number: '4546' }] };
    expect(linkGatewayPayment(ref(), dup).quote).toBeUndefined();
  });
});

describe('duplicates and currencies', () => {
  it('the same provider payment id (webhook + sync + reconciliation) counts once', () => expect(sum([ref(), ref(), ref()]).paidAmount).toBe(368.5));
  it('Hoops and Square describing the same money are not added together', () => expect(sum([ref()], 368.5, { recordedPaid: 368.5 })).toMatchObject({ status: 'paid', paidAmount: 368.5 }));
  it('a Hoops-recorded payment alone still shows (no gateway)', () => expect(sum([], 368.5, { recordedPaid: 100 })).toMatchObject({ status: 'partially_paid', paidAmount: 100 }));
  it('different currencies are never combined', () => {
    expect(sum([ref({ currency: 'USD' })]).status).toBe('unpaid');
    expect(sum([ref({ id: 'a', amount: 20000 }), ref({ id: 'b', amount: 99999, currency: 'USD' })])).toMatchObject({ paidAmount: 200, status: 'partially_paid' });
  });
});

describe('several providers on one quote', () => {
  it('separate genuine payments from two providers add up and both provider names are reported', () =>
    expect(sum([ref({ id: 's1', amount: 20000 }), ref({ id: 'st1', provider: 'stripe', amount: 16850 })])).toMatchObject({ status: 'paid', paidAmount: 368.5, gateway: 'Square, Stripe' }));
  it('an unknown provider keeps its own recorded name (nothing is invented)', () => expect(sum([ref({ id: 'x1', provider: 'xero' })]).gateway).toBe('xero'));
  it('no gateway payment means no gateway name', () => expect(sum([], 368.5, { recordedPaid: 100 }).gateway).toBeUndefined());
  it('Hoops-recorded money larger than the gateway part is not summed with it', () => expect(sum([ref({ amount: 20000 })], 368.5, { recordedPaid: 368.5 }).paidAmount).toBe(368.5));
});

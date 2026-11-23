import { buildCustomerProfile } from './customer-profile.builder';
import { gatewayPaidOnLinkedInvoice, GatewayPaymentRecord, linkGatewayPayment, computeGatewayPaymentSummary } from './customer-directory.service';

const docs = {
  quotes: [{ id: 'q1', number: '4546' }],
  invoices: [{ id: 'i1', number: 'INV-0056', quotationId: 'q1' }],
  jobs: [],
};
const pay = (o: Partial<GatewayPaymentRecord> = {}): GatewayPaymentRecord => ({
  id: 'p1', provider: 'square', amount: 36850, currency: 'AUD', status: 'completed', date: new Date('2026-11-18'), refundedAmount: 0, ...o,
});
const linked = (r: GatewayPaymentRecord): GatewayPaymentRecord => ({ ...r, links: { crmSources: [], ...linkGatewayPayment(r, docs) } });

describe('linking a gateway payment to an invoice', () => {
  it('links on reference_id equal to the invoice number', () => {
    expect(linkGatewayPayment(pay({ transactionReference: 'INV-0056' }), docs).invoice).toEqual({ id: 'i1', number: 'INV-0056' });
  });
  it('links on a document number written in the Square note', () => {
    expect(linkGatewayPayment(pay({ details: { note: 'Payment for INV-0056 thanks' } }), docs).invoice?.id).toBe('i1');
    expect(linkGatewayPayment(pay({ details: { note: 'INV-00561' } }), docs).invoice).toBeUndefined();
  });
  it('links the invoice raised from a quote the payment references', () => {
    expect(linkGatewayPayment(pay({ transactionReference: '4546' }), docs).invoice?.id).toBe('i1');
  });
  it('never links on amount alone (unreferenced payment stays unlinked)', () => {
    expect(linkGatewayPayment(pay({ amount: 36850 }), docs)).toEqual({});
  });
});

describe('gatewayPaidOnLinkedInvoice', () => {
  const ref = (o: Partial<GatewayPaymentRecord>) => linked(pay({ transactionReference: 'INV-0056', ...o }));
  it('full payment settles the invoice', () => expect(gatewayPaidOnLinkedInvoice('i1', 'AUD', [ref({})])).toBe(368.5));
  it('multiple payments add up', () => expect(gatewayPaidOnLinkedInvoice('i1', 'AUD', [ref({ id: 'a', amount: 10000 }), ref({ id: 'b', amount: 26850 })])).toBe(368.5));
  it('a duplicated payment id is counted once', () => expect(gatewayPaidOnLinkedInvoice('i1', 'AUD', [ref({}), ref({})])).toBe(368.5));
  it('refunds reduce what is paid', () => expect(gatewayPaidOnLinkedInvoice('i1', 'AUD', [ref({ status: 'partially_refunded', refundedAmount: 10000 })])).toBe(268.5));
  it('other currencies are never combined', () => expect(gatewayPaidOnLinkedInvoice('i1', 'AUD', [ref({ currency: 'USD' })])).toBe(0));
  it('unlinked, pending and failed payments never mark an invoice paid', () => {
    expect(gatewayPaidOnLinkedInvoice('i1', 'AUD', [linked(pay())])).toBe(0);
    expect(gatewayPaidOnLinkedInvoice('i1', 'AUD', [ref({ status: 'pending' }), ref({ id: 'f', status: 'failed' })])).toBe(0);
  });
  it('a payment linked to another customer\'s invoice is ignored', () => {
    expect(gatewayPaidOnLinkedInvoice('someone-elses', 'AUD', [ref({})])).toBe(0);
  });
});

describe('profile: paid status follows the linked gateway payment', () => {
  const base = (gatewayPaid?: number) => {
    const now = new Date('2026-11-20');
    return buildCustomerProfile({
      now, currency: 'AUD', paymentsTracked: false, enquiries: [], deals: [], payments: [], followUps: [], overrides: {},
      quotations: [{ id: 'q1', number: '4546', date: now, amount: 368.5, paidAmount: 0, state: 'accepted' } as never],
      invoices: [{ id: 'i1', number: 'INV-0056', date: now, value: 368.5, status: 'draft', quotationId: 'q1', gatewayPaid } as never],
      email: { received: 0, sent: 0, unanswered: 0, hasAddress: true } as never,
    } as never);
  };
  it('full payment → Paid, no "Not recorded" warning', () => {
    const p = base(368.5);
    expect(p.payment).toMatchObject({ status: 'paid', paid: 368.5, outstanding: 0 });
    expect(p.gaps.join(' ')).not.toMatch(/No payment is recorded/);
  });
  it('partial payment → Partially paid with the right outstanding', () => {
    expect(base(100).payment).toMatchObject({ status: 'partially_paid', paid: 100, outstanding: 268.5 });
  });
  it('no linked payment → still Not recorded (nothing is invented)', () => {
    expect(base(undefined).payment.status).toBe('not_recorded');
  });
});

describe('summary keeps providers and currencies apart', () => {
  it('names Square and never merges AUD with USD', () => {
    const s = computeGatewayPaymentSummary([pay(), pay({ id: 'u', currency: 'USD', amount: 500, date: new Date('2026-11-19') })]);
    expect(s.providers).toEqual(['Square']);
    expect(s.currencyTotals?.map((t) => t.currency).sort()).toEqual(['AUD', 'USD']);
  });
});

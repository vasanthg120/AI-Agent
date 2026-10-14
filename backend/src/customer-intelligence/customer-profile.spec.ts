import { buildCustomerDocuments } from './customer-documents';
import { clusterCustomers, companyKey, phoneKey } from './customer-matching';
import { buildCustomerProfile, ProfileInput } from './customer-profile.builder';

const NOW = new Date('2026-10-10T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const NO_MAIL = { hasAddress: true, received: 0, sent: 0, unanswered: 0 };

const base = (over: Partial<ProfileInput> = {}): ProfileInput => ({
  now: NOW,
  currency: 'INR',
  paymentsTracked: true,
  enquiries: [],
  deals: [],
  quotations: [],
  invoices: [],
  payments: [],
  email: NO_MAIL,
  ...over,
});

describe('matching records to customers', () => {
  it('joins records by link, email and phone — whatever CRM each came from', () => {
    const groups = clusterCustomers([
      { identity: { name: 'Priya Raman', company: 'Sundar Textiles Pvt Ltd', email: 'Priya@Sundar.example', phone: '+91 98400 12345' } }, // 0 enquiry
      { identity: { company: 'Sundar Textiles', email: 'priya@sundar.example' } }, // 1 quotation, same email in another case
      { identity: {}, links: [1] }, // 2 invoice raised from that quotation
      { identity: { name: 'P Raman', phone: '09840012345' } }, // 3 same phone, written differently
      { identity: { name: 'Arun Kumar', email: 'arun@bluewave.example' } }, // 4 somebody else
    ]);
    expect(groups).toEqual([[0, 1, 2, 3], [4]]);
  });

  it('a company name places a record only when it has nothing better and points at one customer', () => {
    const groups = clusterCustomers([
      { identity: { company: 'Acme Traders', email: 'a@acme.example' } }, // 0
      { identity: { company: 'Acme Traders Pvt. Ltd.' } }, // 1 a deal known only by its title → customer 0
      { identity: { company: 'Globex', email: 'x@globex.example' } }, // 2
      { identity: { company: 'Globex', email: 'y@globex.example' } }, // 3 a second contact at Globex stays separate
      { identity: { company: 'Globex' } }, // 4 could be either → its own entry, not a guess
      { identity: { company: 'Globex' } }, // 5 …shared with the other unplaced Globex record
    ]);
    expect(groups).toEqual([[0, 1], [2], [3], [4, 5]]);
  });

  it('ignores placeholders that identify nobody', () => {
    expect(phoneKey('0000000000')).toBe('');
    expect(phoneKey('12345')).toBe('');
    expect(companyKey('Individual')).toBe('');
    expect(companyKey('NA')).toBe('');
    expect(clusterCustomers([{ identity: { phone: '0000000000', name: 'Asha' } }, { identity: { phone: '0000000000', name: 'Ravi Shankar' } }])).toHaveLength(
      2,
    );
  });
});

describe('customer profile', () => {
  it('a new lead nobody has written to: not converted, contact them', () => {
    const p = buildCustomerProfile(base({ enquiries: [{ id: 'e1', date: daysAgo(5), summary: 'Need 50 safety jackets' }] }));
    expect(p).toMatchObject({
      type: 'new',
      active: true,
      crm: { status: 'lead' },
      orders: { status: 'not_converted', count: 0 },
      payment: { status: 'nothing_due', outstanding: 0 },
      mail: { status: 'not_contacted' },
      flags: ['follow_up_required'],
      nextAction: { urgency: 'overdue', title: 'Contact the customer' },
      comparison: null,
    });
    expect(p.insight).toBe('New lead — enquired 5 days ago. No quotation has been sent for this inquiry yet. Nobody has emailed them yet.');
  });

  it('a returning customer with a quotation out: previous order, quote pending, follow up', () => {
    const p = buildCustomerProfile(
      base({
        enquiries: [{ id: 'e1', date: daysAgo(7), summary: '300 polo shirts' }],
        quotations: [
          { id: 'q1', number: 'Q-1', date: daysAgo(200), amount: 85000, paidAmount: 85000, state: 'accepted' },
          { id: 'q2', number: 'Q-2', date: daysAgo(5), amount: 120000, paidAmount: 0, state: 'sent', expiresAt: daysAgo(-20) },
        ],
        invoices: [{ id: 'i1', number: 'INV-1', date: daysAgo(198), value: 85000, cost: 59500, status: 'paid', quotationId: 'q1' }],
        email: { hasAddress: true, received: 2, sent: 3, unanswered: 0, lastReceivedAt: daysAgo(7), lastSentAt: daysAgo(5) },
      }),
    );
    expect(p).toMatchObject({
      type: 'returning',
      crm: { status: 'customer' },
      // One order, not two: the accepted quotation and its invoice are the same order.
      orders: { status: 'previous_order', count: 1, totalValue: 85000 },
      quotes: { count: 2, openCount: 1, openValue: 120000, latest: { number: 'Q-2', state: 'sent' } },
      invoices: { count: 1, total: 85000, latest: { number: 'INV-1', paid: 85000, outstanding: 0, marginPct: 30 } },
      payment: { status: 'paid', billed: 85000, paid: 85000, outstanding: 0 },
      mail: { status: 'follow_up' },
      nextAction: { urgency: 'today', title: 'Follow up on the quotation' },
    });
    expect(p.flags).toEqual(['follow_up_required', 'quote_pending']);
    expect(p.comparison).toMatchObject({
      previous: { label: 'Invoice INV-1', value: 85000, marginPct: 30 },
      current: { label: 'Quotation Q-2', value: 120000, marginPct: null, isQuotation: true },
      valueDifference: 35000,
      valueDifferencePct: 41.2,
    });
    // The advice is arithmetic on recorded figures: 30% margin on 1,20,000 leaves 84,000 for cost.
    expect(p.comparison!.note).toMatch(/30% margin.*no more than ₹84,000/);
    expect(p.insight).toMatch(/^Returning customer with 1 order worth ₹85,000; enquired again 7 days ago\. Quotation Q-2 for ₹1,20,000 was sent 5 days ago/);
  });

  it('never calls an order unpaid when the organization records no payments at all', () => {
    const input = base({
      paymentsTracked: false,
      quotations: [{ id: 'q1', number: 'Q-1', date: daysAgo(30), amount: 40000, paidAmount: 0, state: 'accepted' }],
      invoices: [{ id: 'i1', number: 'INV-1', date: daysAgo(29), value: 40000, status: 'draft', quotationId: 'q1' }],
    });
    const p = buildCustomerProfile(input);
    expect(p.payment).toEqual({ status: 'not_recorded', label: 'Not recorded', billed: 40000, paid: null, outstanding: null, overdueAmount: 0 });
    expect(p.flags).toEqual([]);
    expect(p.invoiceList[0]).toMatchObject({ paid: null, outstanding: null, cost: null, marginPct: null });
    expect(p.gaps).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/1 invoice is still a draft/),
        expect.stringMatching(/No payment is recorded/),
        expect.stringMatching(/No cost is recorded/),
      ]),
    );
    expect(p.insight).not.toMatch(/unpaid|overdue/);

    // The same records, in an organization that does record payments: now it is a real debt.
    const tracked = buildCustomerProfile({ ...input, paymentsTracked: true });
    expect(tracked.payment).toMatchObject({ status: 'unpaid', outstanding: 40000 });
    expect(tracked.flags).toEqual(['payment_pending']);
  });

  it('part payment, then overdue once the due date has passed', () => {
    const quotation = { id: 'q1', number: 'Q-1', date: daysAgo(40), amount: 50000, paidAmount: 0, state: 'accepted' as const };
    const payments = [{ quotationId: 'q1', amount: 20000, date: daysAgo(30) }];
    const partly = buildCustomerProfile(
      base({
        quotations: [quotation],
        invoices: [{ id: 'i1', number: 'INV-1', date: daysAgo(39), value: 50000, status: 'invoiced', quotationId: 'q1', dueDate: daysAgo(-5) }],
        payments,
      }),
    );
    expect(partly.payment).toMatchObject({ status: 'partially_paid', paid: 20000, outstanding: 30000, overdueAmount: 0 });
    const overdue = buildCustomerProfile(
      base({
        quotations: [quotation],
        invoices: [{ id: 'i1', number: 'INV-1', date: daysAgo(39), value: 50000, status: 'invoiced', quotationId: 'q1', dueDate: daysAgo(9) }],
        payments,
      }),
    );
    expect(overdue.payment).toMatchObject({ status: 'overdue', outstanding: 30000, overdueAmount: 30000 });
    expect(overdue.flags).toEqual(['payment_overdue']);
    expect(overdue.nextAction).toMatchObject({ urgency: 'overdue', title: 'Request payment — overdue' });
    expect(overdue.type).toBe('existing');
  });

  it('an unanswered email comes first; an expired quotation is not pending', () => {
    const p = buildCustomerProfile(
      base({
        quotations: [{ id: 'q1', number: 'Q-9', date: daysAgo(60), amount: 9000, paidAmount: 0, state: 'sent', expiresAt: daysAgo(30) }],
        email: { hasAddress: true, received: 1, sent: 1, unanswered: 1, lastReceivedAt: daysAgo(2), lastSentAt: daysAgo(60), oldestUnansweredAt: daysAgo(2) },
      }),
    );
    expect(p.quotes).toMatchObject({ openCount: 0, latest: { state: 'expired', stateLabel: 'Expired' } });
    expect(p.mail.status).toBe('reply_needed');
    expect(p.flags).toEqual(['reply_needed']);
    expect(p.nextAction).toMatchObject({ urgency: 'overdue', title: 'Reply to the customer' });
    expect(p.crm.status).toBe('opportunity');
  });

  it('flags what disagrees: a deal marked won with nothing behind it, a lost deal with a live quotation', () => {
    const won = buildCustomerProfile(base({ deals: [{ id: 'd1', name: 'Noble Hospital - Uniforms', date: daysAgo(20), value: 60000, status: 'won' }] }));
    expect(won).toMatchObject({
      type: 'existing',
      active: true,
      lastActivity: { label: 'Deal won' },
      crm: { status: 'customer' },
      orders: { count: 1, totalValue: 60000 },
      payment: { status: 'nothing_due' },
    });
    expect(won.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/marked won, but no accepted quotation or invoice/)]));

    const lost = buildCustomerProfile(
      base({
        deals: [{ id: 'd1', date: daysAgo(20), value: 0, status: 'lost' }],
        quotations: [{ id: 'q1', date: daysAgo(2), amount: 5000, paidAmount: 0, state: 'sent', dealId: 'd1' }],
      }),
    );
    expect(lost.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/marked lost, but a quotation is still open/)]));
  });

  it('inactive after three quiet months', () => {
    const p = buildCustomerProfile(base({ quotations: [{ id: 'q1', date: daysAgo(200), amount: 5000, paidAmount: 5000, state: 'accepted' }] }));
    expect(p).toMatchObject({
      active: false,
      daysSinceLastActivity: 200,
      orders: { status: 'converted' },
      mail: { status: 'none' },
      nextAction: { urgency: 'none' },
    });
  });
});

describe('the board: six steps per customer', () => {
  const chips = (p: ReturnType<typeof buildCustomerProfile>) => Object.fromEntries(p.stages.map((s) => [s.key, [s.label, s.tone, s.detail]]));

  it('a new lead: an open inquiry, and every later step empty', () => {
    const p = buildCustomerProfile(
      base({ enquiries: [{ id: 'e1', date: daysAgo(1), summary: 'Need 50 safety jackets', channel: 'Paid Search' }], owner: 'Sanjay Kumar' }),
    );
    expect(p.stages.map((s) => s.key)).toEqual(['inquiry', 'quote', 'order', 'payment', 'email', 'followUp']);
    expect(chips(p)).toEqual({
      inquiry: ['New', 'progress', 'Yesterday · Paid Search'],
      quote: ['No quote', 'none', undefined],
      order: ['No order yet', 'none', undefined],
      payment: ['Nothing due', 'none', undefined],
      email: ['Not emailed', 'waiting', undefined],
      followUp: ['No follow-up', 'none', undefined],
    });
    expect(p).toMatchObject({ owner: 'Sanjay Kumar', inquiries: { channel: 'Paid Search' }, followUp: { status: 'none', count: 0 } });
  });

  it('a returning customer: each step says where it stands and what is behind it', () => {
    const p = buildCustomerProfile(
      base({
        enquiries: [
          { id: 'e2', date: daysAgo(7), summary: '300 polo shirts' },
          { id: 'e1', date: daysAgo(260), summary: '200 polo shirts' },
        ],
        quotations: [
          { id: 'q1', number: 'Q-1', date: daysAgo(200), amount: 85000, paidAmount: 0, state: 'accepted' },
          { id: 'q2', number: 'Q-2', date: daysAgo(5), amount: 120000, paidAmount: 0, state: 'sent', expiresAt: daysAgo(-20) },
        ],
        invoices: [{ id: 'i1', number: 'INV-1', date: daysAgo(198), value: 85000, status: 'invoiced', quotationId: 'q1', dueDate: daysAgo(170) }],
        payments: [{ quotationId: 'q1', amount: 50000, date: daysAgo(190) }],
        email: { hasAddress: true, received: 2, sent: 3, unanswered: 1, lastReceivedAt: daysAgo(1), lastSentAt: daysAgo(5), oldestUnansweredAt: daysAgo(1) },
      }),
    );
    expect(chips(p)).toEqual({
      inquiry: ['Open', 'progress', '7 days ago · +1'],
      quote: ['Sent', 'progress', 'Q-2 · ₹1,20,000 · +1'],
      order: ['Past order', 'done', '1 order · ₹85,000'],
      payment: ['Overdue', 'attention', '₹35,000 due'],
      email: ['Reply needed', 'attention', '2 in · 3 out'],
      followUp: ['No follow-up', 'none', undefined],
    });
    // A quotation past its validity is expired — red, not waiting; a rejected one is just a fact.
    const quote = (state: 'sent' | 'rejected' | 'draft', expiresAt?: Date) =>
      chips(buildCustomerProfile(base({ quotations: [{ id: 'q', number: 'Q-9', date: daysAgo(40), amount: 100, paidAmount: 0, state, expiresAt }] }))).quote;
    expect(quote('sent', daysAgo(10))).toEqual(['Expired', 'attention', 'Q-9 · ₹100']);
    expect(quote('rejected')).toEqual(['Rejected', 'muted', 'Q-9 · ₹100']);
    expect(quote('draft')).toEqual(['Draft', 'waiting', 'Q-9 · ₹100']);
    // What was paid isn't recorded: said as it is, never "unpaid".
    const unrecorded = buildCustomerProfile(
      base({ paymentsTracked: false, quotations: [{ id: 'q1', number: 'Q-1', date: daysAgo(30), amount: 40000, paidAmount: 0, state: 'accepted' }] }),
    );
    expect(chips(unrecorded).payment).toEqual(['Not recorded', 'muted', '₹40,000 billed']);
  });

  it('follow-ups the team set: overdue, due today, planned — and they call for action', () => {
    const quiet = base({ quotations: [{ id: 'q1', date: daysAgo(20), amount: 5000, paidAmount: 5000, state: 'accepted' }] });
    const withFollowUps = (followUps: { title: string; dueDate?: Date; source: 'email' | 'task' }[]) => buildCustomerProfile({ ...quiet, followUps });

    expect(buildCustomerProfile(quiet)).toMatchObject({ followUp: { status: 'none' }, flags: [], nextAction: { urgency: 'none' } });

    const overdue = withFollowUps([
      { title: 'Call back about the logo size', dueDate: daysAgo(3), source: 'task' },
      { title: 'Send the size chart', dueDate: daysAgo(-4), source: 'email' },
    ]);
    expect(overdue).toMatchObject({
      followUp: { status: 'overdue', label: 'Overdue', count: 2, nextTitle: 'Call back about the logo size' },
      flags: ['follow_up_required'],
      nextAction: { urgency: 'overdue', title: 'Do the follow-up', detail: '“Call back about the logo size” was due 3 days ago.' },
    });
    expect(chips(overdue).followUp).toEqual(['Overdue', 'attention', 'Call back about the logo size · +1']);

    const today = withFollowUps([{ title: 'Confirm the delivery date', dueDate: NOW, source: 'task' }]);
    expect(today).toMatchObject({ followUp: { status: 'today' }, flags: ['follow_up_required'], nextAction: { urgency: 'today', title: 'Follow up today' } });
    expect(chips(today).followUp).toEqual(['Due today', 'waiting', 'Confirm the delivery date']);

    // Planned for later: on the board, but nothing to do yet.
    const planned = withFollowUps([{ title: 'Ask about the reorder', dueDate: daysAgo(-4), source: 'email' }]);
    expect(planned).toMatchObject({ followUp: { status: 'upcoming', count: 1 }, flags: [], nextAction: { urgency: 'none' } });
    expect(chips(planned).followUp![0]).toBe('Planned');
    expect(chips(planned).followUp![2]).toMatch(/^Ask about the reorder · \d{1,2} \w{3}$/);
    // A task with no date is simply open.
    expect(chips(withFollowUps([{ title: 'Find the old artwork', source: 'task' }])).followUp).toEqual(['To do', 'progress', 'Find the old artwork']);
  });
});

describe('how a customer’s records connect', () => {
  const quote = (id: string, number: string, days: number, state: 'sent' | 'accepted', amount: number) => ({
    id,
    number,
    date: daysAgo(days),
    amount,
    state,
    stateLabel: state === 'sent' ? 'Sent' : 'Accepted',
  });
  const invoiceLine = {
    id: 'i1',
    number: 'INV-1',
    date: daysAgo(198),
    amount: 85000,
    status: 'invoiced' as const,
    statusLabel: 'Invoiced',
    overdue: false,
    cost: null,
    marginPct: null,
  };
  const priya = { company: 'Sundar Textiles', contact: 'Priya Raman', email: 'priya@sundar.example' };

  it('lays the records out as journeys and gives every document its neighbours', () => {
    const { journeys, documents } = buildCustomerDocuments({
      currency: 'INR',
      inquiries: [{ id: 'e1', date: daysAgo(6), summary: 'Need 300 polo shirts', open: true }],
      deals: [{ id: 'd1', name: 'Sundar Textiles - Polos', date: daysAgo(200), value: 85000, status: 'won' }],
      quotations: [
        {
          line: quote('q1', 'Q-1', 199, 'accepted', 85000),
          dealId: 'd1',
          source: 'Pantheras CRM',
          preparedFor: priya,
          lines: [{ description: 'Polo t-shirt, navy', quantity: 200, unitPrice: 425, total: 85000 }],
          payments: [{ date: daysAgo(190), amount: 50000 }],
        },
        { line: quote('q2', 'Q-2', 5, 'sent', 120000), dealId: 'd1', source: 'Pantheras CRM', preparedFor: priya, lines: [], payments: [] },
      ],
      invoices: [{ line: { ...invoiceLine, paid: 50000, outstanding: 35000 }, quotationId: 'q1', dealId: 'd1', preparedFor: {} }],
    });

    // Newest first. The inquiry carries no link: it sits before the first quotation made after it, and says so.
    expect(journeys.map((j) => j.steps.map((s) => [s.kind, s.title, s.detail]))).toEqual([
      [
        ['inquiry', 'Inquiry', 'Need 300 polo shirts'],
        ['deal', 'Deal won', 'Sundar Textiles - Polos · ₹85,000'],
        ['quotation', 'Quotation Q-2', 'Sent · ₹1,20,000'],
      ],
      [
        ['deal', 'Deal won', 'Sundar Textiles - Polos · ₹85,000'],
        ['quotation', 'Quotation Q-1', 'Accepted · ₹85,000'],
        ['invoice', 'Invoice INV-1', 'Invoiced · ₹85,000'],
        ['payment', 'Payment', '₹50,000 paid · ₹35,000 due'],
      ],
    ]);
    expect(journeys[0].steps[0]).toMatchObject({ byDate: true, tone: 'progress' });
    expect(journeys[1].steps.map((s) => [s.tone, s.documentId])).toEqual([
      ['done', undefined],
      ['done', 'q1'],
      ['progress', 'i1'],
      ['waiting', undefined],
    ]);

    expect(documents.map((d) => [d.kind, d.number, d.status, d.tone])).toEqual([
      ['quotation', 'Q-2', 'Sent', 'progress'],
      ['invoice', 'INV-1', 'Invoiced', 'progress'],
      ['quotation', 'Q-1', 'Accepted', 'done'],
    ]);
    // The invoice says nothing of who it is for or what is on it: its quotation does.
    expect(documents[1]).toMatchObject({
      preparedFor: priya,
      owner: undefined,
      source: 'Pantheras CRM',
      paid: 50000,
      outstanding: 35000,
      lines: [{ description: 'Polo t-shirt, navy', quantity: 200, total: 85000 }],
      payments: [{ amount: 50000 }],
    });
    // Each document names the other steps of its journey, never itself.
    expect(documents[1].links.map((s) => s.title)).toEqual(['Deal won', 'Quotation Q-1', 'Payment']);
    expect(documents[0].links.map((s) => s.title)).toEqual(['Inquiry', 'Deal won']);
    expect(documents[2].links.map((s) => s.documentId)).toEqual([undefined, 'i1', undefined]);
  });

  it('a quotation shows its items, tax and fees — and says so plainly when they don’t come to its amount', () => {
    const polo = { description: 'Polo t-shirt, navy', detail: '220 GSM, embroidered logo', quantity: 200, unitPrice: 375, total: 75000 };
    const cap = { description: 'Cap', quantity: 50, unitPrice: 150, total: 7500 };
    const gst = { kind: 'tax' as const, name: 'GST 18%', amount: 14850 };
    const shipping = { kind: 'fee' as const, name: 'Shipping', amount: 0 };
    const quotation = (id: string, amount: number, over: object = {}) => ({
      line: { ...quote(id, id.toUpperCase(), 10, 'sent', amount) },
      source: 'Pantheras CRM',
      preparedFor: priya,
      lines: [polo, cap],
      linesFrom: 'deal' as const,
      charges: [gst, shipping],
      payments: [],
      ...over,
    });
    const { documents } = buildCustomerDocuments({
      currency: 'INR',
      inquiries: [],
      deals: [],
      quotations: [
        quotation('q1', 97350), // 82,500 + 14,850: adds up
        quotation('q2', 120000), // the deal was changed after this one was quoted
        quotation('q3', 82500, { charges: [] }), // no tax or fee lines: the items alone are the amount
        quotation('q4', 500, { lines: [], linesFrom: 'deal' }), // nothing held anywhere
        quotation('q5', 9000, { linesFrom: 'document', charges: [] }), // HaiVE's own quotation, lines on it
      ],
      invoices: [{ line: { ...invoiceLine, id: 'i1', amount: 97350, paid: null, outstanding: null }, quotationId: 'q1', preparedFor: {} }],
    });
    const of = (id: string) => documents.find((d) => d.id === id)!;

    expect(of('q1')).toMatchObject({ lines: [polo, cap], subtotal: 82500, linesFrom: 'deal', charges: [gst] });
    // A fee of nothing is not listed.
    expect(of('q1').charges).toEqual([gst]);
    expect(of('q1').linesNote).toBeUndefined();
    expect(of('q2')).toMatchObject({ lines: [polo, cap], subtotal: 82500 });
    expect(of('q2').linesNote).toBe(
      'These are the products on the deal in Pantheras CRM today. With tax and fees they come to ₹97,350, not this quotation’s ₹1,20,000 — the deal may have been changed since, or priced differently.',
    );
    expect(of('q3').linesNote).toBeUndefined();
    expect(of('q4')).toMatchObject({ lines: [], subtotal: null, charges: [] });
    expect(of('q4').linesNote).toBeUndefined();
    expect(of('q5').linesNote).toBe('The items come to ₹82,500, not this quotation’s ₹9,000.');
    // The invoice raised from a quotation is for the same items.
    expect(of('i1')).toMatchObject({ kind: 'invoice', lines: [polo, cap], subtotal: 82500, charges: [gst], linesFrom: 'deal' });
    expect(of('i1').linesNote).toBeUndefined();
  });

  it('says a payment is not recorded rather than guessing, and keeps loose records as journeys of their own', () => {
    const { journeys, documents } = buildCustomerDocuments({
      currency: 'INR',
      inquiries: [{ id: 'e9', date: daysAgo(2), summary: 'Do you make caps?', channel: 'Direct', open: true }],
      deals: [{ id: 'd9', name: 'Old lead', date: daysAgo(400), value: 0, status: 'lost' }],
      quotations: [],
      invoices: [{ line: { ...invoiceLine, id: 'i9', number: 'INV-9', paid: null, outstanding: null }, preparedFor: { contact: 'Rahul Shah' } }],
    });
    expect(journeys.map((j) => j.steps.map((s) => [s.title, s.detail, s.tone]))).toEqual([
      [['Inquiry', 'Do you make caps?', 'progress']],
      [
        ['Invoice INV-9', 'Invoiced · ₹85,000', 'progress'],
        ['Payment', 'Not recorded', 'muted'],
      ],
      [['Deal lost', 'Old lead', 'muted']],
    ]);
    expect(journeys[0].steps[0].byDate).toBeUndefined();
    expect(documents).toEqual([
      expect.objectContaining({
        kind: 'invoice',
        number: 'INV-9',
        preparedFor: { contact: 'Rahul Shah' },
        lines: [],
        paid: null,
        links: [expect.objectContaining({ title: 'Payment' })],
      }),
    ]);
  });
});

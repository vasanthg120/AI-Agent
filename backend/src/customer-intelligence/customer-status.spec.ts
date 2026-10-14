import { buildCustomerProfile, ProfileInput, STAGE_OPTIONS, StageKey, StageOverride } from './customer-profile.builder';

const NOW = new Date('2026-10-10T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const base = (over: Partial<ProfileInput> = {}): ProfileInput => ({
  now: NOW,
  currency: 'INR',
  paymentsTracked: true,
  enquiries: [],
  deals: [],
  quotations: [],
  invoices: [],
  payments: [],
  email: { hasAddress: true, received: 0, sent: 0, unanswered: 0 },
  ...over,
});
const by = (status: string): StageOverride => ({ status, by: 'Sanjay Kumar', at: NOW });
const build = (input: ProfileInput, overrides: Partial<Record<StageKey, StageOverride>> = {}) => buildCustomerProfile({ ...input, overrides });
const chip = (p: ReturnType<typeof buildCustomerProfile>, key: StageKey) => p.stages.find((s) => s.key === key)!;

// A status the team sets by hand replaces what the connected systems say for
// that one step — on the chip, in the tiles and filters that read it, and in
// the reminders. Pure rules: no database.
describe('statuses set by hand', () => {
  // Ordered once, part paid, and the rest is past its due date.
  const owing = base({
    quotations: [{ id: 'q1', number: 'Q-1', date: daysAgo(60), amount: 85000, paidAmount: 0, state: 'accepted' }],
    invoices: [{ id: 'i1', number: 'INV-1', date: daysAgo(58), value: 85000, status: 'invoiced', quotationId: 'q1', dueDate: daysAgo(20) }],
    payments: [{ quotationId: 'q1', amount: 50000, date: daysAgo(50) }],
  });

  it('every step offers its own short list, each option with a colour', () => {
    expect(Object.fromEntries(Object.entries(STAGE_OPTIONS).map(([key, options]) => [key, options.map((o) => o.label)]))).toEqual({
      inquiry: ['New', 'Contacted', 'In discussion', 'Converted', 'Not interested'],
      quote: ['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired'],
      order: ['Order placed', 'In production', 'Ready', 'Delivered', 'No order'],
      payment: ['Paid', 'Part paid', 'Unpaid', 'Overdue'],
      email: ['Reply needed', 'Emailed', 'No reply yet', 'Replied', 'No reply needed'],
      followUp: ['Not needed'],
    });
    // What goes on a chip fits a chip.
    for (const o of Object.values(STAGE_OPTIONS).flat()) expect((o.short ?? o.label).length).toBeLessThanOrEqual(12);
  });

  it('with nothing set, every step says what the systems say, as a value the filters can compare', () => {
    const p = build(owing);
    expect(p.stages.map((s) => [s.key, s.status, s.manual])).toEqual([
      ['inquiry', 'none', undefined],
      ['quote', 'accepted', undefined],
      ['order', 'converted', undefined],
      ['payment', 'overdue', undefined],
      ['email', 'none', undefined],
      ['followUp', 'none', undefined],
    ]);
    expect(p).toMatchObject({ flags: ['payment_overdue'], nextAction: { title: 'Request payment — overdue' } });
  });

  it('Payment set to Paid: the chip, the tile and the reminder all follow — the figures do not', () => {
    const p = build(owing, { payment: by('paid') });
    expect(chip(p, 'payment')).toEqual({
      key: 'payment',
      title: 'Payment',
      status: 'paid',
      label: 'Paid',
      tone: 'done',
      detail: 'Set by Sanjay Kumar · 10 Oct',
      manual: { label: 'Paid', by: 'Sanjay Kumar', at: NOW, automatic: 'Overdue' },
    });
    expect(p.flags).toEqual([]);
    expect(p.nextAction).toMatchObject({ urgency: 'none', title: 'Nothing needed right now' });
    // Said first, and the sentence it contradicts is left out.
    expect(p.insight).toMatch(/^Set by your team: Payment — Paid\. Existing customer with 1 order/);
    expect(p.insight).not.toMatch(/overdue|unpaid/i);
    // What the records hold is still what the records hold.
    expect(p.payment).toMatchObject({ status: 'overdue', paid: 50000, outstanding: 35000 });
    // The other steps are untouched.
    expect(chip(p, 'quote')).toMatchObject({ status: 'accepted', label: 'Accepted' });
    expect(chip(p, 'quote').manual).toBeUndefined();
  });

  it('Payment marked as owed where nothing is recorded: it joins Payment pending and asks to be collected', () => {
    const unrecorded = base({ paymentsTracked: false, quotations: [{ id: 'q1', date: daysAgo(30), amount: 40000, paidAmount: 0, state: 'accepted' }] });
    expect(build(unrecorded)).toMatchObject({ flags: [], nextAction: { urgency: 'none' } });
    expect(build(unrecorded, { payment: by('unpaid') })).toMatchObject({
      flags: ['payment_pending'],
      nextAction: { urgency: 'soon', title: 'Collect payment', detail: 'Marked “Unpaid” by your team.' },
    });
    expect(build(unrecorded, { payment: by('overdue') })).toMatchObject({
      flags: ['payment_overdue'],
      nextAction: { urgency: 'overdue', title: 'Request payment — overdue', detail: 'Marked “Overdue” by your team.' },
    });
    expect(chip(build(unrecorded, { payment: by('partially_paid') }), 'payment')).toMatchObject({ label: 'Part paid', tone: 'waiting' });
  });

  it('Email: a settled step stops asking for a reply; one marked as needing a reply asks for it', () => {
    const unanswered = base({ email: { hasAddress: true, received: 2, sent: 1, unanswered: 1, lastReceivedAt: daysAgo(2), oldestUnansweredAt: daysAgo(2) } });
    expect(build(unanswered)).toMatchObject({ flags: ['reply_needed'], nextAction: { title: 'Reply to the customer' } });
    for (const status of ['replied', 'not_replied', 'no_reply_needed']) {
      const p = build(unanswered, { email: by(status) });
      expect(p.flags).toEqual([]);
      expect(p.nextAction.urgency).toBe('none');
      expect(p.insight).not.toMatch(/waiting for a reply/);
    }
    // The chip carries the short form; the full name is kept for the menu and the tooltip.
    expect(chip(build(unanswered, { email: by('no_reply_needed') }), 'email')).toMatchObject({
      label: 'None needed',
      tone: 'muted',
      manual: { label: 'No reply needed', automatic: 'Reply needed' },
    });

    const quiet = base({ email: { hasAddress: true, received: 1, sent: 1, unanswered: 0, lastReceivedAt: daysAgo(1), lastSentAt: daysAgo(3) } });
    expect(build(quiet).flags).toEqual([]);
    expect(build(quiet, { email: by('reply_needed') })).toMatchObject({
      flags: ['reply_needed'],
      nextAction: { urgency: 'today', title: 'Reply to the customer', detail: 'Marked “Reply needed” by your team.' },
    });
    expect(build(quiet, { email: by('follow_up') })).toMatchObject({ flags: ['follow_up_required'], nextAction: { title: 'Follow up' } });
  });

  it('Quote: accepted, rejected or expired by hand stops the chase and leaves Quote pending; Sent joins it', () => {
    const chased = base({ quotations: [{ id: 'q1', number: 'Q-7', date: daysAgo(9), amount: 64000, paidAmount: 0, state: 'sent', expiresAt: daysAgo(-20) }] });
    expect(build(chased)).toMatchObject({ flags: ['follow_up_required', 'quote_pending'], nextAction: { title: 'Follow up on the quotation' } });
    for (const status of ['accepted', 'rejected', 'expired']) {
      const p = build(chased, { quote: by(status) });
      expect(p.flags).toEqual([]);
      expect(p.nextAction.urgency).toBe('none');
      expect(p.insight).not.toMatch(/awaiting their decision/);
    }
    expect(chip(build(chased, { quote: by('rejected') }), 'quote')).toMatchObject({ label: 'Rejected', tone: 'muted', manual: { automatic: 'Sent' } });
    // The other way round: the CRM says accepted, the team says it is still out.
    const won = base({ quotations: [{ id: 'q1', date: daysAgo(9), amount: 64000, paidAmount: 64000, state: 'accepted' }] });
    expect(build(won).flags).toEqual([]);
    expect(build(won, { quote: by('sent') }).flags).toEqual(['quote_pending']);
  });

  it('Inquiry: contacted by hand stops "contact the customer"; closed by hand, it is no longer an open inquiry', () => {
    const lead = base({ enquiries: [{ id: 'e1', date: daysAgo(5), summary: 'Need 50 safety jackets' }] });
    expect(build(lead)).toMatchObject({ inquiries: { open: true }, flags: ['follow_up_required'], nextAction: { title: 'Contact the customer' } });
    const contacted = build(lead, { inquiry: by('contacted') });
    expect(contacted).toMatchObject({ inquiries: { open: true }, flags: [], nextAction: { urgency: 'none' } });
    expect(chip(contacted, 'inquiry')).toMatchObject({ status: 'contacted', label: 'Contacted', tone: 'progress', manual: { automatic: 'Open' } });
    const closed = build(lead, { inquiry: by('not_interested') });
    expect(closed).toMatchObject({ inquiries: { open: false }, flags: [], nextAction: { urgency: 'none' } });
    expect(chip(closed, 'inquiry')).toMatchObject({ label: 'No interest', tone: 'muted', manual: { label: 'Not interested' } });
    // Still "New" by hand: nothing is settled, the reminder stays.
    expect(build(lead, { inquiry: by('new') })).toMatchObject({ inquiries: { open: true }, nextAction: { title: 'Contact the customer' } });
    // An inquiry that reached the team another way (a phone call): set by hand, it counts as open.
    expect(build(base(), { inquiry: by('in_discussion') })).toMatchObject({ inquiries: { open: true, count: 0 } });
  });

  it('Follow-up "Not needed" silences the chases the systems suggest — never a task the team set itself', () => {
    const chased = base({ quotations: [{ id: 'q1', number: 'Q-7', date: daysAgo(9), amount: 64000, paidAmount: 0, state: 'sent', expiresAt: daysAgo(-20) }] });
    const quietened = build(chased, { followUp: by('not_needed') });
    expect(quietened).toMatchObject({
      flags: ['quote_pending'],
      nextAction: { urgency: 'none', detail: 'A quotation is with the customer and it is too early to chase.' },
    });
    expect(chip(quietened, 'followUp')).toMatchObject({ status: 'not_needed', label: 'Not needed', tone: 'muted', manual: { automatic: 'No follow-up' } });
    // It does not silence a reply that is owed.
    const owed = build(base({ email: { hasAddress: true, received: 1, sent: 0, unanswered: 1, oldestUnansweredAt: daysAgo(1) } }), {
      followUp: by('not_needed'),
    });
    expect(owed).toMatchObject({ flags: ['reply_needed'], nextAction: { title: 'Reply to the customer' } });
    // A task of the team's own is waiting: "not needed" cannot stand over it.
    const withTask = buildCustomerProfile({
      ...chased,
      followUps: [{ title: 'Call back', dueDate: daysAgo(2), source: 'task' }],
      overrides: { followUp: by('not_needed') },
    });
    expect(chip(withTask, 'followUp')).toMatchObject({ status: 'overdue', label: 'Overdue' });
    expect(chip(withTask, 'followUp').manual).toBeUndefined();
    expect(withTask).toMatchObject({ flags: expect.arrayContaining(['follow_up_required']), nextAction: { title: 'Do the follow-up' } });
  });

  it('Order is the team’s own to track; several steps set at once are all named; an unknown status is ignored', () => {
    const p = build(owing, { order: by('in_production'), payment: by('paid'), quote: { status: 'made_up' } });
    expect(chip(p, 'order')).toMatchObject({
      status: 'in_production',
      label: 'Production',
      tone: 'progress',
      manual: { label: 'In production', automatic: 'Converted' },
    });
    expect(chip(p, 'quote')).toMatchObject({ status: 'accepted', label: 'Accepted' });
    expect(chip(p, 'quote').manual).toBeUndefined();
    expect(p.insight).toMatch(/^Set by your team: Order — In production, Payment — Paid\./);
    // Whoever set it isn't known: still said plainly.
    expect(chip(build(owing, { order: { status: 'delivered' } }), 'order').detail).toBe('Set by your team');
    // The type of customer and the orders are facts, whatever the chip says.
    expect(p).toMatchObject({ type: 'existing', orders: { status: 'converted', count: 1 } });
  });
});

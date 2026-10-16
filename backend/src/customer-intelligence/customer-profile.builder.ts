// One customer, seen whole. The directory service next door gathers every
// record that belongs to the same customer — enquiries from one CRM, deals,
// quotations and invoices from another, the email exchanged with them — and
// this turns them into the one row a salesperson reads: who they are, what
// they bought, what is open, what is owed and what to do next.
//
// Pure: no database, no CRM, no AI. Every statement comes from a record that
// was passed in; where something isn't recorded the output says so instead of
// assuming.

import { formatAmount, TimelineEvent } from './customer-timeline';

const DAY_MS = 24 * 60 * 60 * 1000;
// A sent quotation, or our last email, is chased after this many quiet days.
const FOLLOW_UP_AFTER_DAYS = 3;
// An enquiry nobody has answered is still "new" for this long.
const NEW_ENQUIRY_DAYS = 2;
// With nothing happening for this long, the customer is inactive.
const INACTIVE_AFTER_DAYS = 90;
const LIST_LIMIT = 25;

// ---- what goes in ---------------------------------------------------------------

export interface ProfileEnquiry {
  id: string;
  date?: Date;
  summary?: string;
  /** How they found us (Paid Search, Direct…), when the enquiry system says. */
  channel?: string;
  location?: string;
}

/** Something still to do for this customer: a reminder set on one of their emails, or a task the team added. */
export interface ProfileFollowUp {
  title: string;
  /** A task may have no date: it is then simply open. */
  dueDate?: Date;
  source: 'email' | 'task';
}

/** A deal in a CRM's pipeline (not an enquiry). */
export interface ProfileDeal {
  id: string;
  name?: string;
  date?: Date;
  value: number;
  status: 'open' | 'won' | 'lost';
}

export interface ProfileQuotation {
  id: string;
  number?: string;
  name?: string;
  date?: Date;
  amount: number;
  /** What the CRM says has been paid against it. */
  paidAmount: number;
  state: 'draft' | 'sent' | 'accepted' | 'rejected';
  /** When payment is due — not the quotation's validity. */
  dueDate?: Date;
  /** Until when the quotation is valid. */
  expiresAt?: Date;
  owner?: string;
  dealId?: string;
}

export interface ProfileInvoice {
  id: string;
  number?: string;
  date?: Date;
  value: number;
  /** Only when a cost was really recorded. */
  cost?: number;
  status: 'draft' | 'invoiced' | 'paid';
  dueDate?: Date;
  quotationId?: string;
  dealId?: string;
}

export interface ProfilePayment {
  quotationId: string;
  amount: number;
  date: Date;
}

/** The customer as a contact in a CRM, whether or not anything was quoted to them yet. */
export interface ProfileContact {
  id: string;
  /** When the CRM says it was created — only when the CRM says. */
  date?: Date;
  /** Which CRM holds it. */
  source?: string;
}

export interface ProfileEmail {
  /** Whether an email address is known for this customer at all. */
  hasAddress: boolean;
  received: number;
  sent: number;
  /** Emails from the customer nobody has answered. */
  unanswered: number;
  lastReceivedAt?: Date;
  lastSentAt?: Date;
  oldestUnansweredAt?: Date;
}

export interface ProfileInput {
  now: Date;
  currency: string;
  /** Whether the organization records payments at all — when it doesn't, "unpaid" would be a guess. */
  paymentsTracked: boolean;
  enquiries: ProfileEnquiry[];
  deals: ProfileDeal[];
  quotations: ProfileQuotation[];
  invoices: ProfileInvoice[];
  payments: ProfilePayment[];
  contacts?: ProfileContact[];
  email: ProfileEmail;
  /** Who looks after this customer in the CRM: the owner of their latest quotation, else of their deal. */
  owner?: string;
  /** Follow-ups that are still open (done and dismissed ones are not passed in). */
  followUps?: ProfileFollowUp[];
  /** Statuses the team set by hand, per step. One that names no known option is ignored. */
  overrides?: Partial<Record<StageKey, StageOverride>>;
}

/** A status somebody chose for a step, in place of what the connected systems say. */
export interface StageOverride {
  status: string;
  by?: string;
  at?: Date;
}

// ---- what comes out --------------------------------------------------------------

/** overdue: its day has passed · today · upcoming: planned for later, or open with no date · none. */
export type FollowUpState = 'overdue' | 'today' | 'upcoming' | 'none';

// One step of the work with a customer, as the board shows it: a coloured chip
// and one line under it. The same six, in the same order, on the table, the
// cards, the panel and the export — so they always say the same thing.
export type StageKey = 'inquiry' | 'quote' | 'order' | 'payment' | 'email' | 'followUp';
/** done: finished, good · progress: moving, nothing owed · waiting: needs attention soon · attention: act now · muted: a fact with nothing to do · none: nothing there. */
export type StageTone = 'done' | 'progress' | 'waiting' | 'attention' | 'muted' | 'none';
export interface Stage {
  key: StageKey;
  title: string;
  label: string;
  tone: StageTone;
  detail?: string;
  /** The status as a value ("sent", "paid"…): what the board's filters compare. */
  status: string;
  /** Present when the team set this step by hand: its full name, who and when, and what the connected systems say instead. */
  manual?: { label: string; by?: string; at?: Date; automatic: string };
}

// What the team can set a step to, in place of what the connected systems
// say. Saved in HaiVE only — no CRM is written to. "Automatic" (no choice) is
// always the way back.
export interface StageOption {
  status: string;
  label: string;
  /** On a chip there is room for a dozen letters. */
  short?: string;
  tone: StageTone;
  /** Choosing it says this step needs nothing more for now: its reminders stop. */
  settles: boolean;
}

const option = (status: string, label: string, tone: StageTone, settles: boolean, short?: string): StageOption => ({
  status,
  label,
  tone,
  settles,
  ...(short ? { short } : {}),
});

/** The options of each step: the same words and colours wherever a status is shown or chosen. */
export const STAGE_OPTIONS: Record<StageKey, StageOption[]> = {
  inquiry: [
    option('new', 'New', 'progress', false),
    option('contacted', 'Contacted', 'progress', true),
    option('in_discussion', 'In discussion', 'progress', true, 'Discussing'),
    option('converted', 'Converted', 'done', true),
    option('not_interested', 'Not interested', 'muted', true, 'No interest'),
  ],
  quote: [
    option('draft', 'Draft', 'waiting', false),
    option('sent', 'Sent', 'progress', false),
    option('accepted', 'Accepted', 'done', true),
    option('rejected', 'Rejected', 'muted', true),
    option('expired', 'Expired', 'attention', true),
  ],
  order: [
    option('placed', 'Order placed', 'progress', true),
    option('in_production', 'In production', 'progress', true, 'Production'),
    option('ready', 'Ready', 'waiting', true),
    option('delivered', 'Delivered', 'done', true),
    option('no_order', 'No order', 'muted', true),
  ],
  payment: [
    option('paid', 'Paid', 'done', true),
    option('partially_paid', 'Part paid', 'waiting', false),
    option('unpaid', 'Unpaid', 'waiting', false),
    option('overdue', 'Overdue', 'attention', false),
  ],
  email: [
    option('reply_needed', 'Reply needed', 'attention', false),
    option('not_replied', 'Emailed', 'progress', true),
    option('follow_up', 'No reply yet', 'waiting', false),
    option('replied', 'Replied', 'done', true),
    option('no_reply_needed', 'No reply needed', 'muted', true, 'None needed'),
  ],
  // The follow-up step is driven by real tasks and reminders; the one thing to say by hand is that none is needed.
  followUp: [option('not_needed', 'Not needed', 'muted', true)],
};
/** An inquiry the team closed by hand is no longer an open one. */
const INQUIRY_CLOSED = ['converted', 'not_interested'];
export const STAGE_TITLE: Record<StageKey, string> = {
  inquiry: 'Inquiry',
  quote: 'Quote',
  order: 'Order',
  payment: 'Payment',
  email: 'Email',
  followUp: 'Follow-up',
};

export type CustomerType = 'new' | 'existing' | 'returning';
export type QuoteState = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';
export type PaymentState = 'paid' | 'partially_paid' | 'unpaid' | 'overdue' | 'not_recorded' | 'nothing_due';
export type OrderState = 'converted' | 'previous_order' | 'not_converted' | 'none';
export type EmailState = 'reply_needed' | 'follow_up' | 'not_replied' | 'replied' | 'not_contacted' | 'none';
export type CrmState = 'lead' | 'opportunity' | 'customer' | 'lost';
export type CustomerFlag = 'reply_needed' | 'follow_up_required' | 'quote_pending' | 'payment_pending' | 'payment_overdue';

export interface ProfileAction {
  /** overdue: should already have happened · today · soon · none: nothing to do. */
  urgency: 'overdue' | 'today' | 'soon' | 'none';
  title: string;
  detail: string;
}

export interface QuoteLine {
  id: string;
  number?: string;
  name?: string;
  date?: Date;
  amount: number;
  state: QuoteState;
  stateLabel: string;
  expiresAt?: Date;
  owner?: string;
}

export interface InvoiceLine {
  id: string;
  number?: string;
  date?: Date;
  amount: number;
  status: ProfileInvoice['status'];
  statusLabel: string;
  /** Null when what was paid isn't recorded. */
  paid: number | null;
  outstanding: number | null;
  dueDate?: Date;
  overdue: boolean;
  cost: number | null;
  marginPct: number | null;
  quotationNumber?: string;
}

export interface OrderComparison {
  previous: { label: string; date?: Date; value: number; marginPct: number | null };
  current: { label: string; date?: Date; value: number; marginPct: number | null; isQuotation: boolean };
  valueDifference: number;
  valueDifferencePct: number | null;
  marginDifference: number | null;
  /** What the figures above mean for the price — worked out from them, never guessed. */
  note: string;
}

export interface CustomerSummary {
  currency: string;
  type: CustomerType;
  typeLabel: string;
  typeReason: string;
  active: boolean;
  lastActivity: { at: Date; label: string } | null;
  daysSinceLastActivity: number | null;
  owner?: string;
  /** `actioned`: since the latest inquiry someone emailed them or sent a quotation (or marked it handled). */
  inquiries: { count: number; latestAt?: Date; latestSummary?: string; open: boolean; actioned: boolean; channel?: string; location?: string };
  quotes: { count: number; openCount: number; openValue: number; latest: QuoteLine | null };
  invoices: { count: number; total: number; latest: InvoiceLine | null };
  payment: { status: PaymentState; label: string; billed: number; paid: number | null; outstanding: number | null; overdueAmount: number };
  orders: { status: OrderState; label: string; count: number; totalValue: number; lastOrderAt?: Date };
  mail: { status: EmailState; label: string; received: number; sent: number; unanswered: number; lastReceivedAt?: Date; lastSentAt?: Date };
  crm: { status: CrmState; label: string };
  /** What is still to do: reminders on their emails and the team's own tasks. `nextAt` is the earliest dated one. */
  followUp: { status: FollowUpState; label: string; count: number; nextAt?: Date; nextTitle?: string };
  flags: CustomerFlag[];
  nextAction: ProfileAction;
  /** The whole picture in two or three sentences. */
  insight: string;
  /** Inquiry → Quote → Order → Payment → Email → Follow-up. */
  stages: Stage[];
}

export interface CustomerProfile extends CustomerSummary {
  quotations: QuoteLine[];
  invoiceList: InvoiceLine[];
  comparison: OrderComparison | null;
  /** Information that is missing, or that disagrees between systems. */
  gaps: string[];
  /** Enquiries, quotations, invoices and payments — the service adds the emails. */
  events: TimelineEvent[];
}

// ---- helpers -------------------------------------------------------------------------

const time = (date?: Date) => date?.getTime() ?? 0;
const days = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ago = (date: Date, now: Date) => {
  const n = days(date, now);
  return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
};
const marginPctOf = (price: number, cost: number) => (price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : 0);
const round2 = (value: number) => Math.round(value * 100) / 100;

const TYPE_LABEL: Record<CustomerType, string> = { new: 'New', existing: 'Existing', returning: 'Returning' };
const QUOTE_LABEL: Record<QuoteState, string> = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired' };
const INVOICE_LABEL: Record<ProfileInvoice['status'], string> = { draft: 'Draft', invoiced: 'Invoiced', paid: 'Paid' };
const PAYMENT_LABEL: Record<PaymentState, string> = {
  paid: 'Paid',
  partially_paid: 'Partially paid',
  unpaid: 'Unpaid',
  overdue: 'Overdue',
  not_recorded: 'Not recorded',
  nothing_due: 'Nothing due',
};
const ORDER_LABEL: Record<OrderState, string> = { converted: 'Converted', previous_order: 'Previous order', not_converted: 'Not converted', none: 'No order' };
const EMAIL_LABEL: Record<EmailState, string> = {
  reply_needed: 'Reply needed',
  follow_up: 'Follow-up required',
  not_replied: 'Not replied',
  replied: 'Replied',
  not_contacted: 'Not contacted',
  none: 'No emails',
};
const CRM_LABEL: Record<CrmState, string> = { lead: 'Lead', opportunity: 'Opportunity', customer: 'Customer', lost: 'Lost' };
const FOLLOW_UP_LABEL: Record<FollowUpState, string> = { overdue: 'Overdue', today: 'Due today', upcoming: 'Planned', none: 'No follow-up' };

// What each state means for the person looking at the board.
const QUOTE_TONE: Record<QuoteState, StageTone> = { draft: 'waiting', sent: 'progress', accepted: 'done', rejected: 'muted', expired: 'attention' };
const PAYMENT_TONE: Record<PaymentState, StageTone> = {
  paid: 'done',
  partially_paid: 'waiting',
  unpaid: 'waiting',
  overdue: 'attention',
  not_recorded: 'muted',
  nothing_due: 'none',
};
const ORDER_TONE: Record<OrderState, StageTone> = { converted: 'done', previous_order: 'done', not_converted: 'none', none: 'none' };
const EMAIL_TONE: Record<EmailState, StageTone> = {
  reply_needed: 'attention',
  follow_up: 'waiting',
  not_replied: 'progress',
  replied: 'done',
  not_contacted: 'waiting',
  none: 'none',
};
// On a chip there is room for a dozen letters: the same states, said shorter.
const EMAIL_CHIP: Record<EmailState, string> = {
  reply_needed: 'Reply needed',
  follow_up: 'No reply yet',
  not_replied: 'Emailed',
  replied: 'Replied',
  not_contacted: 'Not emailed',
  none: 'No emails',
};
const ORDER_CHIP: Record<OrderState, string> = { converted: 'Converted', previous_order: 'Past order', not_converted: 'No order yet', none: 'No order' };
const PAYMENT_CHIP: Record<PaymentState, string> = { ...PAYMENT_LABEL, partially_paid: 'Part paid' };
const FOLLOW_UP_TONE: Record<FollowUpState, StageTone> = { overdue: 'attention', today: 'waiting', upcoming: 'progress', none: 'none' };
const shortDate = (date: Date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

interface Order {
  id: string;
  label: string;
  date?: Date;
  value: number;
  cost: number | null;
  /** What has been paid, as far as it is recorded. */
  paid: number;
  dueDate?: Date;
  quotationId?: string;
  /** False for an order known only from a deal marked won: nothing to bill against. */
  billable: boolean;
}

// ---- the build -----------------------------------------------------------------------

export function buildCustomerProfile(input: ProfileInput): CustomerProfile {
  const { now, currency, email } = input;
  const money = (amount: number) => formatAmount(amount, currency);
  const newestFirst = <T extends { date?: Date }>(rows: T[]) => [...rows].sort((a, b) => time(b.date) - time(a.date));

  const enquiries = newestFirst(input.enquiries);
  const quotes = newestFirst(input.quotations);
  const invoices = newestFirst(input.invoices);
  const quoteById = new Map(quotes.map((q) => [q.id, q]));
  const paidByQuote = new Map<string, number>();
  for (const p of input.payments) paidByQuote.set(p.quotationId, (paidByQuote.get(p.quotationId) ?? 0) + p.amount);

  // -- quotations as they read today: one that was sent and has run out is expired, not pending.
  const stateOf = (q: ProfileQuotation): QuoteState => (q.state === 'sent' && q.expiresAt && q.expiresAt.getTime() < now.getTime() ? 'expired' : q.state);
  const quotations: QuoteLine[] = quotes.map((q) => ({
    id: q.id,
    number: q.number,
    name: q.name,
    date: q.date,
    amount: q.amount,
    state: stateOf(q),
    stateLabel: QUOTE_LABEL[stateOf(q)],
    expiresAt: q.expiresAt,
    owner: q.owner,
  }));
  const openQuotes = quotations.filter((q) => q.state === 'sent');
  const draftQuotes = quotations.filter((q) => q.state === 'draft');

  // -- orders: one per real order. An accepted quotation and the invoice raised
  // from it are one order; so is a deal marked won that carries them.
  const invoiceByQuote = new Map<string, ProfileInvoice>();
  for (const invoice of invoices) if (invoice.quotationId && !invoiceByQuote.has(invoice.quotationId)) invoiceByQuote.set(invoice.quotationId, invoice);
  const paidOn = (value: number, invoice: ProfileInvoice | undefined, quotation: ProfileQuotation | undefined) => {
    if (invoice?.status === 'paid') return value;
    const recorded = Math.max(quotation?.paidAmount ?? 0, quotation ? (paidByQuote.get(quotation.id) ?? 0) : 0);
    return Math.min(value, recorded);
  };
  const orders: Order[] = [];
  const coveredDeals = new Set<string>();
  const usedInvoices = new Set<string>();
  for (const q of quotes.filter((x) => x.state === 'accepted')) {
    const invoice = invoiceByQuote.get(q.id);
    if (invoice) usedInvoices.add(invoice.id);
    const value = invoice?.value || q.amount;
    if (q.dealId) coveredDeals.add(q.dealId);
    if (invoice?.dealId) coveredDeals.add(invoice.dealId);
    orders.push({
      id: q.id,
      label: invoice?.number ? `Invoice ${invoice.number}` : q.number ? `Quotation ${q.number}` : 'Accepted quotation',
      date: invoice?.date ?? q.date,
      value,
      cost: typeof invoice?.cost === 'number' ? invoice.cost : null,
      paid: paidOn(value, invoice, q),
      dueDate: invoice?.dueDate ?? q.dueDate,
      quotationId: q.id,
      billable: value > 0,
    });
  }
  // An invoice with no accepted quotation behind it is still an order.
  const seenQuoteInvoices = new Set<string>();
  for (const invoice of invoices) {
    if (usedInvoices.has(invoice.id)) continue;
    if (invoice.quotationId) {
      if (quoteById.get(invoice.quotationId)?.state === 'accepted' || seenQuoteInvoices.has(invoice.quotationId)) continue;
      seenQuoteInvoices.add(invoice.quotationId);
    }
    if (invoice.dealId) coveredDeals.add(invoice.dealId);
    orders.push({
      id: invoice.id,
      label: invoice.number ? `Invoice ${invoice.number}` : 'Invoice',
      date: invoice.date,
      value: invoice.value,
      cost: typeof invoice.cost === 'number' ? invoice.cost : null,
      paid: paidOn(invoice.value, invoice, invoice.quotationId ? quoteById.get(invoice.quotationId) : undefined),
      dueDate: invoice.dueDate,
      quotationId: invoice.quotationId,
      billable: invoice.value > 0,
    });
  }
  const wonWithoutPaperwork = input.deals.filter((d) => d.status === 'won' && !coveredDeals.has(d.id));
  for (const deal of wonWithoutPaperwork) {
    orders.push({
      id: `deal-${deal.id}`,
      label: deal.name ? `Deal “${deal.name}”` : 'Won deal',
      date: deal.date,
      value: deal.value,
      cost: null,
      paid: 0,
      billable: false,
    });
  }
  orders.sort((a, b) => time(b.date) - time(a.date));
  const orderQuoteIds = new Set(orders.map((o) => o.quotationId).filter(Boolean));
  const ordersTotal = orders.reduce((sum, o) => sum + o.value, 0);
  const lastOrderAt = orders[0]?.date;
  const firstOrderAt = orders.length ? orders[orders.length - 1].date : undefined;

  // -- new, existing or returning
  const cameBack =
    !!firstOrderAt &&
    (enquiries.some((e) => time(e.date) > firstOrderAt.getTime() + DAY_MS) ||
      quotes.some((q) => !orderQuoteIds.has(q.id) && time(q.date) > firstOrderAt.getTime() + DAY_MS));
  const type: CustomerType = orders.length === 0 ? 'new' : orders.length >= 2 || cameBack ? 'returning' : 'existing';
  const typeReason =
    type === 'new'
      ? enquiries.length + quotes.length > 0
        ? 'No order on record yet.'
        : 'Nothing on record yet.'
      : `${plural(orders.length, 'order')} worth ${money(ordersTotal)}${lastOrderAt ? `, the latest ${ago(lastOrderAt, now)}` : ''}${type === 'returning' && orders.length < 2 ? ' — and they have come back since.' : '.'}`;

  // -- what is open right now: an enquiry or a quotation that no order has closed.
  const latestEnquiry = enquiries[0];
  const enquiryOpen = !!latestEnquiry && (!lastOrderAt || time(latestEnquiry.date) > lastOrderAt.getTime() + DAY_MS);
  const quotedSinceEnquiry = !!latestEnquiry?.date && quotes.some((q) => q.state !== 'draft' && time(q.date) >= latestEnquiry.date!.getTime() - DAY_MS);
  const openMatter = enquiryOpen || openQuotes.length > 0;

  // -- money
  const billable = orders.filter((o) => o.billable);
  const billed = billable.reduce((sum, o) => sum + o.value, 0);
  const paidTotal = billable.reduce((sum, o) => sum + o.paid, 0);
  const outstandingTotal = Math.max(billed - paidTotal, 0);
  const overdueOrders = billable.filter((o) => o.value - o.paid > 0 && !!o.dueDate && o.dueDate.getTime() < now.getTime());
  const overdueAmount = overdueOrders.reduce((sum, o) => sum + (o.value - o.paid), 0);
  // What was paid is only known when payments are recorded somewhere.
  const paymentKnown = input.paymentsTracked || paidTotal > 0;
  const paymentStatus: PaymentState =
    billable.length === 0
      ? 'nothing_due'
      : !paymentKnown
        ? 'not_recorded'
        : overdueAmount > 0
          ? 'overdue'
          : outstandingTotal <= 0
            ? 'paid'
            : paidTotal > 0
              ? 'partially_paid'
              : 'unpaid';

  const invoiceList: InvoiceLine[] = invoices.map((invoice) => {
    const quotation = invoice.quotationId ? quoteById.get(invoice.quotationId) : undefined;
    const paid = paidOn(invoice.value, invoice, quotation);
    const owed = Math.max(invoice.value - paid, 0);
    return {
      id: invoice.id,
      number: invoice.number,
      date: invoice.date,
      amount: invoice.value,
      status: invoice.status,
      statusLabel: INVOICE_LABEL[invoice.status],
      paid: paymentKnown || invoice.status === 'paid' ? paid : null,
      outstanding: paymentKnown || invoice.status === 'paid' ? owed : null,
      dueDate: invoice.dueDate,
      overdue: owed > 0 && !!invoice.dueDate && invoice.dueDate.getTime() < now.getTime(),
      cost: typeof invoice.cost === 'number' ? invoice.cost : null,
      marginPct: typeof invoice.cost === 'number' && invoice.value > 0 ? marginPctOf(invoice.value, invoice.cost) : null,
      quotationNumber: quotation?.number,
    };
  });

  // -- email: did they answer us, do we owe them an answer
  const mailCount = email.received + email.sent;
  const heardSince = !!email.lastReceivedAt && (!email.lastSentAt || email.lastReceivedAt.getTime() > email.lastSentAt.getTime());
  const quietDays = email.lastSentAt ? days(email.lastSentAt, now) : 0;
  const contactedSinceEnquiry = !!email.lastSentAt && (!latestEnquiry?.date || email.lastSentAt.getTime() >= latestEnquiry.date.getTime() - DAY_MS);
  const emailStatus: EmailState =
    email.unanswered > 0
      ? 'reply_needed'
      : mailCount === 0
        ? openMatter && email.hasAddress
          ? 'not_contacted'
          : 'none'
        : heardSince
          ? 'replied'
          : openMatter && quietDays > FOLLOW_UP_AFTER_DAYS
            ? 'follow_up'
            : 'not_replied';

  // -- where they stand in the pipeline
  const latestDealAt = Math.max(0, ...input.deals.map((d) => time(d.date)));
  const allDealsLost = input.deals.length > 0 && input.deals.every((d) => d.status === 'lost');
  const decided = quotations.filter((q) => q.state === 'accepted' || q.state === 'rejected');
  const allQuotesRejected = decided.length > 0 && decided.every((q) => q.state === 'rejected') && openQuotes.length === 0;
  const lost =
    orders.length === 0 && (allDealsLost || allQuotesRejected) && !(enquiryOpen && time(latestEnquiry?.date) > Math.max(latestDealAt, time(quotes[0]?.date)));
  const crmStatus: CrmState =
    orders.length > 0 ? 'customer' : lost ? 'lost' : quotes.length > 0 || input.deals.some((d) => d.status === 'open') ? 'opportunity' : 'lead';

  const orderStatus: OrderState =
    orders.length === 0 ? (enquiries.length + quotes.length + input.deals.length > 0 ? 'not_converted' : 'none') : openMatter ? 'previous_order' : 'converted';

  // -- what needs doing, most pressing first. Each reminder knows which step it belongs to (so a step the
  // team settled by hand can stop it), and whether it is a chase: something to follow up, not something new.
  const actions: (ProfileAction & { steps: StageKey[]; chase?: boolean })[] = [];
  if (email.unanswered > 0) {
    const waited = email.oldestUnansweredAt ? days(email.oldestUnansweredAt, now) : 0;
    actions.push({
      urgency: waited >= 1 ? 'overdue' : 'today',
      title: 'Reply to the customer',
      detail: `${email.unanswered === 1 ? 'An email from them is' : `${email.unanswered} emails from them are`} waiting for an answer${waited >= 1 ? ` — the oldest for ${plural(waited, 'day')}` : ''}.`,
      steps: ['email'],
    });
  }
  if (paymentStatus === 'overdue') {
    const oldestDue = overdueOrders.map((o) => o.dueDate!).sort((a, b) => a.getTime() - b.getTime())[0];
    actions.push({
      urgency: 'overdue',
      title: 'Request payment — overdue',
      detail: `${money(overdueAmount)} is ${plural(days(oldestDue, now), 'day')} past its due date.`,
      steps: ['payment'],
    });
  }
  if (openQuotes.length > 0) {
    const latest = openQuotes[0];
    const waited = latest.date ? days(latest.date, now) : 0;
    const answered = !!latest.date && !!email.lastReceivedAt && email.lastReceivedAt.getTime() > latest.date.getTime();
    if (waited > FOLLOW_UP_AFTER_DAYS && !answered) {
      actions.push({
        urgency: 'today',
        title: 'Follow up on the quotation',
        detail: `${latest.number ? `Quotation ${latest.number}` : 'The quotation'} for ${money(latest.amount)} was sent ${ago(latest.date!, now)} and there is no decision yet.`,
        steps: ['quote'],
        chase: true,
      });
    }
  }
  if (enquiryOpen && !quotedSinceEnquiry && email.unanswered === 0) {
    const age = latestEnquiry.date ? days(latestEnquiry.date, now) : null;
    if (!contactedSinceEnquiry) {
      if (age !== null && age > NEW_ENQUIRY_DAYS) {
        actions.push({
          urgency: 'overdue',
          title: 'Contact the customer',
          detail: `They enquired ${plural(age, 'day')} ago and nobody has written back yet.`,
          steps: ['inquiry'],
          chase: true,
        });
      } else {
        actions.push({ urgency: 'today', title: 'Respond to the inquiry', detail: 'A new inquiry — nobody has written back yet.', steps: ['inquiry'] });
      }
    } else if (!heardSince && quietDays > FOLLOW_UP_AFTER_DAYS) {
      actions.push({
        urgency: 'today',
        title: 'Follow up',
        detail: `You wrote ${plural(quietDays, 'day')} ago and they haven’t replied.`,
        steps: ['inquiry', 'email'],
        chase: true,
      });
    }
  }
  if (draftQuotes.length > 0 && openQuotes.length === 0 && time(draftQuotes[0].date) > time(lastOrderAt)) {
    actions.push({
      urgency: 'soon',
      title: 'Send the quotation',
      detail: `${draftQuotes[0].number ? `Quotation ${draftQuotes[0].number}` : 'A quotation'} is still a draft.`,
      steps: ['quote'],
    });
  }
  if (paymentStatus === 'unpaid' || paymentStatus === 'partially_paid') {
    actions.push({ urgency: 'soon', title: 'Collect payment', detail: `${money(outstandingTotal)} is outstanding.`, steps: ['payment'] });
  }
  // -- what the team set itself to do: reminders on their emails, and its own tasks. Judged by the day, not the hour.
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const pendingFollowUps = [...(input.followUps ?? [])].sort((a, b) => (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity));
  const overdueFollowUps = pendingFollowUps.filter((f) => f.dueDate && dayOf(f.dueDate) < dayStart);
  const todayFollowUps = pendingFollowUps.filter((f) => f.dueDate && dayOf(f.dueDate) === dayStart);
  const followUpStatus: FollowUpState = overdueFollowUps.length ? 'overdue' : todayFollowUps.length ? 'today' : pendingFollowUps.length ? 'upcoming' : 'none';
  const nextFollowUp = pendingFollowUps[0];
  // What the team set itself to do is never silenced by a status: it is theirs to tick off.
  if (followUpStatus === 'overdue') {
    const late = Math.round((dayStart - dayOf(overdueFollowUps[0].dueDate!)) / DAY_MS);
    actions.push({
      urgency: 'overdue',
      title: 'Do the follow-up',
      detail: `“${clip(overdueFollowUps[0].title, 80)}” was due ${late <= 1 ? 'yesterday' : `${late} days ago`}.`,
      steps: [],
      chase: true,
    });
  } else if (followUpStatus === 'today') {
    actions.push({ urgency: 'today', title: 'Follow up today', detail: `“${clip(todayFollowUps[0].title, 80)}” is due today.`, steps: [], chase: true });
  }

  // -- statuses the team set by hand. Each replaces what the systems say for its step, and the reminders
  // follow: a settled step asks for nothing, a step marked as needing action asks for it.
  const chosen = (key: StageKey) => {
    const override = input.overrides?.[key];
    const choice = override && STAGE_OPTIONS[key].find((o) => o.status === override.status);
    return override && choice ? { ...override, choice } : undefined;
  };
  const set = {
    inquiry: chosen('inquiry'),
    quote: chosen('quote'),
    order: chosen('order'),
    payment: chosen('payment'),
    email: chosen('email'),
    // "No follow-up needed" can't stand while one is waiting to be done.
    followUp: pendingFollowUps.length > 0 ? undefined : chosen('followUp'),
  };
  const settled = (key: StageKey) => !!set[key]?.choice.settles;
  const inquiryClosed = !!set.inquiry && INQUIRY_CLOSED.includes(set.inquiry.status);
  // Where the team says something else than the systems about payment or email, its word replaces theirs:
  // the systems' reminder for that step goes, and the team's status brings its own (below).
  const replaced = { payment: !!set.payment && set.payment.status !== paymentStatus, email: !!set.email && set.email.status !== emailStatus };
  const pending = actions.filter(
    (a) =>
      !a.steps.some(settled) &&
      !(a.chase && a.steps.length > 0 && settled('followUp')) &&
      !(inquiryClosed && a.steps.includes('inquiry')) &&
      !(replaced.payment && a.steps.includes('payment')) &&
      !(replaced.email && a.steps.includes('email')),
  );
  const byTeam = (label: string) => `Marked “${label}” by your team.`;
  if (set.email?.status === 'reply_needed' && !pending.some((a) => a.steps.includes('email')))
    pending.push({ urgency: 'today', title: 'Reply to the customer', detail: byTeam(set.email.choice.label), steps: ['email'] });
  if (set.email?.status === 'follow_up' && !pending.some((a) => a.chase))
    pending.push({ urgency: 'today', title: 'Follow up', detail: byTeam(set.email.choice.label), steps: ['email'], chase: true });
  if (set.payment && !set.payment.choice.settles && !pending.some((a) => a.steps.includes('payment')))
    pending.push({
      urgency: set.payment.status === 'overdue' ? 'overdue' : 'soon',
      title: set.payment.status === 'overdue' ? 'Request payment — overdue' : 'Collect payment',
      detail: byTeam(set.payment.choice.label),
      steps: ['payment'],
    });

  const rank = { overdue: 0, today: 1, soon: 2, none: 3 };
  pending.sort((a, b) => rank[a.urgency] - rank[b.urgency]);
  const quotePending = set.quote ? set.quote.status === 'sent' : openQuotes.length > 0;
  const nextAction: ProfileAction = pending[0]
    ? { urgency: pending[0].urgency, title: pending[0].title, detail: pending[0].detail }
    : {
        urgency: 'none',
        title: 'Nothing needed right now',
        detail: quotePending ? 'A quotation is with the customer and it is too early to chase.' : 'Nothing is waiting on you for this customer.',
      };

  const flags: CustomerFlag[] = [];
  if (set.email ? set.email.status === 'reply_needed' : email.unanswered > 0) flags.push('reply_needed');
  if (pending.some((a) => a.chase) || (!set.email && emailStatus === 'follow_up' && !settled('followUp'))) flags.push('follow_up_required');
  if (quotePending) flags.push('quote_pending');
  const paymentNow = set.payment?.status ?? paymentStatus;
  if (paymentNow === 'overdue') flags.push('payment_overdue');
  else if (paymentNow === 'unpaid' || paymentNow === 'partially_paid') flags.push('payment_pending');
  // An inquiry the team is still working, or closed, by hand: that is what "open" means for it.
  const inquiryOpen = set.inquiry ? !inquiryClosed : enquiryOpen;

  // -- what happened, in order
  const events: TimelineEvent[] = [];
  for (const contact of input.contacts ?? []) {
    if (contact.date) events.push({ at: contact.date, kind: 'contact', title: 'Added as a contact', detail: contact.source ? `In ${contact.source}` : undefined });
  }
  for (const [index, enquiry] of enquiries.entries()) {
    if (enquiry.date) events.push({ at: enquiry.date, kind: 'enquiry', title: index === 0 ? 'Inquiry received' : 'Earlier inquiry', detail: enquiry.summary });
  }
  // A deal is on the timeline only when no quotation or invoice already tells its story.
  const documentedDeals = new Set([...quotes.map((q) => q.dealId), ...invoices.map((i) => i.dealId)].filter(Boolean));
  for (const deal of input.deals) {
    if (!deal.date || documentedDeals.has(deal.id)) continue;
    events.push({
      at: deal.date,
      kind: 'deal',
      title: deal.status === 'won' ? 'Deal won' : deal.status === 'lost' ? 'Deal lost' : 'Deal opened',
      detail: deal.name,
      amount: deal.value || undefined,
    });
  }
  for (const q of quotations) {
    if (!q.date) continue;
    const verb =
      q.state === 'accepted'
        ? 'accepted'
        : q.state === 'rejected'
          ? 'rejected'
          : q.state === 'draft'
            ? 'drafted'
            : q.state === 'expired'
              ? 'sent (now expired)'
              : 'sent';
    events.push({
      at: q.date,
      kind: 'quotation',
      title: `${q.number ? `Quotation ${q.number}` : 'Quotation'} ${verb}`,
      detail: q.name,
      amount: q.amount,
      attention: q.state === 'sent',
    });
  }
  for (const invoice of invoiceList) {
    if (!invoice.date) continue;
    events.push({
      at: invoice.date,
      kind: 'order',
      title: `${invoice.number ? `Invoice ${invoice.number}` : 'Invoice'} ${invoice.status === 'draft' ? 'drafted' : invoice.status === 'paid' ? 'paid' : 'raised'}`,
      amount: invoice.amount,
    });
  }
  for (const payment of input.payments) {
    const quotation = quoteById.get(payment.quotationId);
    events.push({
      at: payment.date,
      kind: 'payment',
      title: 'Payment received',
      detail: quotation?.number ? `Against quotation ${quotation.number}` : undefined,
      amount: payment.amount,
    });
  }

  // -- the latest thing that happened, mail included
  const happened: { at: Date; label: string }[] = events.filter((e) => e.at.getTime() <= now.getTime()).map((e) => ({ at: e.at, label: e.title }));
  if (email.lastReceivedAt) happened.push({ at: email.lastReceivedAt, label: 'Email from the customer' });
  if (email.lastSentAt) happened.push({ at: email.lastSentAt, label: 'Email sent to the customer' });
  const lastActivity = happened.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
  const daysSinceLastActivity = lastActivity ? days(lastActivity.at, now) : null;
  const active = daysSinceLastActivity !== null && daysSinceLastActivity <= INACTIVE_AFTER_DAYS;

  // -- previous order against the current one
  const comparison = compare(orders, openQuotes[0] ?? draftQuotes.find((q) => time(q.date) > time(lastOrderAt)), money);

  // -- what is missing, and what disagrees
  const gaps: string[] = [];
  if (!email.hasAddress) gaps.push('No email address is on record, so email with this customer can’t be matched to them.');
  for (const deal of wonWithoutPaperwork.slice(0, 3))
    gaps.push(`${deal.name ? `The deal “${deal.name}”` : 'A deal'} is marked won, but no accepted quotation or invoice is linked to it.`);
  const acceptedNoInvoice = quotes.filter((q) => q.state === 'accepted' && !invoiceByQuote.has(q.id));
  if (acceptedNoInvoice.length > 0)
    gaps.push(`${plural(acceptedNoInvoice.length, 'accepted quotation')} ${acceptedNoInvoice.length === 1 ? 'has' : 'have'} no invoice yet.`);
  const draftInvoices = invoices.filter((i) => i.status === 'draft');
  if (draftInvoices.length > 0) gaps.push(`${plural(draftInvoices.length, 'invoice')} ${draftInvoices.length === 1 ? 'is' : 'are'} still a draft.`);
  if (paymentStatus === 'not_recorded') gaps.push('No payment is recorded against their orders, so what they have paid isn’t known.');
  if (billable.length > 0 && billable.every((o) => !o.dueDate)) gaps.push('No payment due date is recorded, so overdue amounts can’t be worked out.');
  if (orders.length > 0 && orders.every((o) => o.cost === null)) gaps.push('No cost is recorded on any order, so the margin isn’t known.');
  if (allDealsLost && openQuotes.length > 0) gaps.push('Their deal is marked lost, but a quotation is still open with them.');

  // -- the whole picture in a few sentences
  const sentences: string[] = [];
  sentences.push(
    type === 'new'
      ? enquiryOpen
        ? `New lead — enquired ${latestEnquiry.date ? ago(latestEnquiry.date, now) : 'recently'}.`
        : quotes.length > 0
          ? 'New customer — no order yet.'
          : 'New contact with no order yet.'
      : `${TYPE_LABEL[type]} customer with ${plural(orders.length, 'order')} worth ${money(ordersTotal)}${enquiryOpen && latestEnquiry.date ? `; enquired again ${ago(latestEnquiry.date, now)}` : ''}.`,
  );
  // What the systems say about a step is left out where the team has said otherwise by hand.
  if (!set.quote && !set.inquiry) {
    if (openQuotes.length > 0) {
      const q = openQuotes[0];
      sentences.push(
        `${q.number ? `Quotation ${q.number}` : 'A quotation'} for ${money(q.amount)} was sent ${q.date ? ago(q.date, now) : 'earlier'} and is awaiting their decision.`,
      );
    } else if (enquiryOpen && !quotedSinceEnquiry) {
      sentences.push('No quotation has been sent for this inquiry yet.');
    }
  }
  if (!set.payment) {
    if (paymentStatus === 'overdue') sentences.push(`${money(overdueAmount)} is overdue.`);
    else if (paymentStatus === 'unpaid' || paymentStatus === 'partially_paid')
      sentences.push(`${money(outstandingTotal)} of ${money(billed)} is still unpaid.`);
    else if (paymentStatus === 'paid') sentences.push('Everything billed has been paid.');
  }
  if (!set.email) {
    if (emailStatus === 'reply_needed')
      sentences.push(`${plural(email.unanswered, 'email')} from them ${email.unanswered === 1 ? 'is' : 'are'} waiting for a reply.`);
    else if (emailStatus === 'follow_up') sentences.push(`They have not answered our last email, sent ${plural(quietDays, 'day')} ago.`);
    else if (emailStatus === 'not_contacted') sentences.push('Nobody has emailed them yet.');
    else if (emailStatus === 'replied' && email.lastReceivedAt && openMatter) sentences.push(`They last wrote ${ago(email.lastReceivedAt, now)}.`);
  }

  // -- the six steps, as the board shows them: where each stands, and one line of what is behind it.
  const more = (count: number) => (count > 1 ? ` · +${count - 1}` : '');
  const sentence = (value: string) => (value ? value[0].toUpperCase() + value.slice(1) : undefined);
  const latestQuote = quotations[0];
  const isNew = !!latestEnquiry?.date && days(latestEnquiry.date, now) <= NEW_ENQUIRY_DAYS;
  const automatic: Stage[] = [
    latestEnquiry
      ? {
          key: 'inquiry',
          title: 'Inquiry',
          status: !enquiryOpen ? 'converted' : isNew ? 'new' : 'open',
          label: !enquiryOpen ? 'Converted' : isNew ? 'New' : 'Open',
          tone: enquiryOpen ? 'progress' : 'done',
          detail: sentence(
            [latestEnquiry.date ? ago(latestEnquiry.date, now) : '', latestEnquiry.channel ?? ''].filter(Boolean).join(' · ') + more(enquiries.length),
          ),
        }
      : { key: 'inquiry', title: 'Inquiry', status: 'none', label: 'No inquiry', tone: 'none' },
    latestQuote
      ? {
          key: 'quote',
          title: 'Quote',
          status: latestQuote.state,
          label: latestQuote.stateLabel,
          tone: QUOTE_TONE[latestQuote.state],
          detail: `${latestQuote.number ?? 'Quotation'} · ${money(latestQuote.amount)}${more(quotations.length)}`,
        }
      : { key: 'quote', title: 'Quote', status: 'none', label: 'No quote', tone: 'none' },
    {
      key: 'order',
      title: 'Order',
      status: orderStatus,
      label: ORDER_CHIP[orderStatus],
      tone: ORDER_TONE[orderStatus],
      detail: orders.length > 0 ? `${plural(orders.length, 'order')} · ${money(ordersTotal)}` : undefined,
    },
    {
      key: 'payment',
      title: 'Payment',
      status: paymentStatus,
      label: PAYMENT_CHIP[paymentStatus],
      tone: PAYMENT_TONE[paymentStatus],
      detail:
        paymentStatus === 'nothing_due'
          ? undefined
          : paymentStatus === 'not_recorded'
            ? `${money(billed)} billed`
            : outstandingTotal > 0
              ? `${money(outstandingTotal)} due`
              : `${money(paidTotal)} paid`,
    },
    {
      key: 'email',
      title: 'Email',
      status: emailStatus,
      label: EMAIL_CHIP[emailStatus],
      tone: EMAIL_TONE[emailStatus],
      detail: mailCount > 0 ? `${email.received} in · ${email.sent} out` : undefined,
    },
    {
      key: 'followUp',
      title: 'Follow-up',
      status: followUpStatus,
      label: followUpStatus === 'upcoming' && !nextFollowUp?.dueDate ? 'To do' : FOLLOW_UP_LABEL[followUpStatus],
      tone: FOLLOW_UP_TONE[followUpStatus],
      detail: nextFollowUp
        ? `${clip(nextFollowUp.title, 36)}${followUpStatus === 'upcoming' && nextFollowUp.dueDate ? ` · ${shortDate(nextFollowUp.dueDate)}` : ''}${more(pendingFollowUps.length)}`
        : undefined,
    },
  ];
  // A step set by hand shows the team's status, and under it who set it and when — not a figure that may now disagree.
  const stages: Stage[] = automatic.map((stage) => {
    const mine = set[stage.key];
    if (!mine) return stage;
    return {
      key: stage.key,
      title: stage.title,
      status: mine.status,
      label: mine.choice.short ?? mine.choice.label,
      tone: mine.choice.tone,
      detail: `Set by ${mine.by ? clip(mine.by, 18) : 'your team'}${mine.at ? ` · ${shortDate(mine.at)}` : ''}`,
      manual: { label: mine.choice.label, by: mine.by, at: mine.at, automatic: stage.label },
    };
  });
  const byHand = stages.filter((s) => s.manual).map((s) => `${s.title} — ${s.manual!.label}`);
  if (byHand.length > 0) sentences.unshift(`Set by your team: ${byHand.join(', ')}.`);

  return {
    currency,
    type,
    typeLabel: TYPE_LABEL[type],
    typeReason,
    active,
    lastActivity,
    daysSinceLastActivity,
    owner: input.owner || undefined,
    inquiries: {
      count: enquiries.length,
      latestAt: latestEnquiry?.date,
      latestSummary: latestEnquiry?.summary,
      open: inquiryOpen,
      // Anything done about the latest inquiry: an email or a quotation since, or a status the team set by hand.
      actioned: !latestEnquiry || contactedSinceEnquiry || quotedSinceEnquiry || (!!set.inquiry && set.inquiry.status !== 'new'),
      channel: latestEnquiry?.channel,
      location: latestEnquiry?.location,
    },
    quotes: {
      count: quotations.length,
      openCount: openQuotes.length,
      openValue: openQuotes.reduce((sum, q) => sum + q.amount, 0),
      latest: quotations[0] ?? null,
    },
    invoices: { count: invoiceList.length, total: invoiceList.reduce((sum, i) => sum + i.amount, 0), latest: invoiceList[0] ?? null },
    payment: {
      status: paymentStatus,
      label: PAYMENT_LABEL[paymentStatus],
      billed,
      paid: paymentStatus === 'not_recorded' ? null : paidTotal,
      outstanding: paymentStatus === 'not_recorded' ? null : outstandingTotal,
      overdueAmount,
    },
    orders: { status: orderStatus, label: ORDER_LABEL[orderStatus], count: orders.length, totalValue: ordersTotal, lastOrderAt },
    mail: {
      status: emailStatus,
      label: EMAIL_LABEL[emailStatus],
      received: email.received,
      sent: email.sent,
      unanswered: email.unanswered,
      lastReceivedAt: email.lastReceivedAt,
      lastSentAt: email.lastSentAt,
    },
    crm: { status: crmStatus, label: CRM_LABEL[crmStatus] },
    followUp: {
      status: followUpStatus,
      label: FOLLOW_UP_LABEL[followUpStatus],
      count: pendingFollowUps.length,
      nextAt: pendingFollowUps.find((f) => f.dueDate)?.dueDate,
      nextTitle: nextFollowUp?.title,
    },
    flags,
    nextAction,
    insight: sentences.join(' '),
    stages,
    quotations: quotations.slice(0, LIST_LIMIT),
    invoiceList: invoiceList.slice(0, LIST_LIMIT),
    comparison,
    gaps,
    events,
  };
}

/** The latest order against what is on the table now (an open quotation, else the order before it). */
function compare(orders: Order[], currentQuote: QuoteLine | undefined, money: (amount: number) => string): OrderComparison | null {
  const margin = (o: Order) => (o.cost !== null && o.value > 0 ? marginPctOf(o.value, o.cost) : null);
  let previous: OrderComparison['previous'];
  let current: OrderComparison['current'];
  if (currentQuote && orders.length > 0) {
    previous = { label: orders[0].label, date: orders[0].date, value: orders[0].value, marginPct: margin(orders[0]) };
    current = {
      label: currentQuote.number ? `Quotation ${currentQuote.number}` : 'Current quotation',
      date: currentQuote.date,
      value: currentQuote.amount,
      marginPct: null,
      isQuotation: true,
    };
  } else if (orders.length >= 2) {
    previous = { label: orders[1].label, date: orders[1].date, value: orders[1].value, marginPct: margin(orders[1]) };
    current = { label: orders[0].label, date: orders[0].date, value: orders[0].value, marginPct: margin(orders[0]), isQuotation: false };
  } else {
    return null;
  }
  const valueDifference = round2(current.value - previous.value);
  const marginDifference = previous.marginPct !== null && current.marginPct !== null ? Math.round((current.marginPct - previous.marginPct) * 10) / 10 : null;
  let note: string;
  if (previous.marginPct === null) {
    note = 'No cost is recorded for the previous order, so its margin — and a margin to aim for now — can’t be worked out. Enter the order’s cost to see it.';
  } else if (current.isQuotation) {
    // Holding the same margin on the new price means a cost no higher than this.
    note = `The previous order made a ${previous.marginPct}% margin. To match it on this quotation, its cost should be no more than ${money(round2(current.value * (1 - previous.marginPct / 100)))}.`;
  } else if (marginDifference === null) {
    note = `The previous order made a ${previous.marginPct}% margin. No cost is recorded for the latest order, so the two can’t be compared.`;
  } else {
    note =
      marginDifference === 0
        ? `Both orders made a ${previous.marginPct}% margin.`
        : `The latest order’s margin is ${Math.abs(marginDifference)} points ${marginDifference > 0 ? 'higher' : 'lower'} than the one before (${current.marginPct}% against ${previous.marginPct}%).`;
  }
  return {
    previous,
    current,
    valueDifference,
    valueDifferencePct: previous.value > 0 ? Math.round((valueDifference / previous.value) * 1000) / 10 : null,
    marginDifference,
    note,
  };
}

// How one customer's records hang together. An inquiry leads to a deal, the
// deal to a quotation, the quotation to an invoice, the invoice to payments —
// each held in a different system, or in different records of the same one.
// This lays them out as chains ("journeys") and gives every quotation and
// invoice a document view that names what it came from and what came of it.
//
// Pure: no database, no CRM, no AI. Links the records carry (an invoice's
// quotation, a quotation's deal) are followed as they are; an inquiry carries
// no link to anything, so it is placed by time — before the first quotation
// made after it — and marked as such.

import { InvoiceLine, QuoteLine, StageTone } from './customer-profile.builder';
import { formatAmount } from './customer-timeline';

const JOURNEY_LIMIT = 12;
const LINE_LIMIT = 60;
const SUMMARY_LIMIT = 140;

// A job is HaiVE's own: a quotation the team decided to produce (customer-jobs.service.ts).
export type RecordKind = 'inquiry' | 'deal' | 'quotation' | 'job' | 'invoice' | 'payment';

export interface JourneyStep {
  kind: RecordKind;
  title: string;
  detail?: string;
  at?: Date;
  tone: StageTone;
  /** The quotation or invoice this step opens, when it is one. */
  documentId?: string;
  /** The job this step opens, when it is one. */
  jobId?: string;
  /** Placed here by its date, not by a link the record carries. */
  byDate?: boolean;
}

export interface Journey {
  /** The latest thing in it — journeys are listed newest first. */
  at?: Date;
  steps: JourneyStep[];
}

export interface DocumentParty {
  company?: string;
  contact?: string;
  email?: string;
  phone?: string;
}

export interface DocumentLine {
  /** What is being sold. */
  description: string;
  /** More about it, in plain text, when the system holding it says more. */
  detail?: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

/** A tax or a fee added to a quotation on top of its items. */
export interface DocumentCharge {
  kind: 'tax' | 'fee';
  name: string;
  amount: number;
}

/** Where a document's items are held: on the document itself, or on the deal it was raised from. */
export type LinesFrom = 'document' | 'deal';

/** One quotation or invoice, with what it is connected to. */
export interface CustomerDocument {
  id: string;
  kind: 'quotation' | 'invoice';
  number?: string;
  title?: string;
  date?: Date;
  amount: number;
  status: string;
  tone: StageTone;
  owner?: string;
  /** The connected system it came from. */
  source?: string;
  /** A quotation's validity. */
  validUntil?: Date;
  /** When an invoice's payment is due. */
  dueDate?: Date;
  preparedFor: DocumentParty;
  /** Product lines, when the system that holds the document records them. */
  lines: DocumentLine[];
  /** The items alone, before tax and fees. Null when there are no items. */
  subtotal: number | null;
  charges: DocumentCharge[];
  linesFrom?: LinesFrom;
  /** Said when the items (with tax and fees) don't come to the document's amount — they are shown all the same. */
  linesNote?: string;
  /** Null when what was paid isn't recorded. */
  paid: number | null;
  outstanding: number | null;
  payments: { date: Date; amount: number }[];
  /** The other steps of its journey, in order. */
  links: JourneyStep[];
  /** The job a quotation was converted into, when it was. */
  job?: { id: string; number: string };
}

// ---- what goes in ---------------------------------------------------------------

export interface InquiryRecord {
  id: string;
  date?: Date;
  summary?: string;
  channel?: string;
  open: boolean;
}

export interface DealRecord {
  id: string;
  name?: string;
  date?: Date;
  value: number;
  status: 'open' | 'won' | 'lost';
}

export interface QuotationRecord {
  /** As the profile reads it today (an unanswered quotation past its validity is expired). */
  line: QuoteLine;
  dealId?: string;
  source?: string;
  preparedFor: DocumentParty;
  lines: DocumentLine[];
  /** Where those lines are held. Some CRMs keep them on the deal, not on the quotation raised from it. */
  linesFrom?: LinesFrom;
  charges?: DocumentCharge[];
  payments: { date: Date; amount: number }[];
  /** The job it was converted into. */
  job?: { id: string; number: string; done: boolean };
}

export interface InvoiceRecord {
  line: InvoiceLine;
  quotationId?: string;
  dealId?: string;
  source?: string;
  preparedFor: DocumentParty;
}

export interface DocumentsInput {
  currency: string;
  inquiries: InquiryRecord[];
  deals: DealRecord[];
  quotations: QuotationRecord[];
  invoices: InvoiceRecord[];
}

const QUOTE_TONE: Record<QuoteLine['state'], StageTone> = { draft: 'waiting', sent: 'progress', accepted: 'done', rejected: 'muted', expired: 'attention' };
const DEAL_TONE: Record<DealRecord['status'], StageTone> = { open: 'progress', won: 'done', lost: 'muted' };
const DEAL_TITLE: Record<DealRecord['status'], string> = { open: 'Deal open', won: 'Deal won', lost: 'Deal lost' };

const time = (date?: Date) => date?.getTime() ?? 0;
const round2 = (value: number) => Math.round(value * 100) / 100;
const clip = (value: string | undefined, max: number) => (value && value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

export function buildCustomerDocuments(input: DocumentsInput): { journeys: Journey[]; documents: CustomerDocument[] } {
  const money = (amount: number) => formatAmount(amount, input.currency);
  const oldestFirst = <T>(rows: T[], at: (row: T) => Date | undefined) => [...rows].sort((a, b) => time(at(a)) - time(at(b)));
  const dealById = new Map(input.deals.map((d) => [d.id, d]));
  const quotations = oldestFirst(input.quotations, (q) => q.line.date);
  const quotationById = new Map(quotations.map((q) => [q.line.id, q]));
  const invoicesByQuotation = new Map<string, InvoiceRecord[]>();
  for (const invoice of input.invoices) {
    if (!invoice.quotationId || !quotationById.has(invoice.quotationId)) continue;
    if (!invoicesByQuotation.has(invoice.quotationId)) invoicesByQuotation.set(invoice.quotationId, []);
    invoicesByQuotation.get(invoice.quotationId)!.push(invoice);
  }

  // An inquiry belongs before the first quotation made after it; several inquiries before one quotation all led to it.
  const inquiriesBefore = new Map<string, InquiryRecord[]>();
  const unplaced: InquiryRecord[] = [];
  for (const inquiry of oldestFirst(input.inquiries, (i) => i.date)) {
    const next = inquiry.date ? quotations.find((q) => time(q.line.date) >= inquiry.date!.getTime()) : undefined;
    if (!next) {
      unplaced.push(inquiry);
      continue;
    }
    if (!inquiriesBefore.has(next.line.id)) inquiriesBefore.set(next.line.id, []);
    inquiriesBefore.get(next.line.id)!.push(inquiry);
  }

  const inquiryStep = (inquiry: InquiryRecord, byDate: boolean): JourneyStep => ({
    kind: 'inquiry',
    title: 'Inquiry',
    detail: clip(inquiry.summary, SUMMARY_LIMIT) ?? inquiry.channel,
    at: inquiry.date,
    tone: inquiry.open ? 'progress' : 'done',
    ...(byDate ? { byDate: true } : {}),
  });
  const dealStep = (deal: DealRecord): JourneyStep => ({
    kind: 'deal',
    title: DEAL_TITLE[deal.status],
    detail: [deal.name, deal.value > 0 ? money(deal.value) : ''].filter(Boolean).join(' · ') || undefined,
    at: deal.date,
    tone: DEAL_TONE[deal.status],
  });
  const quotationStep = ({ line }: QuotationRecord): JourneyStep => ({
    kind: 'quotation',
    title: line.number ? `Quotation ${line.number}` : 'Quotation',
    detail: `${line.stateLabel} · ${money(line.amount)}`,
    at: line.date,
    tone: QUOTE_TONE[line.state],
    documentId: line.id,
  });
  const invoiceStep = ({ line }: InvoiceRecord): JourneyStep => ({
    kind: 'invoice',
    title: line.number ? `Invoice ${line.number}` : 'Invoice',
    detail: `${line.overdue ? 'Overdue' : line.statusLabel} · ${money(line.amount)}`,
    at: line.date,
    tone: line.overdue ? 'attention' : line.status === 'paid' ? 'done' : line.status === 'invoiced' ? 'progress' : 'waiting',
    documentId: line.id,
  });
  // What was paid against an invoice — or, said plainly, that it isn't recorded.
  const paymentStep = (invoice: InvoiceRecord, payments: { date: Date; amount: number }[]): JourneyStep => {
    const { line } = invoice;
    const last = [...payments].sort((a, b) => b.date.getTime() - a.date.getTime())[0];
    if (line.paid === null) return { kind: 'payment', title: 'Payment', detail: 'Not recorded', tone: 'muted' };
    if (line.outstanding !== null && line.outstanding <= 0)
      return { kind: 'payment', title: 'Payment', detail: `Paid · ${money(line.paid)}`, at: last?.date, tone: 'done' };
    return {
      kind: 'payment',
      title: 'Payment',
      detail: line.paid > 0 ? `${money(line.paid)} paid · ${money(line.outstanding ?? 0)} due` : `${money(line.outstanding ?? line.amount)} due`,
      at: last?.date,
      tone: line.overdue ? 'attention' : 'waiting',
    };
  };

  const journeys: Journey[] = [];
  const usedDeals = new Set<string>();
  const usedInvoices = new Set<string>();
  for (const quotation of quotations) {
    const steps: JourneyStep[] = (inquiriesBefore.get(quotation.line.id) ?? []).map((inquiry) => inquiryStep(inquiry, true));
    const deal = quotation.dealId ? dealById.get(quotation.dealId) : undefined;
    // Several quotations can hang off one deal: it is named in each of their journeys.
    if (deal) {
      usedDeals.add(deal.id);
      steps.push(dealStep(deal));
    }
    steps.push(quotationStep(quotation));
    // The quotation the team decided to produce: its job comes next.
    if (quotation.job)
      steps.push({
        kind: 'job',
        title: `Job ${quotation.job.number}`,
        detail: quotation.job.done ? 'Done' : 'In progress',
        tone: quotation.job.done ? 'done' : 'progress',
        jobId: quotation.job.id,
      });
    for (const invoice of oldestFirst(invoicesByQuotation.get(quotation.line.id) ?? [], (i) => i.line.date)) {
      usedInvoices.add(invoice.line.id);
      steps.push(invoiceStep(invoice), paymentStep(invoice, quotation.payments));
    }
    journeys.push({ steps });
  }
  // An invoice with no quotation among the records is a journey of its own, with its deal when it names one.
  for (const invoice of input.invoices) {
    if (usedInvoices.has(invoice.line.id)) continue;
    const deal = invoice.dealId ? dealById.get(invoice.dealId) : undefined;
    if (deal) usedDeals.add(deal.id);
    journeys.push({ steps: [...(deal ? [dealStep(deal)] : []), invoiceStep(invoice), paymentStep(invoice, [])] });
  }
  for (const deal of input.deals) if (!usedDeals.has(deal.id)) journeys.push({ steps: [dealStep(deal)] });
  // Inquiries no quotation has followed yet: where the next journey starts.
  for (const inquiry of unplaced) journeys.push({ steps: [inquiryStep(inquiry, false)] });

  for (const journey of journeys) journey.at = new Date(Math.max(0, ...journey.steps.map((s) => time(s.at))));
  journeys.sort((a, b) => time(b.at) - time(a.at));

  const linksOf = (id: string) => journeys.find((j) => j.steps.some((s) => s.documentId === id))?.steps.filter((s) => s.documentId !== id) ?? [];
  // A document's items, its tax and fees, and — when together they don't come to its amount — a plain
  // note saying so. The items are shown either way: a deal may have been changed since it was quoted.
  const itemsOf = (what: 'quotation' | 'invoice', amount: number, quotation: QuotationRecord | undefined) => {
    const lines = (quotation?.lines ?? []).slice(0, LINE_LIMIT);
    const charges = lines.length > 0 ? (quotation?.charges ?? []).filter((c) => c.amount !== 0) : [];
    if (lines.length === 0) return { lines, charges, subtotal: null };
    const subtotal = round2(lines.reduce((sum, l) => sum + l.total, 0));
    const withCharges = round2(subtotal + charges.reduce((sum, c) => sum + c.amount, 0));
    const near = (a: number) => Math.abs(a - amount) <= Math.max(1, Math.abs(amount) * 0.005);
    const linesFrom = quotation?.linesFrom ?? 'document';
    const linesNote =
      near(withCharges) || near(subtotal)
        ? undefined
        : linesFrom === 'deal'
          ? `These are the products on the deal${quotation?.source ? ` in ${quotation.source}` : ''} today. ${charges.length > 0 ? 'With tax and fees they' : 'They'} come to ${money(withCharges)}, not this ${what}’s ${money(amount)} — the deal may have been changed since, or priced differently.`
          : `${charges.length > 0 ? 'With tax and fees the items' : 'The items'} come to ${money(withCharges)}, not this ${what}’s ${money(amount)}.`;
    return { lines, charges, subtotal, linesFrom, ...(linesNote ? { linesNote } : {}) };
  };
  const documents: CustomerDocument[] = [
    ...input.quotations.map((quotation): CustomerDocument => {
      const { line, source, preparedFor, payments } = quotation;
      return {
        id: line.id,
        kind: 'quotation',
        number: line.number,
        title: line.name,
        date: line.date,
        amount: line.amount,
        status: line.stateLabel,
        tone: QUOTE_TONE[line.state],
        owner: line.owner,
        source,
        validUntil: line.expiresAt,
        preparedFor,
        ...itemsOf('quotation', line.amount, quotation),
        paid: null,
        outstanding: null,
        payments,
        links: linksOf(line.id),
        ...(quotation.job ? { job: { id: quotation.job.id, number: quotation.job.number } } : {}),
      };
    }),
    ...input.invoices.map((invoice): CustomerDocument => {
      const { line, source, preparedFor, quotationId } = invoice;
      const quotation = quotationId ? quotationById.get(quotationId) : undefined;
      return {
        id: line.id,
        kind: 'invoice',
        number: line.number,
        date: line.date,
        amount: line.amount,
        status: line.overdue ? 'Overdue' : line.statusLabel,
        tone: invoiceStep(invoice).tone,
        owner: quotation?.line.owner,
        source: source ?? quotation?.source,
        dueDate: line.dueDate,
        // An invoice raised from a quotation is for whoever the quotation was prepared for, when it doesn't say itself.
        preparedFor: Object.values(preparedFor).some(Boolean) ? preparedFor : (quotation?.preparedFor ?? {}),
        // An invoice is for what its quotation offered.
        ...itemsOf('invoice', line.amount, quotation),
        paid: line.paid,
        outstanding: line.outstanding,
        payments: quotation?.payments ?? [],
        links: linksOf(line.id),
      };
    }),
  ].sort((a, b) => time(b.date) - time(a.date));

  return { journeys: journeys.slice(0, JOURNEY_LIMIT), documents };
}

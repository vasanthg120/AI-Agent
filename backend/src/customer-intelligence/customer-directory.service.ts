import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'crypto';
import { Parser } from 'json2csv';
import { Connection } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ReservationService } from '../billing/reservation.service';
import { heuristicBusinessName } from '../crm/customer-grouping.util';
import { DataSourcesService } from '../data-sources/data-sources.service';
import { CRM_PROVIDERS } from '../data-sources/provider-catalog';
import { buildCustomerDocuments, CustomerDocument, DocumentCharge, DocumentParty, Journey } from './customer-documents';
import { CustomerMailService, EmailSummary } from './customer-mail.service';
import { emailReplySpeeds, emailTimelineEvents, followUpTimelineEvents, TimelineEvent } from './customer-timeline';
import { ENQUIRY_PROVIDERS, NamedValue, normalizeEnquiry } from './enquiry-normalizers';
import { clusterCustomers, companyKey, emailKey, MatchIdentity, phoneKey } from './customer-matching';
import {
  buildCustomerProfile,
  CustomerProfile,
  CustomerSummary,
  InvoiceLine,
  OrderComparison,
  ProfileContact,
  ProfileDeal,
  ProfileEnquiry,
  ProfileFollowUp,
  ProfileInvoice,
  ProfilePayment,
  ProfileQuotation,
  QuoteLine,
  STAGE_OPTIONS,
  STAGE_TITLE,
  StageKey,
  StageOverride,
  StageTone,
} from './customer-profile.builder';

const CACHE_TTL_MS = 60_000;
const MAX_RECORDS = 20_000;
const MESSAGE_PREVIEW = 180;
const TIMELINE_LIMIT = 80;
// HaiVE's own workspace is a data source too, but not a connected CRM — it is offered only when it holds customers.
const BUILT_IN_PROVIDER = 'haive_native';
// What the team attaches to a customer — comments, tasks, files (customer-workspace.service.ts writes them).
// Each is stored against the customer's identity keys, never against one CRM record.
export const NOTES_COLLECTION = 'customer_notes';
export const TASKS_COLLECTION = 'customer_tasks';
export const FILES_BUCKET = 'customer_files';
/** Statuses the team set by hand: one record per customer, a status per step, and who changed what. */
export const STATUSES_COLLECTION = 'customer_statuses';
/** Jobs: quotations the team decided to produce (customer-jobs.service.ts writes them). */
export const JOBS_COLLECTION = 'customer_jobs';
const WORKSPACE_EVENT_LIMIT = 100;
const EMAIL_LIST_LIMIT = 60;
const PEOPLE_LIMIT = 10;

type Doc = Record<string, any>;

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
const lower = (value: unknown): string => text(value).toLowerCase();
const amount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0);
const asDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
};
const time = (date?: Date) => date?.getTime() ?? 0;

export interface CustomerSource {
  id: string;
  label: string;
  /** Customers with at least one record from this source. */
  customers: number;
  connected: boolean;
  /** Whether "Sync now" can pull from it. */
  canSync: boolean;
  lastSyncAt?: Date;
  /** Why the last sync failed, when it did — the table then shows the last successful one. */
  lastError?: string;
}

export interface CustomerRow extends CustomerSummary {
  id: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  /** The connected systems this customer's records came from. */
  sources: string[];
  /** The jobs made from their quotations, newest first. */
  jobs: { id: string; number: string }[];
  /** The saved AI summary, when one was written and nothing has changed since. */
  aiSummary?: string;
}

export interface CustomerAnalysis {
  statusLabel: string;
  summary: string;
  nextAction: string;
  recommendations: string[];
  issues: string[];
  pricingAdvice: string;
  suggestedMessage: string;
  generatedAt: Date;
  // The facts changed since this was written (a new email, a quotation, a payment…).
  stale: boolean;
}

/** Somebody the customer's records name, with how to reach them. */
export interface CustomerPerson {
  name?: string;
  email?: string;
  phone?: string;
}

/** One email exchanged with the customer, for the panel's list. */
export interface CustomerEmail {
  id: string;
  direction: 'received' | 'sent';
  at: Date;
  subject: string;
  /** A received email nobody has answered yet. */
  needsReply: boolean;
}

export interface CustomerFollowUp {
  title: string;
  dueDate: Date;
  status: 'pending' | 'done' | 'dismissed';
  /** Still to do, and its day has come or passed. */
  due: boolean;
}

export interface CustomerDetail extends CustomerRow {
  /** Everyone their records name, newest first. */
  people: CustomerPerson[];
  /** Their address, when the enquiry system recorded one. */
  address?: string;
  /** What each of the six statuses can be set to by hand. */
  statusOptions: StatusOptions;
  /** What they asked for most recently, in their words. */
  inquiry: { receivedAt?: Date; fields: NamedValue[]; form?: string; channel?: string; location?: string; source: string } | null;
  quotations: QuoteLine[];
  invoiceList: InvoiceLine[];
  /** Inquiry → deal → quotation → invoice → payment, one chain per piece of business, newest first. */
  journeys: Journey[];
  /** Every quotation and invoice in full, each with what it is connected to. */
  documents: CustomerDocument[];
  emails: CustomerEmail[];
  followUps: CustomerFollowUp[];
  comparison: OrderComparison | null;
  gaps: string[];
  timeline: TimelineEvent[];
  customerRepliesInDays: number | null;
  weReplyInHours: number | null;
  analysis: CustomerAnalysis | null;
}

export interface CustomerStats {
  total: number;
  /** Customers with an inquiry no order has closed yet. */
  openInquiries: number;
  existing: number;
  quotePending: number;
  quotePendingValue: number;
  paymentPending: number;
  outstanding: number;
  needsFollowUp: number;
}

export interface CustomerQuery {
  source?: string;
  /** Only customers with something happening from this moment… */
  from?: string;
  /** …to this one. A plain date ("2026-10-06") means the whole of that day. */
  to?: string;
  view?: string;
  search?: string;
  // The board's filters: each a comma-separated list of the values to keep ("none" = has no such thing).
  owner?: string;
  type?: string;
  quote?: string;
  payment?: string;
  mail?: string;
  channel?: string;
  sort?: string;
  direction?: string;
  page?: number;
  pageSize?: number;
}

interface Entry {
  id: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  /** Every address this customer has used, for matching mail. */
  emails: string[];
  /**
   * What identifies them whatever row they end up on (their addresses and phone numbers, else the row id):
   * the team's comments, tasks and files are stored against these, so they stay with the customer when a
   * sync changes or merges the row.
   */
  keys: string[];
  /** Their records, newest first — for the panel's documents and connections. */
  records: Piece[];
  enquiries: ProfileEnquiry[];
  deals: ProfileDeal[];
  payments: ProfilePayment[];
  people: CustomerPerson[];
  address?: string;
  /** The jobs made from their quotations, newest first. */
  jobs: { id: string; number: string; quotationId: string; done: boolean }[];
  sourceIds: string[];
  profile: CustomerProfile;
  /** When anything happened with them: every inquiry, deal, quotation, invoice, payment and email (epoch ms). */
  activityAt: number[];
  inquiry: CustomerDetail['inquiry'];
  haystack: string;
  factsHash: string;
  aiSummary?: string;
}

interface Directory {
  currency: string;
  sources: { id: string; label: string; provider: string; active: boolean; canSync: boolean; lastSyncAt?: Date; lastError?: string }[];
  entries: Entry[];
}

// One record of one system, with whatever it says about who the customer is.
interface Piece {
  kind: 'enquiry' | 'deal' | 'quote' | 'invoice' | 'contact';
  identity: MatchIdentity;
  links: number[];
  sourceId?: string;
  date?: Date;
  doc: Doc;
}

const VIEWS: Record<string, (p: CustomerProfile) => boolean> = {
  all: () => true,
  open_inquiry: (p) => p.inquiries.open,
  new: (p) => p.type === 'new',
  // Everyone who has ordered — returning customers included; "returning" is the ones who came back.
  existing: (p) => p.type !== 'new',
  returning: (p) => p.type === 'returning',
  quote_pending: (p) => p.flags.includes('quote_pending'),
  payment_pending: (p) => p.flags.includes('payment_pending') || p.flags.includes('payment_overdue'),
  payment_overdue: (p) => p.flags.includes('payment_overdue'),
  follow_up: (p) => p.flags.includes('reply_needed') || p.flags.includes('follow_up_required'),
  converted: (p) => p.orders.count > 0,
  not_converted: (p) => p.orders.count === 0,
  active: (p) => p.active,
  inactive: (p) => !p.active,
};

// The board's filters: what each one reads off a customer. "none" stands for having no such thing.
const NONE = 'none';
const stageStatus = (p: CustomerProfile, key: StageKey) => p.stages.find((s) => s.key === key)?.status ?? NONE;

/** What each status can be set to by hand, as the panel's dropdowns offer it. */
export type StatusOptions = Record<StageKey, { status: string; label: string; tone: StageTone }[]>;
const STATUS_OPTIONS = Object.fromEntries(
  Object.entries(STAGE_OPTIONS).map(([key, options]) => [key, options.map(({ status, label, tone }) => ({ status, label, tone }))]),
) as StatusOptions;
const FILTERS: Record<'owner' | 'type' | 'quote' | 'payment' | 'mail' | 'channel', (p: CustomerProfile) => string> = {
  owner: (p) => p.owner ?? NONE,
  type: (p) => p.type,
  // The three steps the team can also set by hand are read as the board shows them.
  quote: (p) => stageStatus(p, 'quote'),
  payment: (p) => stageStatus(p, 'payment'),
  mail: (p) => stageStatus(p, 'email'),
  channel: (p) => p.inquiries.channel ?? NONE,
};
const listOf = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const URGENCY_RANK = { overdue: 0, today: 1, soon: 2, none: 3 };
const FOLLOW_UP_RANK = { overdue: 0, today: 1, upcoming: 2, none: 3 };
// A column's value for sorting; undefined sorts last whichever way the column is ordered.
const SORTS: Record<string, (e: Entry) => number | string | undefined> = {
  activity: (e) => e.profile.lastActivity?.at.getTime(),
  name: (e) => e.name.toLowerCase(),
  owner: (e) => e.profile.owner?.toLowerCase(),
  followUp: (e) => (e.profile.followUp.status === 'none' ? undefined : -FOLLOW_UP_RANK[e.profile.followUp.status]),
  type: (e) => e.profile.typeLabel,
  quotes: (e) => e.profile.quotes.latest?.amount,
  invoices: (e) => (e.profile.invoices.count ? e.profile.invoices.total : undefined),
  payment: (e) => (e.profile.payment.status === 'nothing_due' ? undefined : (e.profile.payment.outstanding ?? e.profile.payment.billed)),
  orders: (e) => (e.profile.orders.count ? e.profile.orders.totalValue : undefined),
  urgency: (e) => -URGENCY_RANK[e.profile.nextAction.urgency],
};

// The Customers view: every customer the organization's connected systems
// know about, each one seen whole. Enquiries (Gorilla Dash), deals, quotations
// and invoices (Pantheras CRM or any other connected CRM) and email are read
// from HaiVE's own canonical collections — filled by the data-source layer and
// the mailbox sync — matched into customers (customer-matching.ts) and summed
// up by the pure builder (customer-profile.builder.ts). Nothing here calls a
// CRM, and nothing raw from one reaches the page.
//
// Everything is read with the caller's organizationId.
@Injectable()
export class CustomerDirectoryService {
  private readonly logger = new Logger(CustomerDirectoryService.name);
  private readonly pythonAgentUrl: string;
  private readonly cache = new Map<string, { at: number; directory: Directory }>();

  constructor(
    @InjectConnection() private connection: Connection,
    private mail: CustomerMailService,
    private dataSources: DataSourcesService,
    private reservations: ReservationService,
    private http: HttpService,
    private jwt: JwtService,
    config: ConfigService,
  ) {
    this.pythonAgentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  private async compute(organizationId: string): Promise<Directory> {
    const hit = this.cache.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.directory;

    const find = (collection: string, filter: Doc = {}, projection?: Doc) =>
      this.connection
        .collection(collection)
        .find({ organizationId, ...filter }, projection ? { projection } : undefined)
        .limit(MAX_RECORDS)
        .toArray();
    const [sourceDocs, deals, quotes, invoices, contacts, payments, analyses, openTasks, statusDocs, jobDocs] = await Promise.all([
      find('crm_data_sources', {}, { label: 1, provider: 1, status: 1, sync: 1 }),
      find(
        'crm_deals',
        {},
        {
          name: 1,
          dataSourceId: 1,
          dealStatus: 1,
          monetaryValue: 1,
          createdAt: 1,
          expectedClosingDate: 1,
          lastActivityAt: 1,
          sourceData: 1,
          leadSource: 1,
          region: 1,
          externalOwnerLabel: 1,
          externalId: 1,
          // What is being sold on the deal — the items of the quotations raised from it.
          products: 1,
        },
      ),
      find(
        'crm_quotes',
        {},
        {
          dataSourceId: 1,
          dealId: 1,
          quoteName: 1,
          quoteNumber: 1,
          quoteAmount: 1,
          paidAmount: 1,
          currency: 1,
          quoteStatus: 1,
          clientApprovalStatus: 1,
          clientDetails: 1,
          createdAt: 1,
          dueDate: 1,
          expirationDate: 1,
          quoteOwnerLabel: 1,
          lineItems: 1,
          taxes: 1,
          fees: 1,
          externalId: 1,
        },
      ),
      find(
        'royalty_invoices',
        { voidStatus: { $ne: true } },
        {
          quoteId: 1,
          dealId: 1,
          invoiceNumber: 1,
          invoiceDate: 1,
          invoiceStatus: 1,
          currentValue: 1,
          costAmount: 1,
          currency: 1,
          clientDetails: 1,
          dueDate: 1,
          createdAt: 1,
        },
      ),
      // The people the CRMs hold, whether or not anything has been quoted to them yet.
      find('crm_contacts', {}, { dataSourceId: 1, name: 1, email: 1, phone: 1, company: 1, sourceCreatedAt: 1 }),
      find('crm_quote_payments',{ voided: { $ne: true } }, { quoteId: 1, amount: 1, paymentDate: 1 }),
      find('customer_analyses', {}, { customerId: 1, factsHash: 1, 'result.summary': 1 }),
      // The team's own tasks that are still open: they show on the board as follow-ups.
      find(TASKS_COLLECTION, { status: 'open' }, { customerKeys: 1, title: 1, dueDate: 1 }),
      // What the team set by hand, step by step.
      find(STATUSES_COLLECTION, {}, { customerKeys: 1, stages: 1 }),
      // The jobs made from quotations.
      find(JOBS_COLLECTION, {}, { customerKeys: 1, number: 1, seq: 1, quotationId: 1, 'statuses.progress': 1 }),
    ]);

    const sources = sourceDocs.map((s) => {
      const sync = (s.sync ?? {}) as Doc;
      const active = text(s.status) === 'active';
      return {
        id: s._id.toString(),
        label: text(s.label) || 'CRM',
        provider: text(s.provider),
        active,
        canSync: active && !!CRM_PROVIDERS[text(s.provider) as keyof typeof CRM_PROVIDERS]?.syncSupported,
        lastSyncAt: asDate(sync.lastSyncAt),
        lastError: sync.lastStatus === 'error' ? text(sync.lastError) || 'The last sync failed.' : undefined,
      };
    });
    const providerOf = new Map(sources.map((s) => [s.id, s.provider]));

    // ---- every record, with what it says about who the customer is
    const pieces: Piece[] = [];
    const dealIndex = new Map<string, number>();
    const quoteIndex = new Map<string, number>();
    for (const deal of deals) {
      const sourceId = text(deal.dataSourceId) || undefined;
      const provider = sourceId ? (providerOf.get(sourceId) ?? '') : '';
      dealIndex.set(deal._id.toString(), pieces.length);
      if (ENQUIRY_PROVIDERS.includes(provider)) {
        const { person } = normalizeEnquiry(provider, deal);
        pieces.push({
          kind: 'enquiry',
          identity: { name: person.name, company: person.company, email: person.email, phone: person.phone },
          links: [],
          sourceId,
          date: asDate(deal.createdAt),
          doc: deal,
        });
      } else {
        // A pipeline deal names the business only in its title; its quotation says who the customer really is.
        pieces.push({
          kind: 'deal',
          identity: { company: heuristicBusinessName(text(deal.name)) || undefined },
          links: [],
          sourceId,
          date: asDate(deal.createdAt),
          doc: deal,
        });
      }
    }
    const identityOf = (details: unknown): MatchIdentity => {
      const d = (details ?? {}) as Doc;
      return {
        name: text(d.contactName) || undefined,
        company: text(d.companyName) || undefined,
        email: text(d.email) || undefined,
        phone: text(d.phone) || undefined,
      };
    };
    for (const quote of quotes) {
      const deal = dealIndex.get(text(quote.dealId));
      quoteIndex.set(quote._id.toString(), pieces.length);
      pieces.push({
        kind: 'quote',
        identity: identityOf(quote.clientDetails),
        links: deal === undefined ? [] : [deal],
        sourceId: text(quote.dataSourceId) || undefined,
        date: asDate(quote.createdAt),
        doc: quote,
      });
    }
    for (const invoice of invoices) {
      const links = [quoteIndex.get(text(invoice.quoteId)), dealIndex.get(text(invoice.dealId))].filter((i): i is number => i !== undefined);
      pieces.push({
        kind: 'invoice',
        identity: identityOf(invoice.clientDetails),
        links,
        date: asDate(invoice.invoiceDate) ?? asDate(invoice.createdAt),
        doc: invoice,
      });
    }
    for (const contact of contacts) {
      // The sync names a contact that has no name after its email, or "Unnamed contact": neither is a name.
      const name = text(contact.name);
      const named = name && name !== 'Unnamed contact' && lower(name) !== lower(contact.email);
      pieces.push({
        kind: 'contact',
        identity: {
          name: named ? name : undefined,
          company: text(contact.company) || undefined,
          email: text(contact.email) || undefined,
          phone: text(contact.phone) || undefined,
        },
        links: [],
        sourceId: text(contact.dataSourceId) || undefined,
        // Only the CRM's own date: a contact stored before that was kept has none.
        date: asDate(contact.sourceCreatedAt),
        doc: contact,
      });
    }

    const groups = clusterCustomers(pieces);
    const paymentsByQuote = new Map<string, ProfilePayment[]>();
    for (const p of payments) {
      const date = asDate(p.paymentDate);
      if (!date || amount(p.amount) <= 0) continue;
      const quotationId = text(p.quoteId);
      if (!paymentsByQuote.has(quotationId)) paymentsByQuote.set(quotationId, []);
      paymentsByQuote.get(quotationId)!.push({ quotationId, amount: amount(p.amount), date });
    }
    const paymentsTracked = paymentsByQuote.size > 0 || quotes.some((q) => amount(q.paidAmount) > 0) || invoices.some((i) => lower(i.invoiceStatus) === 'paid');
    const currency = text(quotes[0]?.currency) || text(invoices[0]?.currency) || 'INR';

    // ---- the mail exchanged with every address any of them has used
    const addressesOf = (members: number[]) => [...new Set(members.map((i) => emailKey(pieces[i].identity.email)).filter(Boolean))];
    const mailByAddress = await this.mail.emailSummaries(organizationId, groups.flatMap(addressesOf));

    const saved = new Map(analyses.map((a) => [text(a.customerId), a]));
    const tasksByKey = new Map<string, ProfileFollowUp[]>();
    for (const task of openTasks) {
      const followUp: ProfileFollowUp = { title: text(task.title) || 'Task', dueDate: asDate(task.dueDate), source: 'task' };
      for (const key of Array.isArray(task.customerKeys) ? task.customerKeys.map(text) : []) {
        if (!tasksByKey.has(key)) tasksByKey.set(key, []);
        tasksByKey.get(key)!.push(followUp);
      }
    }
    const statusesByKey = new Map<string, Doc[]>();
    for (const doc of statusDocs) {
      for (const key of Array.isArray(doc.customerKeys) ? doc.customerKeys.map(text) : []) {
        if (!statusesByKey.has(key)) statusesByKey.set(key, []);
        statusesByKey.get(key)!.push(doc);
      }
    }
    const jobsByKey = new Map<string, Doc[]>();
    for (const job of jobDocs) {
      for (const key of Array.isArray(job.customerKeys) ? job.customerKeys.map(text) : []) {
        if (!jobsByKey.has(key)) jobsByKey.set(key, []);
        jobsByKey.get(key)!.push(job);
      }
    }
    const now = new Date();
    const entries: Entry[] = [];
    for (const members of groups) {
      const mine = members.map((i) => pieces[i]).sort((a, b) => time(b.date) - time(a.date));
      // The newest record that names something wins; a deal's title is only a fallback for the company.
      const named = [...mine.filter((p) => p.kind !== 'deal'), ...mine.filter((p) => p.kind === 'deal')];
      const pick = (field: keyof MatchIdentity) => named.map((p) => text(p.identity[field])).find(Boolean) || undefined;
      const emails = addressesOf(members);
      const company = pick('company');
      const email = emails.length ? emailKey(pick('email')) || emails[0] : undefined;
      const name = pick('name') ?? company ?? email ?? 'Unknown customer';
      const phone = pick('phone');
      // The same person is on several records: one entry each, filled in from whichever record has the detail.
      const people: CustomerPerson[] = [];
      for (const { identity } of named) {
        const [personName, address, number] = [text(identity.name), emailKey(identity.email), phoneKey(identity.phone) ? text(identity.phone) : ''];
        if (!personName && !address && !number) continue;
        const known = people.find(
          (p) => (address && p.email === address) || (number && phoneKey(p.phone) === phoneKey(number)) || (personName && lower(p.name) === lower(personName)),
        );
        if (known) {
          known.name ??= personName || undefined;
          known.email ??= address || undefined;
          known.phone ??= number || undefined;
        } else {
          people.push({ name: personName || undefined, email: address || undefined, phone: number || undefined });
        }
      }

      const enquiryPieces = mine.filter((p) => p.kind === 'enquiry');
      const normalized = enquiryPieces.map((p) => ({ piece: p, enquiry: normalizeEnquiry(providerOf.get(p.sourceId ?? '') ?? '', p.doc) }));
      const enquiries: ProfileEnquiry[] = normalized.map(({ piece, enquiry }) => {
        // The customer's own words: the longest answer on the form is the message.
        const words = [...enquiry.message].sort((a, b) => b.value.length - a.value.length)[0]?.value;
        return {
          id: piece.doc._id.toString(),
          date: piece.date,
          summary: words ? (words.length > MESSAGE_PREVIEW ? `${words.slice(0, MESSAGE_PREVIEW).trimEnd()}…` : words) : undefined,
          channel: enquiry.channel,
          location: enquiry.location,
        };
      });
      const dealRecords: ProfileDeal[] = mine
        .filter((p) => p.kind === 'deal')
        .map((p) => ({
          id: p.doc._id.toString(),
          name: text(p.doc.name) || undefined,
          date: asDate(p.doc.expectedClosingDate) ?? asDate(p.doc.lastActivityAt) ?? p.date,
          value: amount(p.doc.monetaryValue),
          status: (['won', 'lost'].includes(lower(p.doc.dealStatus)) ? lower(p.doc.dealStatus) : 'open') as ProfileDeal['status'],
        }));
      const quotations: ProfileQuotation[] = mine
        .filter((p) => p.kind === 'quote')
        .map(({ doc: q, date }) => ({
          id: q._id.toString(),
          number: text(q.quoteNumber) || undefined,
          name: text(q.quoteName) || undefined,
          date,
          amount: amount(q.quoteAmount),
          paidAmount: amount(q.paidAmount),
          state:
            lower(q.clientApprovalStatus) === 'approved'
              ? 'accepted'
              : lower(q.clientApprovalStatus) === 'rejected'
                ? 'rejected'
                : lower(q.quoteStatus) === 'draft'
                  ? 'draft'
                  : 'sent',
          dueDate: asDate(q.dueDate),
          expiresAt: asDate(q.expirationDate),
          owner: text(q.quoteOwnerLabel) || undefined,
          dealId: text(q.dealId) || undefined,
        }));
      const invoiceRecords: ProfileInvoice[] = mine
        .filter((p) => p.kind === 'invoice')
        .map(({ doc: invoice, date }) => ({
          id: invoice._id.toString(),
          number: text(invoice.invoiceNumber) || undefined,
          date,
          value: amount(invoice.currentValue),
          cost: typeof invoice.costAmount === 'number' ? invoice.costAmount : undefined,
          status: (['paid', 'invoiced'].includes(lower(invoice.invoiceStatus)) ? lower(invoice.invoiceStatus) : 'draft') as ProfileInvoice['status'],
          dueDate: asDate(invoice.dueDate),
          quotationId: text(invoice.quoteId) || undefined,
          dealId: text(invoice.dealId) || undefined,
        }));
      const contactRecords: ProfileContact[] = mine
        .filter((p) => p.kind === 'contact')
        .map((p) => ({ id: p.doc._id.toString(), date: p.date, source: sources.find((s) => s.id === p.sourceId)?.label }));

      const summary: EmailSummary = { received: 0, sent: 0, unanswered: 0, activityAt: [], followUps: [] };
      const later = (a?: Date, b?: Date) => (time(a) >= time(b) ? a : b);
      for (const address of emails) {
        const one = mailByAddress.get(address);
        if (!one) continue;
        summary.received += one.received;
        summary.sent += one.sent;
        summary.unanswered += one.unanswered;
        summary.lastReceivedAt = later(summary.lastReceivedAt, one.lastReceivedAt);
        summary.lastSentAt = later(summary.lastSentAt, one.lastSentAt);
        summary.activityAt.push(...one.activityAt);
        summary.followUps.push(...one.followUps);
        if (one.oldestUnansweredAt && (!summary.oldestUnansweredAt || one.oldestUnansweredAt < summary.oldestUnansweredAt))
          summary.oldestUnansweredAt = one.oldestUnansweredAt;
      }

      // An id that survives a re-sync: it comes from who the customer is, not from any one record.
      const identityKey = emails.length
        ? `e:${[...emails].sort()[0]}`
        : phoneKey(phone)
          ? `p:${phoneKey(phone)}`
          : companyKey(company)
            ? `c:${companyKey(company)}`
            : `n:${lower(name)}|${mine[mine.length - 1].doc._id.toString()}`;
      const id = createHash('sha256').update(identityKey).digest('hex').slice(0, 24);
      const phones = [...new Set(mine.map((p) => phoneKey(p.identity.phone)).filter(Boolean))];
      const keys = emails.length + phones.length > 0 ? [...emails.map((address) => `e:${address}`), ...phones.map((number) => `p:${number}`)] : [`id:${id}`];
      // A task found under two of their keys is still one task.
      const followUps: ProfileFollowUp[] = [
        ...summary.followUps.map((f) => ({ ...f, source: 'email' as const })),
        ...new Set(keys.flatMap((key) => tasksByKey.get(key) ?? [])),
      ];
      // Two rows that became one customer may each have had a status set: the later choice stands.
      const overrides: Partial<Record<StageKey, StageOverride>> = {};
      for (const doc of new Set(keys.flatMap((key) => statusesByKey.get(key) ?? []))) {
        for (const [stage, value] of Object.entries((doc.stages ?? {}) as Record<string, Doc>)) {
          if (!(stage in STAGE_OPTIONS) || !value) continue;
          const at = asDate(value.at);
          const known = overrides[stage as StageKey];
          if (!known || time(at) > time(known.at)) overrides[stage as StageKey] = { status: text(value.status), by: text(value.byName) || undefined, at };
        }
      }
      const ownerOn = (kind: Piece['kind'], field: string) =>
        mine
          .filter((p) => p.kind === kind)
          .map((p) => text(p.doc[field]))
          .find(Boolean);

      const customerPayments = quotations.flatMap((q) => paymentsByQuote.get(q.id) ?? []);

      const profile = buildCustomerProfile({
        now,
        currency,
        paymentsTracked,
        enquiries,
        deals: dealRecords,
        quotations,
        invoices: invoiceRecords,
        payments: customerPayments,
        contacts: contactRecords,
        email: { hasAddress: emails.length > 0, ...summary },
        owner: ownerOn('quote', 'quoteOwnerLabel') ?? ownerOn('deal', 'externalOwnerLabel'),
        followUps,
        overrides,
      });
      const byHand = profile.stages.filter((s) => s.manual).map((s) => [s.key, s.status]);

      const latest = normalized[0];
      const sourceIds = [...new Set(mine.map((p) => p.sourceId).filter((sourceId): sourceId is string => !!sourceId))];
      // Whatever only moves with the clock is left out, so a day passing doesn't make a saved analysis stale.
      const factsHash = createHash('sha256')
        .update(
          JSON.stringify({
            inquiries: enquiries.map((e) => [e.id, e.summary]),
            quotations: profile.quotations.map((q) => [q.id, q.state, q.amount]),
            invoices: profile.invoiceList.map((i) => [i.id, i.status, i.amount, i.paid, i.cost]),
            deals: dealRecords.map((d) => [d.id, d.status, d.value]),
            email: [summary.received, summary.sent, summary.unanswered],
            // Only when something is set by hand, so that analyses saved before this existed stay current.
            ...(byHand.length > 0 ? { byHand } : {}),
          }),
        )
        .digest('hex');
      const analysis = saved.get(id);
      entries.push({
        id,
        name,
        company: company && company !== name ? company : undefined,
        email,
        phone,
        emails,
        keys,
        records: mine,
        enquiries,
        deals: dealRecords,
        payments: customerPayments,
        people: people.slice(0, PEOPLE_LIMIT),
        address: normalized.map((n) => n.enquiry.person.address).find(Boolean),
        // A job found under two of their keys is still one job.
        jobs: [...new Set(keys.flatMap((key) => jobsByKey.get(key) ?? []))]
          .sort((a, b) => amount(b.seq) - amount(a.seq))
          .map((job) => ({ id: job._id.toString(), number: text(job.number), quotationId: text(job.quotationId), done: job.statuses?.progress === 'done' })),
        sourceIds,
        profile,
        activityAt: [...profile.events.map((e) => e.at.getTime()), ...summary.activityAt].filter((at) => at <= now.getTime()),
        inquiry: latest
          ? {
              receivedAt: latest.piece.date,
              fields: latest.enquiry.message,
              form: latest.enquiry.form,
              channel: latest.enquiry.channel,
              location: latest.enquiry.location,
              source: sources.find((s) => s.id === latest.piece.sourceId)?.label ?? 'CRM',
            }
          : null,
        haystack: [name, company, phone, ...emails, ...profile.quotations.map((q) => q.number), ...profile.invoiceList.map((i) => i.number)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        factsHash,
        aiSummary: analysis && analysis.factsHash === factsHash ? text(analysis.result?.summary) || undefined : undefined,
      });
    }

    const directory = { currency, sources, entries };
    this.cache.set(organizationId, { at: Date.now(), directory });
    return directory;
  }

  private row(entry: Entry, directory: Directory): CustomerRow {
    // The lists, comparison and timeline belong to the detail, not to a table row.
    const { quotations: _q, invoiceList: _i, comparison: _c, gaps: _g, events: _e, ...summary } = entry.profile;
    return {
      id: entry.id,
      name: entry.name,
      company: entry.company,
      email: entry.email,
      phone: entry.phone,
      sources: directory.sources.filter((s) => entry.sourceIds.includes(s.id)).map((s) => s.label),
      jobs: entry.jobs.map(({ id, number }) => ({ id, number })),
      aiSummary: entry.aiSummary,
      ...summary,
    };
  }

  /** The team's comments, tasks and files change what the board shows: the next read starts afresh. */
  invalidate(organizationId: string) {
    this.cache.delete(organizationId);
  }

  /**
   * The customers a query asks for. First the source and the period — what the tiles count — then the
   * view, the search and the board's filters, in the order asked for.
   */
  private async select(organizationId: string, query: CustomerQuery) {
    const directory = await this.compute(organizationId);
    const source = query.source && query.source !== 'all' ? query.source : null;
    if (source && !directory.sources.some((s) => s.id === source)) throw new BadRequestException('That data source isn’t connected.');
    const view = query.view && query.view !== 'all' ? query.view : null;
    if (view && !VIEWS[view]) throw new BadRequestException('Unknown filter.');
    const sortBy = SORTS[query.sort ?? ''] ? (query.sort as string) : 'activity';
    const descending = query.direction ? query.direction !== 'asc' : sortBy !== 'name' && sortBy !== 'type';

    // The period: a customer is in it when anything at all happened with them between the two moments.
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(query.to) ? `${query.to}T23:59:59.999Z` : query.to) : null;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from > to))
      throw new BadRequestException('Invalid date range.');
    const inPeriod = (e: Entry) => (!from && !to) || e.activityAt.some((at) => (!from || at >= from.getTime()) && (!to || at <= to.getTime()));
    const inSource = directory.entries.filter((e) => (!source || e.sourceIds.includes(source)) && inPeriod(e));
    const search = (query.search ?? '').trim().toLowerCase();
    const wanted = (Object.keys(FILTERS) as (keyof typeof FILTERS)[])
      .map((key) => [key, listOf(query[key])] as const)
      .filter(([, values]) => values.length > 0);
    const filtered = inSource.filter(
      (e) =>
        (!view || VIEWS[view](e.profile)) &&
        (!search || e.haystack.includes(search)) &&
        wanted.every(([key, values]) => values.includes(FILTERS[key](e.profile))),
    );
    const value = SORTS[sortBy];
    const sorted = [...filtered].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
      const order = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return (descending ? -order : order) || a.name.localeCompare(b.name);
    });
    return { directory, inSource, sorted, sortBy, descending };
  }

  async list(organizationId: string, query: CustomerQuery) {
    const { directory, inSource, sorted, sortBy, descending } = await this.select(organizationId, query);
    const sources: CustomerSource[] = directory.sources
      .map((s) => ({ ...s, customers: directory.entries.filter((e) => e.sourceIds.includes(s.id)).length }))
      // What is connected, plus anything disconnected that still holds customers.
      .filter((s) => s.customers > 0 || (s.active && s.provider !== BUILT_IN_PROVIDER))
      .sort((a, b) => b.customers - a.customers)
      .map(({ id, label, customers, active, canSync, lastSyncAt, lastError }) => ({ id, label, customers, connected: active, canSync, lastSyncAt, lastError }));

    const distinct = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));
    const count = (name: string) => inSource.filter((e) => VIEWS[name](e.profile)).length;
    const stats: CustomerStats = {
      total: inSource.length,
      openInquiries: count('open_inquiry'),
      existing: count('existing'),
      quotePending: count('quote_pending'),
      quotePendingValue: inSource.reduce((sum, e) => sum + e.profile.quotes.openValue, 0),
      paymentPending: count('payment_pending'),
      outstanding: inSource.reduce((sum, e) => sum + (e.profile.payment.outstanding ?? 0), 0),
      needsFollowUp: count('follow_up'),
    };
    const pageSize = Math.min(Math.max(Number(query.pageSize) || 25, 1), 100);
    const page = Math.max(Number(query.page) || 1, 1);
    return {
      sources,
      currency: directory.currency,
      // Over the selected source and period, before the other filters — the tiles are filters themselves.
      stats,
      // What the Owner and Inquiry-channel filters can offer: the values these customers really have.
      filterOptions: { owners: distinct(inSource.map((e) => e.profile.owner)), channels: distinct(inSource.map((e) => e.profile.inquiries.channel)) },
      total: sorted.length,
      page,
      pageSize,
      sort: sortBy,
      direction: descending ? 'desc' : 'asc',
      items: sorted.slice((page - 1) * pageSize, page * pageSize).map((e) => this.row(e, directory)),
    };
  }

  /** The board as a spreadsheet: every customer the query asks for (all pages), one line each, in the board's words. */
  async export(organizationId: string, query: CustomerQuery): Promise<string> {
    const { directory, sorted } = await this.select(organizationId, query);
    // A name or a company is typed by the customer: one that starts like a formula must not run when the file is opened.
    // A phone number ("+91 98400 12345") only looks like one: digits and separators can't run anything, so it stays as written.
    const safe = (value: unknown) => {
      const cell = text(value);
      if (/^[+\d][\d\s().-]*$/.test(cell)) return cell;
      return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
    };
    const day = (date?: Date) => (date ? date.toISOString().slice(0, 10) : '');
    const rows = sorted.map((e) => {
      const p = e.profile;
      const stage = (key: string) => p.stages.find((s) => s.key === key)?.label ?? '';
      return {
        Customer: safe(e.name),
        Company: safe(e.company),
        Email: safe(e.email),
        Phone: safe(e.phone),
        'Known to': directory.sources
          .filter((s) => e.sourceIds.includes(s.id))
          .map((s) => s.label)
          .join(' + '),
        Owner: safe(p.owner),
        Type: p.typeLabel,
        'Last activity': p.lastActivity?.label ?? '',
        'Last activity date': day(p.lastActivity?.at),
        Inquiry: stage('inquiry'),
        'Inquiry channel': safe(p.inquiries.channel),
        Quote: stage('quote'),
        'Quote number': safe(p.quotes.latest?.number),
        'Quote amount': p.quotes.latest ? p.quotes.latest.amount : '',
        Order: stage('order'),
        Orders: p.orders.count,
        'Order value': p.orders.totalValue,
        Payment: stage('payment'),
        Outstanding: p.payment.outstanding ?? '',
        Email_status: stage('email'),
        'Follow-up': stage('followUp'),
        'Follow-up date': day(p.followUp.nextAt),
        'Next step': p.nextAction.urgency === 'none' ? '' : p.nextAction.title,
        // Which of the statuses above the team chose itself, rather than the connected systems.
        'Set by hand': p.stages
          .filter((s) => s.manual)
          .map((s) => s.title)
          .join(', '),
        Currency: p.currency,
      };
    });
    const fields = [
      ...['Customer', 'Company', 'Email', 'Phone', 'Known to', 'Owner', 'Type', 'Last activity', 'Last activity date', 'Inquiry', 'Inquiry channel'],
      ...['Quote', 'Quote number', 'Quote amount', 'Order', 'Orders', 'Order value', 'Payment', 'Outstanding'],
      { label: 'Email status', value: 'Email_status' },
      ...['Follow-up', 'Follow-up date', 'Next step', 'Set by hand', 'Currency'],
    ];
    return new Parser({ fields }).parse(rows);
  }

  /**
   * Pulls the latest from the connected CRMs now (otherwise each syncs on its own schedule): the one
   * asked for, or every one that can be synced. One CRM failing doesn't stop the others.
   */
  async sync(organizationId: string, sourceId?: string) {
    const directory = await this.compute(organizationId);
    const wanted = directory.sources.filter((s) => s.canSync && (!sourceId || sourceId === 'all' || s.id === sourceId));
    if (wanted.length === 0)
      throw new BadRequestException(
        sourceId && sourceId !== 'all'
          ? 'That source can’t be synced. Check it on the Integrations page.'
          : 'No connected CRM can be synced. Connect one on the Integrations page first.',
      );
    const results = await Promise.all(
      wanted.map(async (source) => {
        try {
          const result = (await this.dataSources.syncNow(organizationId, source.id)) as Record<string, unknown> | undefined;
          const failed = result?.status === 'error';
          return { source: source.label, ok: !failed, error: failed ? text(result?.error) || 'The sync failed.' : undefined };
        } catch (err) {
          this.logger.warn(`Sync of ${source.label} failed: ${(err as Error).message}`);
          return {
            source: source.label,
            ok: false,
            error: err instanceof BadRequestException ? err.message : 'The sync couldn’t be completed. Please try again in a minute.',
          };
        }
      }),
    );
    this.cache.delete(organizationId);
    return { results };
  }

  private async found(organizationId: string, id: string): Promise<{ entry: Entry; directory: Directory }> {
    const directory = await this.compute(organizationId);
    const entry = directory.entries.find((e) => e.id === id);
    if (!entry) throw new NotFoundException('Customer not found.');
    return { entry, directory };
  }

  /** Who a customer id stands for — for what the team attaches to them (customer-workspace.service.ts). */
  async identity(organizationId: string, id: string) {
    const { entry } = await this.found(organizationId, id);
    // A To-Do task may name a record by HaiVE's id or by the CRM's own.
    const idsOf = (...kinds: Piece['kind'][]) =>
      entry.records
        .filter((p) => kinds.includes(p.kind))
        .flatMap((p) => [p.doc._id.toString(), text(p.doc.externalId)])
        .filter(Boolean);
    return { id: entry.id, name: entry.name, keys: entry.keys, emails: entry.emails, dealIds: idsOf('deal', 'enquiry'), quoteIds: idsOf('quote') };
  }

  /**
   * One quotation of one customer, in full — what a job is made from. Not found when the quotation
   * isn't that customer's (or is beyond what the panel lists).
   */
  async quotation(organizationId: string, customerId: string, quotationId: string) {
    const { entry, directory } = await this.found(organizationId, customerId);
    const document = this.documents(entry, directory).documents.find((d) => d.kind === 'quotation' && d.id === quotationId);
    if (!document) throw new NotFoundException('Quotation not found.');
    const record = entry.records.find((p) => p.kind === 'quote' && p.doc._id.toString() === quotationId);
    return {
      customer: { id: entry.id, keys: entry.keys, name: entry.name, company: entry.company, email: entry.email, phone: entry.phone },
      document,
      dealId: text(record?.doc.dealId) || undefined,
      currency: entry.profile.currency,
    };
  }

  /** Whose row each identity key is on today: a job keeps a customer's keys, not a row id. */
  async customerIds(organizationId: string): Promise<Map<string, string>> {
    const { entries } = await this.compute(organizationId);
    return new Map(entries.flatMap((entry) => entry.keys.map((key) => [key, entry.id] as [string, string])));
  }

  /** What the team wrote, set itself to do and attached, as timeline entries. */
  private async workspaceEvents(organizationId: string, entry: Entry): Promise<TimelineEvent[]> {
    const theirs = { organizationId, customerKeys: { $in: entry.keys } };
    const newest = (collection: string, filter: Doc, projection: Doc, by: string) =>
      this.connection
        .collection(collection)
        .find(filter, { projection })
        .sort({ [by]: -1 })
        .limit(WORKSPACE_EVENT_LIMIT)
        .toArray();
    const [notes, tasks, files, statuses, jobs] = await Promise.all([
      newest(NOTES_COLLECTION, theirs, { body: 1, createdByName: 1, createdAt: 1 }, 'createdAt'),
      newest(TASKS_COLLECTION, theirs, { title: 1, status: 1, createdAt: 1, completedAt: 1, createdByName: 1 }, 'createdAt'),
      newest(
        `${FILES_BUCKET}.files`,
        { 'metadata.organizationId': organizationId, 'metadata.customerKeys': { $in: entry.keys } },
        { filename: 1, uploadDate: 1, 'metadata.uploadedByName': 1 },
        'uploadDate',
      ),
      newest(STATUSES_COLLECTION, theirs, { history: 1 }, 'updatedAt'),
      newest(JOBS_COLLECTION, theirs, { number: 1, quotationNumber: 1, createdAt: 1, createdByName: 1 }, 'createdAt'),
    ]);
    const by = (name: unknown) => (text(name) ? ` by ${text(name)}` : '');
    const short = (value: unknown) => (text(value).length > MESSAGE_PREVIEW ? `${text(value).slice(0, MESSAGE_PREVIEW).trimEnd()}…` : text(value));
    const events: TimelineEvent[] = [];
    for (const note of notes) {
      const at = asDate(note.createdAt);
      if (at) events.push({ at, kind: 'comment', title: `Comment${by(note.createdByName)}`, detail: short(note.body) });
    }
    for (const task of tasks) {
      const [added, done] = [asDate(task.createdAt), asDate(task.completedAt)];
      if (added)
        events.push({ at: added, kind: 'task', title: `Task added${by(task.createdByName)}`, detail: short(task.title), attention: task.status === 'open' });
      if (done && task.status === 'done') events.push({ at: done, kind: 'task', title: 'Task done', detail: short(task.title) });
    }
    for (const file of files) {
      const at = asDate(file.uploadDate);
      if (at) events.push({ at, kind: 'file', title: `File added${by(file.metadata?.uploadedByName)}`, detail: text(file.filename) });
    }
    // A quotation the team decided to produce.
    for (const job of jobs) {
      const at = asDate(job.createdAt);
      if (at)
        events.push({
          at,
          kind: 'job',
          title: `Job ${text(job.number)} created${by(job.createdByName)}`,
          ...(text(job.quotationNumber) ? { detail: `From quotation ${text(job.quotationNumber)}` } : {}),
        });
    }
    // Every status set by hand, and every return to automatic.
    for (const change of statuses.flatMap((doc) => (Array.isArray(doc.history) ? (doc.history as Doc[]) : []))) {
      const at = asDate(change.at);
      const stage = text(change.stage) as StageKey;
      if (!at || !(stage in STAGE_OPTIONS)) continue;
      const choice = STAGE_OPTIONS[stage].find((o) => o.status === text(change.status));
      events.push({
        at,
        kind: 'status',
        title: choice ? `${STAGE_TITLE[stage]} set to ${choice.label}${by(change.byName)}` : `${STAGE_TITLE[stage]} set back to automatic${by(change.byName)}`,
      });
    }
    return events;
  }

  /** Everything that happened with one customer: the timeline, the emails and follow-ups themselves, and how fast each side replies. */
  private async activity(organizationId: string, entry: Entry) {
    const [{ emails, followUps }, workspace] = await Promise.all([
      this.mail.loadEmails(organizationId, entry.emails),
      this.workspaceEvents(organizationId, entry),
    ]);
    const now = new Date();
    const timeline = [...entry.profile.events, ...emailTimelineEvents(emails), ...followUpTimelineEvents(followUps, now), ...workspace]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, TIMELINE_LIMIT)
      .map(({ at, kind, title, detail, amount: value, attention }) => ({
        at,
        kind,
        title,
        ...(detail ? { detail } : {}),
        ...(value ? { amount: value } : {}),
        ...(attention ? { attention: true } : {}),
      }));
    const speeds = emailReplySpeeds(emails);
    const rounded = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);
    return {
      timeline,
      customerRepliesInDays: rounded(speeds.customerRepliesInDays),
      weReplyInHours: rounded(speeds.weReplyInHours),
      emails: [...emails]
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, EMAIL_LIST_LIMIT)
        .map(({ id, direction, at, subject, needsReply }): CustomerEmail => ({ id, direction, at, subject, needsReply: !!needsReply })),
      followUps: [...followUps]
        .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
        .map((f): CustomerFollowUp => ({ ...f, due: f.status === 'pending' && f.dueDate.getTime() <= now.getTime() })),
    };
  }

  /** The customer's quotations and invoices in full, and the chains that connect their records. */
  private documents(entry: Entry, directory: Directory) {
    const sourceLabel = (id?: string) => directory.sources.find((s) => s.id === id)?.label;
    const party = (identity: MatchIdentity): DocumentParty => ({
      company: text(identity.company) || undefined,
      contact: text(identity.name) || undefined,
      email: emailKey(identity.email) || undefined,
      phone: text(identity.phone) || undefined,
    });
    const piece = (kind: Piece['kind'], id: string) => entry.records.find((p) => p.kind === kind && p.doc._id.toString() === id);
    return buildCustomerDocuments({
      currency: entry.profile.currency,
      // Only the latest inquiry can still be open; the profile says whether it is.
      inquiries: entry.enquiries.map((e, index) => ({ ...e, open: index === 0 && entry.profile.inquiries.open })),
      deals: entry.deals,
      quotations: entry.profile.quotations.map((line) => {
        const record = piece('quote', line.id);
        const dealId = text(record?.doc.dealId) || undefined;
        // A quotation made in HaiVE carries its own lines. A CRM may keep them on the deal the
        // quotation was raised from instead (Pantheras does): those are then the quotation's items.
        const own: Doc[] = Array.isArray(record?.doc.lineItems) ? record.doc.lineItems : [];
        const onDeal: Doc[] = own.length === 0 && dealId ? ((piece('deal', dealId)?.doc.products as Doc[] | undefined) ?? []) : [];
        const charge = (kind: DocumentCharge['kind'], rows: unknown) =>
          (Array.isArray(rows) ? (rows as Doc[]) : []).map((row): DocumentCharge => ({
            kind,
            name: text(row?.name) || (kind === 'tax' ? 'Tax' : 'Fee'),
            amount: amount(row?.amount),
          }));
        return {
          line,
          dealId,
          source: sourceLabel(record?.sourceId),
          preparedFor: party(record?.identity ?? {}),
          lines:
            own.length > 0
              ? own
                  .filter((item) => text(item?.description))
                  .map((item) => ({
                    description: text(item.description),
                    quantity: amount(item.quantity),
                    unitPrice: amount(item.unitPrice),
                    total: amount(item.lineTotal),
                  }))
              : (Array.isArray(onDeal) ? onDeal : [])
                  .filter((item) => text(item?.name))
                  .map((item) => ({
                    description: text(item.name),
                    ...(text(item.description) ? { detail: text(item.description) } : {}),
                    quantity: amount(item.quantity),
                    unitPrice: amount(item.unitPrice),
                    total: amount(item.total),
                  })),
          linesFrom: own.length > 0 ? ('document' as const) : ('deal' as const),
          charges: [...charge('tax', record?.doc.taxes), ...charge('fee', record?.doc.fees)],
          payments: entry.payments.filter((p) => p.quotationId === line.id).map(({ date, amount: paid }) => ({ date, amount: paid })),
          job: entry.jobs.find((job) => job.quotationId === line.id),
        };
      }),
      invoices: entry.profile.invoiceList.map((line) => {
        const record = piece('invoice', line.id);
        return {
          line,
          quotationId: text(record?.doc.quoteId) || undefined,
          dealId: text(record?.doc.dealId) || undefined,
          source: sourceLabel(record?.sourceId),
          preparedFor: party(record?.identity ?? {}),
        };
      }),
    });
  }

  private async savedAnalysis(organizationId: string, entry: Entry): Promise<CustomerAnalysis | null> {
    const saved = await this.connection.collection('customer_analyses').findOne({ organizationId, customerId: entry.id });
    if (!saved) return null;
    return {
      ...(saved.result as Omit<CustomerAnalysis, 'generatedAt' | 'stale'>),
      generatedAt: saved.generatedAt as Date,
      stale: saved.factsHash !== entry.factsHash,
    };
  }

  async detail(organizationId: string, id: string): Promise<CustomerDetail> {
    const { entry, directory } = await this.found(organizationId, id);
    const [activity, analysis] = await Promise.all([this.activity(organizationId, entry), this.savedAnalysis(organizationId, entry)]);
    return {
      ...this.row(entry, directory),
      people: entry.people,
      address: entry.address,
      statusOptions: STATUS_OPTIONS,
      inquiry: entry.inquiry,
      quotations: entry.profile.quotations,
      invoiceList: entry.profile.invoiceList,
      ...this.documents(entry, directory),
      comparison: entry.profile.comparison,
      gaps: entry.profile.gaps,
      ...activity,
      analysis,
    };
  }

  /** Everything the AI is told about one customer. No contact details: it needs the story, not the address book. */
  private facts(
    entry: Entry,
    directory: Directory,
    activity: { timeline: TimelineEvent[]; customerRepliesInDays: number | null; weReplyInHours: number | null },
  ) {
    const p = entry.profile;
    return {
      currency: p.currency,
      customer: {
        name: entry.name,
        company: entry.company ?? null,
        type: p.typeLabel,
        typeReason: p.typeReason,
        active: p.active,
        pipelineStatus: p.crm.label,
      },
      recordsFrom: directory.sources.filter((s) => entry.sourceIds.includes(s.id)).map((s) => s.label),
      currentInquiry: entry.inquiry
        ? {
            received: entry.inquiry.receivedAt,
            stillOpen: p.inquiries.open,
            whatTheCustomerWrote: entry.inquiry.fields,
            inquiriesFromThisCustomer: p.inquiries.count,
          }
        : null,
      orders: p.orders,
      quotations: p.quotations.slice(0, 10).map(({ number, name, date, amount: value, stateLabel, expiresAt }) => ({
        number,
        name,
        date,
        amount: value,
        status: stateLabel,
        validUntil: expiresAt,
      })),
      invoices: p.invoiceList.slice(0, 10).map(({ number, date, amount: value, statusLabel, paid, outstanding, dueDate, overdue, cost, marginPct }) => ({
        number,
        date,
        amount: value,
        status: statusLabel,
        paid,
        outstanding,
        dueDate,
        overdue,
        cost,
        marginPct,
      })),
      payment: p.payment,
      previousOrderAgainstCurrent: p.comparison,
      email: { ...p.mail, customerUsuallyRepliesInDays: activity.customerRepliesInDays, weUsuallyReplyInHours: activity.weReplyInHours },
      whereItStands: { flags: p.flags, nextAction: p.nextAction },
      missingOrConflicting: p.gaps,
      // The team's own comments, tasks and file names stay out: they may hold contact details, and are not the customer's story.
      recentActivity: activity.timeline.filter((e) => !['comment', 'task', 'file', 'status'].includes(e.kind)).slice(0, 25),
      // What the team itself says about a step, where it differs from the connected systems: it is the more recent word.
      setByTheTeam: p.stages.filter((s) => s.manual).map((s) => ({ step: s.title, status: s.manual!.label, systemsSay: s.manual!.automatic })),
    };
  }

  /** The AI's reading of one customer. Reuses the saved one unless the facts changed or a refresh is asked for. */
  async analyze(caller: JwtPayload, id: string, refresh: boolean): Promise<CustomerAnalysis> {
    const organizationId = caller.organizationId;
    const { entry, directory } = await this.found(organizationId, id);
    const existing = await this.savedAnalysis(organizationId, entry);
    if (existing && !existing.stale && !refresh) return existing;
    const activity = await this.activity(organizationId, entry);

    // Billed like every other button-triggered AI action: reserve first (a
    // hard stop when there are no credits), settle on success, release on failure.
    const requestId = randomUUID();
    await this.reservations.reserve(this.reservations.resolveTenantKey(organizationId, caller.sub), caller.sub, requestId, 'customer-analysis');
    let result: Omit<CustomerAnalysis, 'generatedAt' | 'stale'>;
    try {
      const token = this.jwt.sign({ sub: caller.sub, organizationId }, { expiresIn: '5m' });
      const { data } = await firstValueFrom(
        this.http.post<Omit<CustomerAnalysis, 'generatedAt' | 'stale'>>(
          `${this.pythonAgentUrl}/customers/analyze`,
          { ...this.facts(entry, directory, activity), request_id: requestId },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 90_000 },
        ),
      );
      await this.reservations.settle(requestId);
      result = data;
    } catch (err) {
      await this.reservations.release(requestId);
      this.logger.error(`Customer analysis failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('The AI analysis couldn’t be completed right now. Please try again in a minute.');
    }
    const generatedAt = new Date();
    await this.connection
      .collection('customer_analyses')
      .updateOne(
        { organizationId, customerId: id },
        { $set: { organizationId, customerId: id, result, factsHash: entry.factsHash, generatedAt, generatedBy: caller.sub } },
        { upsert: true },
      );
    entry.aiSummary = result.summary || undefined;
    return { ...result, generatedAt, stale: false };
  }
}

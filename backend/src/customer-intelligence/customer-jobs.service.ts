import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Decoration, DecorationDocument } from '../crm/schemas/decoration.schema';
import { DynamicExecutorService } from '../integrations/dynamic-executor.service';
import { VendorsService } from '../vendors/vendors.service';
import { XeroService } from '../xero/xero.service';
import { MailService } from '../mail/mail.service';
import { CustomerDirectoryService, JOBS_COLLECTION } from './customer-directory.service';
import { JobGridFsService } from './job-gridfs.service';
import { DocumentCharge } from './customer-documents';
import { StageTone } from './customer-profile.builder';
import { CustomerFile, CustomerNote, CustomerTask, CustomerWorkspace, CustomerWorkspaceService, JobScope } from './customer-workspace.service';
import { UpdateJobDto } from './dto/customer-jobs.dto';
import { CreateCustomerTaskDto, UpdateCustomerTaskDto } from './dto/customer-workspace.dto';
import {
  CREDIT_STATUSES,
  ITEM_STATUSES,
  JOB_STATUS_COLUMNS,
  JOB_STATUS_KEYS,
  JOB_VIEWS,
  JobStatusChip,
  JobStatusColumn,
  JobStatusKey,
  JobStatusOption,
  jobStatusChips,
  PROOF_STATUSES,
  PURCHASE_ORDER_STATUSES,
  SHIPMENT_STATUSES,
} from './job-statuses';

export const JOB_COUNTERS_COLLECTION = 'customer_job_counters';

const MAX_JOBS = 5000;
const HISTORY_LIMIT = 300;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const DUPLICATE_KEY = 11000;

type Doc = Record<string, any>;

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
const asDate = (value: unknown): Date | undefined => (value instanceof Date && !Number.isNaN(value.getTime()) ? value : undefined);
const amountOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

// Xero's JSON API returns dates as either a plain ISO string or its own
// legacy ASP.NET MS-JSON wrapper ("/Date(1700000000000+0000)/") depending
// on how the endpoint's Accept header was configured — handled
// defensively here since this app controls neither (the endpoint is
// configured by an admin via the generic Resource/Endpoint Builder, not
// by this code). Returns YYYY-MM-DD, or undefined if neither form parses.
function xeroDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const msJson = /^\/Date\((\d+)([+-]\d{4})?\)\/$/.exec(value);
  const ms = msJson ? Number(msJson[1]) : Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}
const clip = (value: string, length: number) => (value.length > length ? `${value.slice(0, length - 1).trimEnd()}…` : value);
const day = (date: Date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const startOfToday = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

/** One job as a row of the Job board. */
export interface JobRow {
  id: string;
  number: string;
  title: string;
  quotationId: string;
  quotationNumber?: string;
  createdAt: Date;
  dueDate?: Date;
  /** Not done, and its due date has passed. */
  overdue: boolean;
  done: boolean;
  owner?: string;
  /** `id` is the customer's row today — absent when no connected system holds them any more. */
  customer: { id?: string; name: string; company?: string };
  amount: number;
  currency: string;
  /** The eight columns, in order. */
  statuses: JobStatusChip[];
  // JobBoard spec additions — all additive, all optional. `createdBy` here
  // is the same field JobDetail already exposes (see detailOf below) —
  // just lifted onto the row too, for the table's own "Created By" column.
  createdBy?: string;
  productionHouseVendorId?: string;
  productionHouseVendorName?: string;
  inHandsDate?: Date;
  referenceFileId?: string;
  referenceFileName?: string;
  voided: boolean;
  voidReason?: string;
  decorationId?: string;
  decorationName?: string;
  vendorIds: string[];
  vendorNames: string[];
  xeroInvoiceNumber?: string;
}

export interface JobItem {
  name: string;
  description?: string;
  quantity: number;
  unitPrice: number;
  total: number;
  status: string;
  label: string;
  tone: StageTone;
}

export interface JobPurchaseOrder {
  id: string;
  vendor: string;
  description?: string;
  amount?: number;
  reference?: string;
  accountingPoNumber?: string;
  status: string;
  label: string;
  tone: StageTone;
  orderedAt?: Date;
  expectedAt?: Date;
  receivedAt?: Date;
  deadline?: Date;
  backorderDueDate?: Date;
  addedBy: string;
  at: Date;
}

export interface JobShipment {
  id: string;
  carrier: string;
  trackingNumber?: string;
  status: string;
  label: string;
  tone: StageTone;
  shippedAt?: Date;
  deliveredAt?: Date;
  note?: string;
  addedBy: string;
  at: Date;
}

export interface JobEvent {
  at: Date;
  by: string;
  text: string;
}

// JobBoard spec's Credits section (J) — a HaiVE-native record (no Xero
// write access, see xero.service.ts's own read-only-scopes comment, so
// this is never a real Xero credit note). 'voided' status stamps
// deletedAt (see ENTRIES.credits.stamps) rather than ever being removed.
export interface JobCredit {
  id: string;
  creditNumber?: string;
  description: string;
  amount?: number;
  status: string;
  label: string;
  tone: StageTone;
  createdByName: string;
  createdAt: Date;
  deletedAt?: Date;
}

// JobBoard spec section 11's "Invoice Status — Xero" — every field is
// honest about what's actually known: `invoiceNumber` only once a number
// is linked; `connected`/`configured` distinguish "no Xero connection" from
// "connected, but nobody set up the Invoices endpoint yet"; `error` carries
// whatever Xero itself said when a live call failed, never a guess.
export interface XeroInvoiceStatus {
  linked: boolean;
  invoiceNumber?: string;
  connected: boolean;
  configured?: boolean;
  error?: string;
  status?: string;
  total?: number;
  amountDue?: number;
  totalTax?: number;
  currencyCode?: string;
  dueDate?: string;
  transactionDate?: string;
  contactName?: string;
  overdue?: boolean;
}

/** The lists every dropdown of the Job board and the job panel reads. */
export interface JobOptions {
  columns: JobStatusColumn[];
  items: JobStatusOption[];
  purchaseOrders: JobStatusOption[];
  proofs: JobStatusOption[];
  shipments: JobStatusOption[];
  credits: JobStatusOption[];
}

export interface JobDetail extends JobRow {
  /** Who the job is for, as the quotation named them. */
  contact: { name: string; company?: string; contact?: string; email?: string; phone?: string };
  /** The connected system the quotation came from. */
  quotationSource?: string;
  items: JobItem[];
  /** The items alone, before tax and fees. Null when the quotation held no items. */
  subtotal: number | null;
  charges: DocumentCharge[];
  purchaseOrders: JobPurchaseOrder[];
  shipments: JobShipment[];
  credits: JobCredit[];
  /** What happened on the job, newest first. */
  history: JobEvent[];
  createdBy: string;
  /** Whether the person asking may delete the job (owners and admins). */
  canManage: boolean;
  options: JobOptions;
}

export interface JobList {
  items: JobRow[];
  total: number;
  page: number;
  pageSize: number;
  /** How many jobs each quick view keeps, before search and filters. */
  stats: Record<string, number>;
  owners: string[];
  options: JobOptions;
}

export interface JobQuery {
  view?: string;
  search?: string;
  sort?: string;
  direction?: string;
  page?: number;
  pageSize?: number;
  owner?: string;
  // The Customer Profile's own Jobs tab — every job of this one customer.
  customerId?: string;
  // SalesBoard's "View Linked Job" action — a quote converts to at most one
  // job (the unique organizationId+quotationId index in onModuleInit above
  // guarantees this), so a caller can resolve straight from a quote id.
  quotationId?: string;
  /** One value per column: an option's value, or 'unset'. */
  statuses?: Partial<Record<JobStatusKey, string>>;
  // JobBoard spec section 17's filter list (additive) — productionHouse
  // isn't one of the eight status columns above (it's a real Vendor
  // reference, see quote.schema.ts's identical field for the reasoning),
  // so it needs its own query param. `voided` defaults to excluding voided
  // jobs from every view, same "archived stays out unless asked for"
  // convention as everywhere else in this app.
  productionHouseVendorId?: string;
  voided?: 'only' | 'include';
  decorationId?: string;
  // Any one of these vendorIds appearing in the job's own vendorIds array.
  vendorId?: string;
  // Table/filter section 17's "Xero Invoice Status" and "Reference" presence
  // filters — both honest presence checks, never a live Xero call (doing
  // that per row in a list would mean one external API round trip per job
  // just to render a table; the panel's own Invoice tab makes the real
  // live call for the one job a user actually opens).
  xeroLinked?: 'only' | 'unlinked';
  hasReference?: 'only' | 'missing';
}

const OPTIONS: JobOptions = {
  columns: JOB_STATUS_COLUMNS,
  items: ITEM_STATUSES,
  purchaseOrders: PURCHASE_ORDER_STATUSES,
  proofs: PROOF_STATUSES,
  shipments: SHIPMENT_STATUSES,
  credits: CREDIT_STATUSES,
};

// The two lists a job keeps of its own. Each entry has a name, a short status, a few dates and free text;
// moving it to a status that has a date fills that date with today unless one is given.
const ENTRIES = {
  purchaseOrders: {
    what: 'Purchase order',
    main: 'vendor',
    missing: 'Say who it is ordered from.',
    // 'reference' is the PO's own reference number; 'accountingPoNumber' is
    // the separate number an accounting system (e.g. Xero) might know it
    // by — two distinct identifiers the spec itself lists separately.
    text: ['vendor', 'description', 'reference', 'accountingPoNumber'],
    numbers: ['amount'],
    dates: ['orderedAt', 'expectedAt', 'receivedAt', 'deadline', 'backorderDueDate'],
    statuses: PURCHASE_ORDER_STATUSES,
    stamps: { ordered: 'orderedAt', received: 'receivedAt' } as Record<string, string>,
    limit: 50,
  },
  shipments: {
    what: 'Shipment',
    main: 'carrier',
    missing: 'Say who is carrying it.',
    text: ['carrier', 'trackingNumber', 'note'],
    numbers: [] as string[],
    dates: ['shippedAt', 'deliveredAt'],
    statuses: SHIPMENT_STATUSES,
    stamps: { shipped: 'shippedAt', delivered: 'deliveredAt' } as Record<string, string>,
    limit: 30,
  },
  credits: {
    what: 'Credit',
    main: 'description',
    missing: 'Say what the credit is for.',
    text: ['creditNumber', 'description'],
    numbers: ['amount'],
    dates: [] as string[],
    statuses: CREDIT_STATUSES,
    // Voiding stamps deletedAt instead of removing the record — see
    // JobCredit's own comment.
    stamps: { voided: 'deletedAt' } as Record<string, string>,
    limit: 50,
  },
};
type EntryKind = keyof typeof ENTRIES;

const optionOf = (options: JobStatusOption[], status: unknown) => options.find((o) => o.status === status) ?? options[0];

const SORTS: Record<string, (job: { doc: Doc; row: JobRow }) => number | string> = {
  number: (job) => amountOf(job.doc.seq),
  created: (job) => job.row.createdAt.getTime(),
  // Jobs with no due date come last whichever way the column is sorted.
  due: (job) => job.row.dueDate?.getTime() ?? NaN,
  customer: (job) => (job.row.customer.company ?? job.row.customer.name).toLowerCase(),
  owner: (job) => (job.row.owner ?? '').toLowerCase(),
  amount: (job) => job.row.amount,
};

// Jobs: quotations the team decided to produce. A job is HaiVE's own record —
// made from a quotation by "Convert to job", numbered J-0001 onwards, and
// carrying seven statuses the team sets by hand (job-statuses.ts). Nothing here
// is written to a CRM.
//
// A job keeps its customer's identity keys (as comments, tasks and files do),
// so it stays with the customer when a sync changes or merges their row. Its
// comments, tasks, files and artwork proofs are the customer's own, tagged with
// the job (customer-workspace.service.ts).
//
// Every read and write is filtered by the caller's organizationId: a job id
// from another organization is simply not found.
@Injectable()
export class CustomerJobsService implements OnModuleInit {
  private readonly logger = new Logger(CustomerJobsService.name);

  constructor(
    @InjectConnection() private connection: Connection,
    private directory: CustomerDirectoryService,
    private workspace: CustomerWorkspaceService,
    private vendorsService: VendorsService,
    private jobGridFs: JobGridFsService,
    @InjectModel(Decoration.name) private decorationModel: Model<DecorationDocument>,
    private xeroService: XeroService,
    private dynamicExecutor: DynamicExecutorService,
    private mailService: MailService,
  ) {}

  /** One job per quotation and one counter per organization, held by the database itself. */
  async onModuleInit() {
    try {
      await this.connection.collection(JOBS_COLLECTION).createIndex({ organizationId: 1, quotationId: 1 }, { unique: true });
      await this.connection.collection(JOBS_COLLECTION).createIndex({ organizationId: 1, seq: -1 });
      await this.connection.collection(JOB_COUNTERS_COLLECTION).createIndex({ organizationId: 1 }, { unique: true });
    } catch (error) {
      this.logger.warn(`Could not prepare the job indexes: ${(error as Error).message}`);
    }
  }

  private jobs() {
    return this.connection.collection(JOBS_COLLECTION);
  }

  // SalesBoard's "Job #" column (customer-intelligence -> crm one-directional
  // read, no module import needed — see quotes.controller.ts's own call
  // site) — one cheap batch lookup per table page instead of N "is this
  // quote converted" round trips.
  async findJobNumbersByQuotationIds(organizationId: string, quotationIds: string[]): Promise<Record<string, string>> {
    if (quotationIds.length === 0) return {};
    const docs = await this.jobs()
      .find({ organizationId, quotationId: { $in: quotationIds } }, { projection: { quotationId: 1, number: 1 } })
      .toArray();
    return Object.fromEntries(docs.map((d) => [text(d.quotationId), text(d.number)]));
  }

  private objectId(id: string, what = 'Job') {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException(`${what} not found.`);
    return new Types.ObjectId(id);
  }

  private async found(organizationId: string, jobId: string, projection?: Doc): Promise<Doc> {
    const job = await this.jobs().findOne({ _id: this.objectId(jobId), organizationId }, projection ? { projection } : undefined);
    if (!job) throw new NotFoundException('Job not found.');
    return job;
  }

  // ---- what goes out -----------------------------------------------------------------

  private row(doc: Doc, customerIds: Map<string, string>): JobRow {
    const statuses = (doc.statuses ?? {}) as Record<string, unknown>;
    const done = statuses.progress === 'done';
    const dueDate = asDate(doc.dueDate);
    const customer = (doc.customer ?? {}) as Doc;
    const keys: string[] = Array.isArray(doc.customerKeys) ? doc.customerKeys.map(text) : [];
    return {
      id: doc._id.toString(),
      number: text(doc.number),
      title: text(doc.title) || 'Job',
      quotationId: text(doc.quotationId),
      quotationNumber: text(doc.quotationNumber) || undefined,
      createdAt: asDate(doc.createdAt) ?? new Date(0),
      dueDate,
      overdue: !done && !!dueDate && dueDate.getTime() < startOfToday(),
      done,
      owner: text(doc.owner) || undefined,
      customer: {
        id: keys.map((key) => customerIds.get(key)).find(Boolean),
        name: text(customer.name) || 'Customer',
        company: text(customer.company) || undefined,
      },
      amount: amountOf(doc.amount),
      currency: text(doc.currency) || 'INR',
      statuses: jobStatusChips(statuses),
      createdBy: text(doc.createdByName) || undefined,
      productionHouseVendorId: text(doc.productionHouseVendorId) || undefined,
      productionHouseVendorName: text(doc.productionHouseVendorName) || undefined,
      inHandsDate: asDate(doc.inHandsDate),
      referenceFileId: text(doc.referenceFileId) || undefined,
      referenceFileName: text(doc.referenceFileName) || undefined,
      voided: doc.voided === true,
      voidReason: text(doc.voidReason) || undefined,
      decorationId: text(doc.decorationId) || undefined,
      decorationName: text(doc.decorationName) || undefined,
      vendorIds: Array.isArray(doc.vendorIds) ? doc.vendorIds.map(text).filter(Boolean) : [],
      vendorNames: Array.isArray(doc.vendorNames) ? doc.vendorNames.map(text).filter(Boolean) : [],
      xeroInvoiceNumber: text(doc.xeroInvoiceNumber) || undefined,
    };
  }

  private purchaseOrder(entry: Doc): JobPurchaseOrder {
    const option = optionOf(PURCHASE_ORDER_STATUSES, entry.status);
    return {
      id: text(entry.id),
      vendor: text(entry.vendor),
      description: text(entry.description) || undefined,
      amount: typeof entry.amount === 'number' ? entry.amount : undefined,
      reference: text(entry.reference) || undefined,
      accountingPoNumber: text(entry.accountingPoNumber) || undefined,
      status: option.status,
      label: option.label,
      tone: option.tone,
      orderedAt: asDate(entry.orderedAt),
      expectedAt: asDate(entry.expectedAt),
      receivedAt: asDate(entry.receivedAt),
      deadline: asDate(entry.deadline),
      backorderDueDate: asDate(entry.backorderDueDate),
      addedBy: text(entry.createdByName) || 'Team member',
      at: asDate(entry.createdAt) ?? new Date(0),
    };
  }

  private shipment(entry: Doc): JobShipment {
    const option = optionOf(SHIPMENT_STATUSES, entry.status);
    return {
      id: text(entry.id),
      carrier: text(entry.carrier),
      trackingNumber: text(entry.trackingNumber) || undefined,
      status: option.status,
      label: option.label,
      tone: option.tone,
      shippedAt: asDate(entry.shippedAt),
      deliveredAt: asDate(entry.deliveredAt),
      note: text(entry.note) || undefined,
      addedBy: text(entry.createdByName) || 'Team member',
      at: asDate(entry.createdAt) ?? new Date(0),
    };
  }

  private credit(entry: Doc): JobCredit {
    const option = optionOf(CREDIT_STATUSES, entry.status);
    return {
      id: text(entry.id),
      creditNumber: text(entry.creditNumber) || undefined,
      description: text(entry.description),
      amount: typeof entry.amount === 'number' ? entry.amount : undefined,
      status: option.status,
      label: option.label,
      tone: option.tone,
      createdByName: text(entry.createdByName) || 'Team member',
      createdAt: asDate(entry.createdAt) ?? new Date(0),
      deletedAt: asDate(entry.deletedAt),
    };
  }

  private async detailOf(caller: JwtPayload, doc: Doc): Promise<JobDetail> {
    const customer = (doc.customer ?? {}) as Doc;
    const items: JobItem[] = (Array.isArray(doc.items) ? (doc.items as Doc[]) : []).map((item) => {
      const option = optionOf(ITEM_STATUSES, item.status);
      return {
        name: text(item.name) || 'Item',
        description: text(item.description) || undefined,
        quantity: amountOf(item.quantity),
        unitPrice: amountOf(item.unitPrice),
        total: amountOf(item.total),
        status: option.status,
        label: option.label,
        tone: option.tone,
      };
    });
    return {
      ...this.row(doc, await this.directory.customerIds(caller.organizationId)),
      contact: {
        name: text(customer.name) || 'Customer',
        company: text(customer.company) || undefined,
        contact: text(customer.contact) || undefined,
        email: text(customer.email) || undefined,
        phone: text(customer.phone) || undefined,
      },
      quotationSource: text(doc.quotationSource) || undefined,
      items,
      subtotal: items.length > 0 ? Math.round(items.reduce((sum, item) => sum + item.total, 0) * 100) / 100 : null,
      charges: (Array.isArray(doc.charges) ? (doc.charges as Doc[]) : []).map((charge) => ({
        kind: charge.kind === 'fee' ? 'fee' : 'tax',
        name: text(charge.name),
        amount: amountOf(charge.amount),
      })),
      purchaseOrders: (Array.isArray(doc.purchaseOrders) ? (doc.purchaseOrders as Doc[]) : []).map((entry) => this.purchaseOrder(entry)),
      shipments: (Array.isArray(doc.shipments) ? (doc.shipments as Doc[]) : []).map((entry) => this.shipment(entry)),
      credits: (Array.isArray(doc.credits) ? (doc.credits as Doc[]) : []).map((entry) => this.credit(entry)),
      history: (Array.isArray(doc.history) ? (doc.history as Doc[]) : [])
        .map((event) => ({ at: asDate(event.at) ?? new Date(0), by: text(event.byName) || 'Team member', text: text(event.text) }))
        .reverse(),
      createdBy: text(doc.createdByName) || 'Team member',
      canManage: this.workspace.canManage(caller, 'job_board'),
      options: OPTIONS,
    };
  }

  // ---- reading -----------------------------------------------------------------------

  /** The Job board: every job of the organization, narrowed by a quick view, the column filters and a search. */
  async list(organizationId: string, query: JobQuery = {}): Promise<JobList> {
    const [docs, customerIds] = await Promise.all([
      this.jobs()
        .find({ organizationId }, { projection: { items: 0, charges: 0, purchaseOrders: 0, shipments: 0, history: 0 } })
        .sort({ seq: -1 })
        .limit(MAX_JOBS)
        .toArray(),
      this.directory.customerIds(organizationId),
    ]);
    const all = docs.map((doc) => {
      const row = this.row(doc, customerIds);
      return { doc, row, statuses: (doc.statuses ?? {}) as Record<string, unknown>, overdue: row.overdue, done: row.done };
    });
    // Same default as the list below: a voided job counts in neither the
    // tiles nor "All jobs" unless explicitly asked for, so the number on a
    // tile always matches what clicking it actually shows.
    const unvoided = query.voided === 'include' ? all : all.filter((job) => !job.row.voided);
    const stats = Object.fromEntries(Object.entries(JOB_VIEWS).map(([view, keeps]) => [view, unvoided.filter(keeps).length]));
    const owners = [...new Set(unvoided.map((job) => job.row.owner).filter((owner): owner is string => !!owner))].sort((a, b) => a.localeCompare(b));

    const keeps = JOB_VIEWS[query.view ?? ''] ?? JOB_VIEWS.all;
    const words = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const wanted = JOB_STATUS_KEYS.map((key) => [key, text(query.statuses?.[key])] as const).filter(([, value]) => value);
    const owner = text(query.owner);
    let kept = all.filter(keeps);
    if (owner) kept = kept.filter((job) => job.row.owner === owner);
    if (query.customerId) kept = kept.filter((job) => job.row.customer.id === query.customerId);
    if (query.quotationId) kept = kept.filter((job) => job.row.quotationId === query.quotationId);
    if (query.productionHouseVendorId) kept = kept.filter((job) => job.row.productionHouseVendorId === query.productionHouseVendorId);
    if (query.voided === 'only') kept = kept.filter((job) => job.row.voided);
    else if (query.voided !== 'include') kept = kept.filter((job) => !job.row.voided);
    if (query.decorationId) kept = kept.filter((job) => job.row.decorationId === query.decorationId);
    if (query.vendorId) kept = kept.filter((job) => job.row.vendorIds.includes(query.vendorId!));
    if (query.xeroLinked === 'only') kept = kept.filter((job) => !!job.row.xeroInvoiceNumber);
    else if (query.xeroLinked === 'unlinked') kept = kept.filter((job) => !job.row.xeroInvoiceNumber);
    if (query.hasReference === 'only') kept = kept.filter((job) => !!job.row.referenceFileId);
    else if (query.hasReference === 'missing') kept = kept.filter((job) => !job.row.referenceFileId);
    if (wanted.length > 0)
      kept = kept.filter((job) => wanted.every(([key, value]) => (value === 'unset' ? !text(job.statuses[key]) : job.statuses[key] === value)));
    if (words.length > 0)
      kept = kept.filter((job) => {
        const hay = [job.row.number, job.row.title, job.row.quotationNumber, job.row.owner, job.row.customer.name, job.row.customer.company]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return words.every((word) => hay.includes(word));
      });

    // Newest job first unless a column is chosen.
    const sort = SORTS[query.sort ?? ''];
    if (sort) {
      const sign = query.direction === 'asc' ? 1 : -1;
      kept = [...kept].sort((a, b) => {
        const [x, y] = [sort(a), sort(b)];
        if (typeof x === 'number' && typeof y === 'number') {
          if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) === Number.isNaN(y) ? 0 : Number.isNaN(x) ? 1 : -1;
          return (x - y) * sign;
        }
        return String(x).localeCompare(String(y)) * sign;
      });
    }

    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize || DEFAULT_PAGE_SIZE)));
    const pages = Math.max(1, Math.ceil(kept.length / pageSize));
    const page = Math.min(pages, Math.max(1, Math.floor(query.page || 1)));
    return {
      items: kept.slice((page - 1) * pageSize, page * pageSize).map((job) => job.row),
      total: kept.length,
      page,
      pageSize,
      stats,
      owners,
      options: OPTIONS,
    };
  }

  async detail(caller: JwtPayload, jobId: string): Promise<JobDetail> {
    return this.detailOf(caller, await this.found(caller.organizationId, jobId));
  }

  // "Invoice Status — Xero" (section 11, additive). Every branch below is
  // an honest, distinct state — never silently merged into "not
  // available" — because the spec explicitly asks to "handle missing,
  // disconnected, or stale integration data explicitly" rather than
  // fabricate a result. `configured: false` means an admin still needs to
  // set up Xero's "Invoices" resource/endpoint in Settings -> Integrations
  // (this app has no automatic seeding for it yet).
  async getXeroInvoiceStatus(caller: JwtPayload, jobId: string): Promise<XeroInvoiceStatus> {
    const job = await this.found(caller.organizationId, jobId, { xeroInvoiceNumber: 1 });
    const invoiceNumber = text(job.xeroInvoiceNumber);
    if (!invoiceNumber) return { linked: false, connected: false, configured: false };

    const status = await this.xeroService.getStatus(caller.organizationId);
    if (!status.connected) return { linked: true, invoiceNumber, connected: false, configured: false };

    try {
      const result = await this.dynamicExecutor.execute(caller.organizationId, 'xero', 'invoices', 'get', {
        query: { InvoiceNumbers: invoiceNumber },
      });
      if (!result.success) {
        return { linked: true, invoiceNumber, connected: true, configured: true, error: result.message };
      }
      const data = result.data as { Invoices?: Doc[] } | undefined;
      const invoice = data?.Invoices?.[0];
      if (!invoice) {
        return { linked: true, invoiceNumber, connected: true, configured: true, error: 'Xero has no invoice with this number.' };
      }

      const amountDue = amountOf(invoice.AmountDue);
      const dueDate = xeroDate(invoice.DueDate);
      const today = new Date().toISOString().slice(0, 10);
      return {
        linked: true,
        invoiceNumber,
        connected: true,
        configured: true,
        status: text(invoice.Status) || undefined,
        total: amountOf(invoice.Total),
        amountDue,
        totalTax: amountOf(invoice.TotalTax),
        currencyCode: text(invoice.CurrencyCode) || undefined,
        dueDate: dueDate ?? undefined,
        transactionDate: xeroDate(invoice.Date) ?? undefined,
        contactName: text((invoice.Contact as Doc | undefined)?.Name) || undefined,
        // Never marked overdue with nothing left owing — same rule
        // getBiSummary (quotes.service.ts) and every other aging
        // calculation in this app follows.
        overdue: amountDue > 0 && !!dueDate && dueDate < today,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        return { linked: true, invoiceNumber, connected: true, configured: false };
      }
      throw error;
    }
  }

  // ---- converting a quotation ----------------------------------------------------------

  private async nextNumber(organizationId: string): Promise<number> {
    const counters = this.connection.collection(JOB_COUNTERS_COLLECTION);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const counter = await counters.findOneAndUpdate({ organizationId }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
        return amountOf(counter?.seq) || 1;
      } catch (error) {
        // Two first jobs at the same moment: one creates the counter, the other finds it on the next try.
        if ((error as { code?: number }).code !== DUPLICATE_KEY || attempt >= 2) throw error;
      }
    }
  }

  /**
   * Makes a job from one of a customer's quotations: its customer, owner, amount and items are copied, and
   * the job gets the organization's next number. A quotation becomes a job once — asking again returns the
   * job it already is.
   */
  async convert(caller: JwtPayload, customerId: string, quotationId: string): Promise<{ job: JobDetail; created: boolean }> {
    const organizationId = caller.organizationId;
    const { customer, document, dealId, currency } = await this.directory.quotation(organizationId, customerId, quotationId);
    const already = await this.jobs().findOne({ organizationId, quotationId });
    if (already) return { job: await this.detailOf(caller, already), created: false };

    const byName = await this.workspace.nameOf(caller);
    const at = new Date();
    const seq = await this.nextNumber(organizationId);
    const company = document.preparedFor.company ?? customer.company;
    const doc: Doc = {
      organizationId,
      seq,
      number: `J-${String(seq).padStart(4, '0')}`,
      customerId: customer.id,
      customerKeys: customer.keys,
      customer: {
        name: customer.name,
        ...(company ? { company } : {}),
        ...(document.preparedFor.contact ? { contact: document.preparedFor.contact } : {}),
        ...((document.preparedFor.email ?? customer.email) ? { email: document.preparedFor.email ?? customer.email } : {}),
        ...((document.preparedFor.phone ?? customer.phone) ? { phone: document.preparedFor.phone ?? customer.phone } : {}),
      },
      quotationId,
      ...(document.number ? { quotationNumber: document.number } : {}),
      ...(document.source ? { quotationSource: document.source } : {}),
      ...(dealId ? { dealId } : {}),
      title: company || customer.name || 'Job',
      ...(document.owner ? { owner: document.owner } : {}),
      amount: document.amount,
      currency,
      items: document.lines.map((line) => ({
        name: line.description,
        ...(line.detail ? { description: line.detail } : {}),
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        total: line.total,
        status: ITEM_STATUSES[0].status,
      })),
      charges: document.charges,
      statuses: {},
      purchaseOrders: [],
      shipments: [],
      history: [{ at, by: caller.sub, byName, text: document.number ? `Job created from quotation ${document.number}` : 'Job created from a quotation' }],
      createdBy: caller.sub,
      createdByName: byName,
      createdAt: at,
      updatedAt: at,
    };
    try {
      const { insertedId } = await this.jobs().insertOne(doc);
      doc._id = insertedId;
    } catch (error) {
      if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
      // Converted by someone else in the same moment: theirs is the job.
      const theirs = await this.jobs().findOne({ organizationId, quotationId });
      if (!theirs) throw error;
      return { job: await this.detailOf(caller, theirs), created: false };
    }
    // The customer's row gets its job tag, and their records' journey its job step.
    this.directory.invalidate(organizationId);
    return { job: await this.detailOf(caller, doc), created: true };
  }

  // ---- changing a job ------------------------------------------------------------------

  private event(caller: JwtPayload, byName: string, at: Date, said: string) {
    return { history: { $each: [{ at, by: caller.sub, byName, text: said }], $slice: -HISTORY_LIMIT } };
  }

  /** One change to a job, written together with the line that says who made it. */
  private async change(caller: JwtPayload, jobId: string, update: { $set?: Doc; $unset?: Doc; $push?: Doc; $pull?: Doc }, said: string, where: Doc = {}) {
    const at = new Date();
    const byName = await this.workspace.nameOf(caller);
    const updated = await this.jobs().findOneAndUpdate(
      { _id: this.objectId(jobId), organizationId: caller.organizationId, ...where },
      {
        ...update,
        $set: { ...(update.$set ?? {}), updatedAt: at },
        $push: { ...(update.$push ?? {}), ...this.event(caller, byName, at, said) },
      } as Doc,
      { returnDocument: 'after' },
    );
    if (!updated) throw new NotFoundException('Job not found.');
    return this.detailOf(caller, updated);
  }

  /** A line in the job's history for something kept elsewhere (a comment, a task, a file). */
  private async log(caller: JwtPayload, jobId: string, said: string) {
    const at = new Date();
    await this.jobs().updateOne({ _id: this.objectId(jobId), organizationId: caller.organizationId }, {
      $set: { updatedAt: at },
      $push: this.event(caller, await this.workspace.nameOf(caller), at, said),
    } as Doc);
  }

  // Section 16 — mandatory remittance-proof validation. Of the payment
  // column's options, only these two actually ASSERT that money has been
  // received (the spec's own four named variants include 'Waiting for
  // Remittance', which is the state BEFORE receipt and plainly needs no
  // proof of something that hasn't happened yet — this is the "first
  // inspect... and determine which values mean proof must be attached"
  // the spec itself asks for). Enforced here, server-side, so it can never
  // be bypassed by skipping frontend validation.
  private static readonly REMITTANCE_PROOF_REQUIRED = new Set(['received', 'tbc_remittance_received']);

  /** Sets one of the eight statuses to one of its column's options, or (status null) back to not set.
   * `proofFileId` must name a file already uploaded to THIS job (via addFile) when moving the payment
   * column to a remittance-received value — never trusted as a bare id, always re-checked against the
   * job's own files, so a proof belonging to another job or customer can never satisfy this. */
  async setStatus(
    caller: JwtPayload,
    jobId: string,
    key: JobStatusKey,
    status: string | null,
    proofFileId?: string,
  ): Promise<JobDetail> {
    const column = JOB_STATUS_COLUMNS.find((c) => c.key === key);
    if (!column) throw new BadRequestException('That isn’t one of a job’s statuses.');
    const option = status === null ? undefined : column.options.find((o) => o.status === status);
    if (status !== null && !option) throw new BadRequestException('That isn’t one of the options for this status.');
    // Existence first, same "scope before business rule" ordering every
    // other guarded write in this app follows — a nonexistent job is
    // always a 404, never shadowed by the proof-required 400 below.
    await this.found(caller.organizationId, jobId, { _id: 1 });

    let proofFile: CustomerFile | undefined;
    if (key === 'payment' && option && CustomerJobsService.REMITTANCE_PROOF_REQUIRED.has(option.status)) {
      if (!proofFileId) {
        throw new BadRequestException(
          `Attach proof of payment/remittance before setting Overall Status to “${option.label}”.`,
        );
      }
      // Throws NotFoundException if this file isn't really attached to
      // this job — the existing proof is never trusted to already be
      // valid just because an id was supplied.
      const found = await this.openFile(caller, jobId, proofFileId);
      (found.stream as unknown as { destroy?: () => void }).destroy?.();
      proofFile = found.file;
    }

    const job = await this.change(
      caller,
      jobId,
      {
        $set: {
          ...(option ? { [`statuses.${key}`]: option.status } : {}),
          ...(proofFile ? { [`statusProofs.${key}`]: proofFile.id } : {}),
        },
        ...(option ? {} : { $unset: { [`statuses.${key}`]: '' } }),
      },
      option
        ? `${column.title} set to ${option.label}${proofFile ? ` (proof: ${clip(proofFile.name, 60)})` : ''}`
        : `${column.title} cleared`,
    );
    // Whether a job is done shows on its customer too.
    if (key === 'progress') this.directory.invalidate(caller.organizationId);
    return job;
  }

  async update(caller: JwtPayload, jobId: string, dto: UpdateJobDto): Promise<JobDetail> {
    const set: Doc = {};
    const unset: Doc = {};
    const said: string[] = [];
    if (dto.title !== undefined) {
      const title = dto.title.trim();
      if (!title) throw new BadRequestException('Give the job a name.');
      set.title = title;
      said.push(`Renamed to “${clip(title, 80)}”`);
    }
    if (dto.dueDate === null) {
      unset.dueDate = '';
      said.push('Due date removed');
    } else if (dto.dueDate !== undefined) {
      set.dueDate = new Date(dto.dueDate);
      said.push(`Due date set to ${day(set.dueDate)}`);
    }
    if (dto.productionHouseVendorId === null) {
      unset.productionHouseVendorId = '';
      unset.productionHouseVendorName = '';
      said.push('Production house cleared');
    } else if (dto.productionHouseVendorId !== undefined) {
      const vendor = await this.vendorsService.getVendor(caller.organizationId, dto.productionHouseVendorId);
      set.productionHouseVendorId = dto.productionHouseVendorId;
      set.productionHouseVendorName = vendor.name;
      said.push(`Production house set to ${vendor.name}`);
    }
    if (dto.inHandsDate === null) {
      unset.inHandsDate = '';
      said.push('In Hands date removed');
    } else if (dto.inHandsDate !== undefined) {
      set.inHandsDate = new Date(dto.inHandsDate);
      said.push(`In Hands date set to ${day(set.inHandsDate)}`);
    }
    if (dto.decorationId === null) {
      unset.decorationId = '';
      unset.decorationName = '';
      said.push('Decoration cleared');
    } else if (dto.decorationId !== undefined) {
      const decoration = await this.decorationModel.findOne({ _id: dto.decorationId, organizationId: caller.organizationId }).exec();
      if (!decoration) throw new BadRequestException('Decoration not found in this organization.');
      set.decorationId = dto.decorationId;
      set.decorationName = decoration.name;
      said.push(`Decoration set to ${decoration.name}`);
    }
    if (dto.vendorIds !== undefined) {
      const vendors = await Promise.all(dto.vendorIds.map((vid) => this.vendorsService.getVendor(caller.organizationId, vid).catch(() => null)));
      const missing = dto.vendorIds.filter((_, i) => !vendors[i]);
      if (missing.length > 0) throw new BadRequestException(`Vendor(s) not found in this organization: ${missing.join(', ')}`);
      set.vendorIds = dto.vendorIds;
      set.vendorNames = vendors.map((v) => v!.name);
      said.push(dto.vendorIds.length > 0 ? 'Vendors updated' : 'Vendors cleared');
    }
    if (dto.xeroInvoiceNumber === null) {
      unset.xeroInvoiceNumber = '';
      said.push('Xero invoice link removed');
    } else if (dto.xeroInvoiceNumber !== undefined) {
      set.xeroInvoiceNumber = dto.xeroInvoiceNumber.trim();
      said.push(`Linked to Xero invoice ${set.xeroInvoiceNumber}`);
    }
    if (said.length === 0) throw new BadRequestException('Nothing to change.');
    return this.change(caller, jobId, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, said.join(' · '));
  }

  async setItemStatus(caller: JwtPayload, jobId: string, index: number, status: string): Promise<JobDetail> {
    const option = ITEM_STATUSES.find((o) => o.status === status);
    if (!option) throw new BadRequestException('That isn’t one of the options for an item.');
    const job = await this.found(caller.organizationId, jobId, { items: 1 });
    const item = Number.isInteger(index) && index >= 0 && Array.isArray(job.items) ? (job.items[index] as Doc | undefined) : undefined;
    if (!item) throw new NotFoundException('Item not found.');
    return this.change(
      caller,
      jobId,
      { $set: { [`items.${index}.status`]: option.status } },
      `“${clip(text(item.name) || 'Item', 60)}” marked ${option.label}`,
    );
  }

  // "Reference" attachment (section 13, additive) — one pointer per job,
  // same replace-and-delete-the-old-one convention as every other
  // single-attachment field in this app (e.g. ProductsService.setImage).
  async setReferenceFile(caller: JwtPayload, jobId: string, file: Express.Multer.File): Promise<JobDetail> {
    const existing = await this.found(caller.organizationId, jobId, { referenceFileId: 1 });
    const previousFileId = text(existing.referenceFileId);
    const fileId = await this.jobGridFs.upload(file.originalname, file.buffer, { organizationId: caller.organizationId, jobId });
    const job = await this.change(
      caller,
      jobId,
      { $set: { referenceFileId: fileId, referenceFileName: file.originalname, referenceFileMimeType: file.mimetype } },
      `Reference file “${clip(file.originalname, 60)}” attached`,
    );
    if (previousFileId) await this.jobGridFs.delete(previousFileId).catch(() => undefined);
    return job;
  }

  async getReferenceFileStream(
    organizationId: string,
    jobId: string,
  ): Promise<{ stream: NodeJS.ReadableStream; filename: string; mimeType: string }> {
    const job = await this.found(organizationId, jobId, { referenceFileId: 1, referenceFileName: 1, referenceFileMimeType: 1 });
    const fileId = text(job.referenceFileId);
    if (!fileId) throw new NotFoundException('This job has no reference file.');
    return {
      stream: this.jobGridFs.openDownloadStream(fileId),
      filename: text(job.referenceFileName) || 'reference',
      mimeType: text(job.referenceFileMimeType) || 'application/octet-stream',
    };
  }

  // "Void" (JobBoard Actions menu, item 14) — a soft cancel, deliberately
  // NOT the same operation as remove() below: history, purchase orders,
  // shipments and every other record stay exactly as they are; only a
  // voided flag and reason are added, and nothing already written is
  // deleted. Owners/administrators only, same tier as remove().
  async setVoided(caller: JwtPayload, jobId: string, voided: boolean, reason?: string | null): Promise<JobDetail> {
    if (!this.workspace.canManage(caller)) throw new ForbiddenException('Only an owner or an administrator can void a job.');
    const said = voided ? `Voided${reason ? ` — ${clip(reason, 200)}` : ''}` : 'Void reversed';
    const job = await this.change(
      caller,
      jobId,
      voided
        ? { $set: { voided: true, ...(reason ? { voidReason: reason } : {}) } }
        : { $set: { voided: false }, $unset: { voidReason: '' } },
      said,
    );
    this.directory.invalidate(caller.organizationId);
    return job;
  }

  /** Owners and administrators only. What was written, set to do and attached on the job stays with its customer. */
  async remove(caller: JwtPayload, jobId: string): Promise<void> {
    if (!this.workspace.canManage(caller, 'job_board')) throw new ForbiddenException('Only an owner, an administrator or someone allowed to delete jobs can delete a job.');
    const { deletedCount } = await this.jobs().deleteOne({ _id: this.objectId(jobId), organizationId: caller.organizationId });
    if (!deletedCount) throw new NotFoundException('Job not found.');
    this.directory.invalidate(caller.organizationId);
  }

  // ---- purchase orders and shipments ---------------------------------------------------

  /** What a form sent, as what to store and what to clear. `current` is the entry being changed, when there is one. */
  private entryValues(kind: EntryKind, input: Doc, current?: Doc) {
    const spec = ENTRIES[kind];
    const set: Doc = {};
    const unset: string[] = [];
    for (const field of spec.text) {
      if (input[field] === undefined) continue;
      const written = text(input[field]);
      if (written) set[field] = written;
      else if (field === spec.main) throw new BadRequestException(spec.missing);
      else unset.push(field);
    }
    for (const field of spec.numbers) {
      if (input[field] === undefined) continue;
      if (typeof input[field] === 'number') set[field] = input[field];
      else unset.push(field);
    }
    for (const field of spec.dates) {
      if (input[field] === undefined) continue;
      if (input[field]) set[field] = new Date(input[field]);
      else unset.push(field);
    }
    if (input.status !== undefined) {
      if (!spec.statuses.some((o) => o.status === input.status)) throw new BadRequestException('That isn’t one of the options.');
      set.status = input.status;
      // "Ordered" or "Shipped" with no date given: it happened today.
      const stamped = spec.stamps[input.status];
      if (stamped && set[stamped] === undefined && !unset.includes(stamped) && !asDate(current?.[stamped])) set[stamped] = new Date();
    }
    return { set, unset };
  }

  private async addEntry(caller: JwtPayload, jobId: string, kind: EntryKind, input: Doc): Promise<JobDetail> {
    const spec = ENTRIES[kind];
    const job = await this.found(caller.organizationId, jobId, { [kind]: 1 });
    if ((Array.isArray(job[kind]) ? job[kind].length : 0) >= spec.limit)
      throw new BadRequestException(`A job can hold up to ${spec.limit} of these. Delete one to add another.`);
    const { set } = this.entryValues(kind, { ...input, status: input.status ?? spec.statuses[0].status });
    if (!set[spec.main]) throw new BadRequestException(spec.missing);
    const entry = {
      id: new Types.ObjectId().toString(),
      ...set,
      createdBy: caller.sub,
      createdByName: await this.workspace.nameOf(caller),
      createdAt: new Date(),
    };
    return this.change(caller, jobId, { $push: { [kind]: entry } }, `${spec.what} added — ${clip(set[spec.main], 60)}`);
  }

  private async updateEntry(caller: JwtPayload, jobId: string, kind: EntryKind, entryId: string, input: Doc): Promise<JobDetail> {
    const spec = ENTRIES[kind];
    const job = await this.found(caller.organizationId, jobId, { [kind]: 1 });
    const current = (Array.isArray(job[kind]) ? (job[kind] as Doc[]) : []).find((entry) => entry.id === entryId);
    if (!current) throw new NotFoundException(`${spec.what} not found.`);
    const { set, unset } = this.entryValues(kind, input, current);
    if (Object.keys(set).length + unset.length === 0) throw new BadRequestException('Nothing to change.');
    const name = clip(text(set[spec.main] ?? current[spec.main]), 60);
    const moved = set.status !== undefined && set.status !== current.status ? spec.statuses.find((o) => o.status === set.status) : undefined;
    return this.change(
      caller,
      jobId,
      {
        $set: Object.fromEntries(Object.entries(set).map(([field, value]) => [`${kind}.$.${field}`, value])),
        ...(unset.length ? { $unset: Object.fromEntries(unset.map((field) => [`${kind}.$.${field}`, ''])) } : {}),
      },
      moved ? `${spec.what} ${moved.label.toLowerCase()} — ${name}` : `${spec.what} changed — ${name}`,
      { [`${kind}.id`]: entryId },
    );
  }

  private async removeEntry(caller: JwtPayload, jobId: string, kind: EntryKind, entryId: string): Promise<JobDetail> {
    const spec = ENTRIES[kind];
    const job = await this.found(caller.organizationId, jobId, { [kind]: 1 });
    const current = (Array.isArray(job[kind]) ? (job[kind] as Doc[]) : []).find((entry) => entry.id === entryId);
    if (!current) throw new NotFoundException(`${spec.what} not found.`);
    return this.change(caller, jobId, { $pull: { [kind]: { id: entryId } } }, `${spec.what} removed — ${clip(text(current[spec.main]), 60)}`);
  }

  addPurchaseOrder = (caller: JwtPayload, jobId: string, dto: object) => this.addEntry(caller, jobId, 'purchaseOrders', dto);
  updatePurchaseOrder = (caller: JwtPayload, jobId: string, id: string, dto: object) => this.updateEntry(caller, jobId, 'purchaseOrders', id, dto);
  removePurchaseOrder = (caller: JwtPayload, jobId: string, id: string) => this.removeEntry(caller, jobId, 'purchaseOrders', id);
  addShipment = (caller: JwtPayload, jobId: string, dto: object) => this.addEntry(caller, jobId, 'shipments', dto);
  updateShipment = (caller: JwtPayload, jobId: string, id: string, dto: object) => this.updateEntry(caller, jobId, 'shipments', id, dto);
  removeShipment = (caller: JwtPayload, jobId: string, id: string) => this.removeEntry(caller, jobId, 'shipments', id);
  addCredit = (caller: JwtPayload, jobId: string, dto: object) => this.addEntry(caller, jobId, 'credits', dto);
  updateCredit = (caller: JwtPayload, jobId: string, id: string, dto: object) => this.updateEntry(caller, jobId, 'credits', id, dto);
  removeCredit = (caller: JwtPayload, jobId: string, id: string) => this.removeEntry(caller, jobId, 'credits', id);

  // ---- comments, tasks, files and proofs: the customer's, tagged with the job ----------

  private async scope(caller: JwtPayload, jobId: string): Promise<JobScope> {
    const job = await this.found(caller.organizationId, jobId, { customerId: 1, customerKeys: 1 });
    return { jobId: job._id.toString(), customerId: text(job.customerId), customerKeys: Array.isArray(job.customerKeys) ? job.customerKeys.map(text) : [] };
  }

  async workspaceOf(caller: JwtPayload, jobId: string): Promise<CustomerWorkspace> {
    const scope = await this.scope(caller, jobId);
    return this.workspace.overview(caller, scope.customerId, scope);
  }

  async addNote(caller: JwtPayload, jobId: string, body: string): Promise<CustomerNote> {
    const scope = await this.scope(caller, jobId);
    const note = await this.workspace.addNote(caller, scope.customerId, body, scope);
    await this.log(caller, jobId, 'Comment added');
    return note;
  }

  async removeNote(caller: JwtPayload, jobId: string, noteId: string): Promise<void> {
    const scope = await this.scope(caller, jobId);
    await this.workspace.removeNote(caller, scope.customerId, noteId, scope);
    await this.log(caller, jobId, 'Comment deleted');
  }

  async addTask(caller: JwtPayload, jobId: string, dto: CreateCustomerTaskDto): Promise<CustomerTask> {
    const scope = await this.scope(caller, jobId);
    const task = await this.workspace.addTask(caller, scope.customerId, dto, scope);
    await this.log(caller, jobId, `Task added — ${clip(task.title, 80)}`);
    return task;
  }

  async updateTask(caller: JwtPayload, jobId: string, taskId: string, dto: UpdateCustomerTaskDto): Promise<CustomerTask> {
    const scope = await this.scope(caller, jobId);
    const task = await this.workspace.updateTask(caller, scope.customerId, taskId, dto, scope);
    const what = dto.status === 'done' ? 'Task done' : dto.status === 'open' ? 'Task reopened' : 'Task changed';
    await this.log(caller, jobId, `${what} — ${clip(task.title, 80)}`);
    return task;
  }

  async removeTask(caller: JwtPayload, jobId: string, taskId: string): Promise<void> {
    const scope = await this.scope(caller, jobId);
    await this.workspace.removeTask(caller, scope.customerId, taskId, scope);
    await this.log(caller, jobId, 'Task deleted');
  }

  async addFile(caller: JwtPayload, jobId: string, upload: Express.Multer.File | undefined, kind: 'file' | 'proof' = 'file'): Promise<CustomerFile> {
    const scope = await this.scope(caller, jobId);
    const file = await this.workspace.addFile(caller, scope.customerId, upload, scope, kind);
    await this.log(caller, jobId, `${kind === 'proof' ? 'Proof uploaded' : 'File attached'} — ${clip(file.name, 80)}`);
    return file;
  }

  async openFile(caller: JwtPayload, jobId: string, fileId: string) {
    const scope = await this.scope(caller, jobId);
    return this.workspace.openFile(caller, scope.customerId, fileId, scope);
  }

  async removeFile(caller: JwtPayload, jobId: string, fileId: string): Promise<void> {
    const scope = await this.scope(caller, jobId);
    const file = await this.workspace.removeFile(caller, scope.customerId, fileId, scope);
    await this.log(caller, jobId, `${file.kind === 'proof' ? 'Proof deleted' : 'File deleted'} — ${clip(file.name, 80)}`);
  }

  async setProof(caller: JwtPayload, jobId: string, fileId: string, status: string, note?: string | null): Promise<CustomerFile> {
    const scope = await this.scope(caller, jobId);
    const file = await this.workspace.setProof(caller, scope, fileId, status, note ?? undefined);
    const said = status === 'approved' ? 'Proof approved' : status === 'changes' ? 'Changes needed on proof' : 'Proof awaiting approval';
    await this.log(caller, jobId, `${said} — ${clip(file.name, 80)}`);
    return file;
  }

  // "Send Proof" (section G, additive) — emails the actual proof file to
  // the job's own contact email, recorded in history only once the send
  // genuinely succeeds (never on a merely-attempted send — see
  // MailService.sendDocumentEmail's own fail-open comment on SMTP being
  // unconfigured).
  async sendProof(caller: JwtPayload, jobId: string, fileId: string): Promise<{ sent: boolean; to: string }> {
    const job = await this.found(caller.organizationId, jobId, { customer: 1, number: 1 });
    const to = text((job.customer as Doc | undefined)?.email);
    if (!to) throw new BadRequestException('This job has no contact email on file — add one before sending the proof.');

    const { stream, file } = await this.openFile(caller, jobId, fileId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const sent = await this.mailService.sendDocumentEmail(to, {
      subject: `Proof for job ${text(job.number)} — ${file.name}`,
      html: `<p>Please find attached the artwork proof for job ${text(job.number)}.</p>`,
      text: `Please find attached the artwork proof for job ${text(job.number)}.`,
      attachment: { filename: file.name, content: buffer },
    });
    if (sent) await this.log(caller, jobId, `Proof sent — ${clip(file.name, 80)} to ${to}`);
    return { sent, to };
  }
}

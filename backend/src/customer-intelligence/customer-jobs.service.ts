import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CustomerDirectoryService, JOBS_COLLECTION } from './customer-directory.service';
import { DocumentCharge } from './customer-documents';
import { StageTone } from './customer-profile.builder';
import { CustomerFile, CustomerNote, CustomerTask, CustomerWorkspace, CustomerWorkspaceService, JobScope } from './customer-workspace.service';
import { UpdateJobDto } from './dto/customer-jobs.dto';
import { CreateCustomerTaskDto, UpdateCustomerTaskDto } from './dto/customer-workspace.dto';
import {
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
  /** The seven columns, in order. */
  statuses: JobStatusChip[];
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
  status: string;
  label: string;
  tone: StageTone;
  orderedAt?: Date;
  expectedAt?: Date;
  receivedAt?: Date;
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

/** The lists every dropdown of the Job board and the job panel reads. */
export interface JobOptions {
  columns: JobStatusColumn[];
  items: JobStatusOption[];
  purchaseOrders: JobStatusOption[];
  proofs: JobStatusOption[];
  shipments: JobStatusOption[];
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
  /** One value per column: an option's value, or 'unset'. */
  statuses?: Partial<Record<JobStatusKey, string>>;
}

const OPTIONS: JobOptions = {
  columns: JOB_STATUS_COLUMNS,
  items: ITEM_STATUSES,
  purchaseOrders: PURCHASE_ORDER_STATUSES,
  proofs: PROOF_STATUSES,
  shipments: SHIPMENT_STATUSES,
};

// The two lists a job keeps of its own. Each entry has a name, a short status, a few dates and free text;
// moving it to a status that has a date fills that date with today unless one is given.
const ENTRIES = {
  purchaseOrders: {
    what: 'Purchase order',
    main: 'vendor',
    missing: 'Say who it is ordered from.',
    text: ['vendor', 'description', 'reference'],
    numbers: ['amount'],
    dates: ['orderedAt', 'expectedAt', 'receivedAt'],
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
      status: option.status,
      label: option.label,
      tone: option.tone,
      orderedAt: asDate(entry.orderedAt),
      expectedAt: asDate(entry.expectedAt),
      receivedAt: asDate(entry.receivedAt),
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
      history: (Array.isArray(doc.history) ? (doc.history as Doc[]) : [])
        .map((event) => ({ at: asDate(event.at) ?? new Date(0), by: text(event.byName) || 'Team member', text: text(event.text) }))
        .reverse(),
      createdBy: text(doc.createdByName) || 'Team member',
      canManage: this.workspace.canManage(caller),
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
    const stats = Object.fromEntries(Object.entries(JOB_VIEWS).map(([view, keeps]) => [view, all.filter(keeps).length]));
    const owners = [...new Set(all.map((job) => job.row.owner).filter((owner): owner is string => !!owner))].sort((a, b) => a.localeCompare(b));

    const keeps = JOB_VIEWS[query.view ?? ''] ?? JOB_VIEWS.all;
    const words = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const wanted = JOB_STATUS_KEYS.map((key) => [key, text(query.statuses?.[key])] as const).filter(([, value]) => value);
    const owner = text(query.owner);
    let kept = all.filter(keeps);
    if (owner) kept = kept.filter((job) => job.row.owner === owner);
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

  /** Sets one of the seven statuses to one of its column's options, or (status null) back to not set. */
  async setStatus(caller: JwtPayload, jobId: string, key: JobStatusKey, status: string | null): Promise<JobDetail> {
    const column = JOB_STATUS_COLUMNS.find((c) => c.key === key);
    if (!column) throw new BadRequestException('That isn’t one of a job’s statuses.');
    const option = status === null ? undefined : column.options.find((o) => o.status === status);
    if (status !== null && !option) throw new BadRequestException('That isn’t one of the options for this status.');
    const job = await this.change(
      caller,
      jobId,
      option ? { $set: { [`statuses.${key}`]: option.status } } : { $unset: { [`statuses.${key}`]: '' } },
      option ? `${column.title} set to ${option.label}` : `${column.title} cleared`,
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

  /** Owners and administrators only. What was written, set to do and attached on the job stays with its customer. */
  async remove(caller: JwtPayload, jobId: string): Promise<void> {
    if (!this.workspace.canManage(caller)) throw new ForbiddenException('Only an owner or an administrator can delete a job.');
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
}

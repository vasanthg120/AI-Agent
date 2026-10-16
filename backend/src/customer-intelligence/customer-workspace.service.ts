import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { assertAcceptableFile, cleanFileName } from '../common/file-names';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { UPLOAD_FILE_SIZE_LIMIT_BYTES } from '../common/upload-limits';
import { CustomerDirectoryService, FILES_BUCKET, JOBS_COLLECTION, NOTES_COLLECTION, STATUSES_COLLECTION, TASKS_COLLECTION } from './customer-directory.service';
import { STAGE_OPTIONS, StageKey } from './customer-profile.builder';
import { CreateCustomerTaskDto, UpdateCustomerTaskDto } from './dto/customer-workspace.dto';
import { PROOF_STATUSES } from './job-statuses';

const STATUS_HISTORY_LIMIT = 60;

const LIST_LIMIT = 200;
const MAX_FILES_PER_CUSTOMER = 50;
const LINKED_TASK_LIMIT = 50;

type Doc = Record<string, any>;

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
const asDate = (value: unknown): Date | undefined => (value instanceof Date && !Number.isNaN(value.getTime()) ? value : undefined);

/**
 * A job's own corner of its customer's workspace. What is written, set to do or attached on a job is
 * kept with the customer's (same collections, same identity keys) and carries the job's id — so it
 * shows on the job, and on the customer tagged with the job.
 */
export interface JobScope {
  jobId: string;
  customerId: string;
  customerKeys: string[];
}

export interface CustomerNote {
  id: string;
  body: string;
  author: string;
  at: Date;
  /** Written by the person asking — they may delete it. */
  mine: boolean;
  /** The job it was written on, when it was. */
  jobId?: string;
  jobNumber?: string;
}

export interface CustomerTask {
  id: string;
  title: string;
  dueDate?: Date;
  status: 'open' | 'done';
  assigneeId?: string;
  assignee?: string;
  createdBy: string;
  at: Date;
  completedAt?: Date;
  /** Still open, and its day has passed. */
  overdue: boolean;
  /** Added by the person asking — they may delete it. */
  mine: boolean;
  jobId?: string;
  jobNumber?: string;
}

export interface CustomerFile {
  id: string;
  name: string;
  size: number;
  type: string;
  uploadedBy: string;
  at: Date;
  mine: boolean;
  jobId?: string;
  jobNumber?: string;
  /** An artwork proof of a job, with where its approval stands. */
  kind: 'file' | 'proof';
  proofStatus?: string;
  proofNote?: string;
  /** A copy made from a Google Drive / OneDrive file (customer-cloud.service.ts): which provider. */
  copiedFrom?: 'google_drive' | 'onedrive';
}

/** A task from the To-Do list (written by the daily report) that names one of this customer's records. */
export interface LinkedTask {
  id: string;
  title: string;
  priority: string;
  status: string;
  date: string;
}

export interface CustomerWorkspace {
  notes: CustomerNote[];
  tasks: CustomerTask[];
  files: CustomerFile[];
  linkedTasks: LinkedTask[];
  /** Who a task can be given to: the people of this organization. */
  assignees: { id: string; name: string }[];
  /** Whether the person asking may remove what others added (owners and admins). */
  canManage: boolean;
  limits: { maxFileBytes: number; maxFiles: number };
}

// What the team attaches to a customer: comments, tasks and files. They are
// HaiVE's own — nothing here is written to a CRM — and they are stored against
// the customer's identity keys (their email addresses and phone numbers), not
// against a row id or a CRM record, so they stay with the customer when a
// sync changes or merges the row.
//
// Every read and write is filtered by the caller's organizationId AND the
// customer's keys: an id belonging to another customer, or to another
// organization, is simply not found.
@Injectable()
export class CustomerWorkspaceService {
  constructor(
    @InjectConnection() private connection: Connection,
    private directory: CustomerDirectoryService,
    private gridFs: GridFsService,
  ) {}

  /** Owners and administrators may remove what others added. */
  canManage(caller: JwtPayload) {
    return caller.roles.some((role) => role === 'owner' || role === 'admin');
  }

  private objectId(id: string, what: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException(`${what} not found.`);
    return new Types.ObjectId(id);
  }

  /** The people of the organization, by id. A platform administrator is not one of the team. */
  private async team(organizationId: string): Promise<Map<string, string>> {
    const users = await this.connection
      .collection('users')
      .find({ organizationId, active: { $ne: false }, roles: { $ne: 'superadmin' } }, { projection: { name: 1, email: 1 } })
      .limit(500)
      .toArray();
    return new Map(users.map((u) => [u._id.toString(), text(u.name) || text(u.email) || 'Team member']));
  }

  /** The name the person asking goes by in the team. */
  async nameOf(caller: JwtPayload): Promise<string> {
    return (await this.team(caller.organizationId)).get(caller.sub) ?? (text(caller.email) || 'Team member');
  }

  private task(doc: Doc, team: Map<string, string>, callerId: string): CustomerTask {
    const dueDate = asDate(doc.dueDate);
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    return {
      id: doc._id.toString(),
      title: text(doc.title),
      dueDate,
      status: doc.status === 'done' ? 'done' : 'open',
      assigneeId: text(doc.assigneeId) || undefined,
      // Their name as it is now; the one saved with the task if they have since left.
      assignee: team.get(text(doc.assigneeId)) ?? (text(doc.assigneeName) || undefined),
      createdBy: text(doc.createdByName) || 'Team member',
      at: asDate(doc.createdAt) ?? new Date(0),
      completedAt: asDate(doc.completedAt),
      overdue: doc.status !== 'done' && !!dueDate && dueDate.getTime() < startOfToday,
      mine: text(doc.createdBy) === callerId,
      ...(text(doc.jobId) ? { jobId: text(doc.jobId) } : {}),
    };
  }

  private note(doc: Doc, callerId: string): CustomerNote {
    return {
      id: doc._id.toString(),
      body: text(doc.body),
      author: text(doc.createdByName) || 'Team member',
      at: asDate(doc.createdAt) ?? new Date(0),
      mine: text(doc.createdBy) === callerId,
      ...(text(doc.jobId) ? { jobId: text(doc.jobId) } : {}),
    };
  }

  private file(doc: Doc, callerId: string): CustomerFile {
    const meta = (doc.metadata ?? {}) as Doc;
    return {
      id: doc._id.toString(),
      name: text(doc.filename) || 'File',
      size: typeof doc.length === 'number' ? doc.length : 0,
      type: text(meta.contentType) || 'application/octet-stream',
      uploadedBy: text(meta.uploadedByName) || 'Team member',
      at: asDate(doc.uploadDate) ?? new Date(0),
      mine: text(meta.uploadedBy) === callerId,
      ...(text(meta.jobId) ? { jobId: text(meta.jobId) } : {}),
      kind: meta.kind === 'proof' ? 'proof' : 'file',
      ...(meta.copiedFrom?.provider === 'google_drive' || meta.copiedFrom?.provider === 'onedrive' ? { copiedFrom: meta.copiedFrom.provider } : {}),
      ...(meta.kind === 'proof'
        ? { proofStatus: text(meta.proofStatus) || 'awaiting', ...(text(meta.proofNote) ? { proofNote: text(meta.proofNote) } : {}) }
        : {}),
    };
  }

  /** Whose workspace a call is about: a customer's whole one, or one job's corner of it. */
  private async target(organizationId: string, customerId: string, job?: JobScope) {
    if (job)
      return {
        id: job.customerId,
        keys: job.customerKeys,
        jobId: job.jobId as string | undefined,
        emails: [] as string[],
        dealIds: [] as string[],
        quoteIds: [] as string[],
      };
    return { ...(await this.directory.identity(organizationId, customerId)), jobId: undefined as string | undefined };
  }

  private theirs(organizationId: string, target: { keys: string[]; jobId?: string }) {
    return { organizationId, customerKeys: { $in: target.keys }, ...(target.jobId ? { jobId: target.jobId } : {}) };
  }

  private filesOf(organizationId: string, target: { keys: string[]; jobId?: string }) {
    return {
      'metadata.organizationId': organizationId,
      'metadata.customerKeys': { $in: target.keys },
      ...(target.jobId ? { 'metadata.jobId': target.jobId } : {}),
    };
  }

  /** Everything the team has attached to one customer — or, with `job`, to that one job — for the panel. */
  async overview(caller: JwtPayload, customerId: string, job?: JobScope): Promise<CustomerWorkspace> {
    const organizationId = caller.organizationId;
    const customer = await this.target(organizationId, customerId, job);
    const theirs = this.theirs(organizationId, customer);
    const [notes, tasks, files, team, linkedTasks] = await Promise.all([
      this.connection.collection(NOTES_COLLECTION).find(theirs).sort({ createdAt: -1 }).limit(LIST_LIMIT).toArray(),
      this.connection.collection(TASKS_COLLECTION).find(theirs).sort({ createdAt: -1 }).limit(LIST_LIMIT).toArray(),
      this.connection.collection(`${FILES_BUCKET}.files`).find(this.filesOf(organizationId, customer)).sort({ uploadDate: -1 }).limit(LIST_LIMIT).toArray(),
      this.team(organizationId),
      job ? Promise.resolve([] as LinkedTask[]) : this.linkedTasks(organizationId, customer),
    ]);
    // On the customer, what belongs to a job says which one.
    const jobIds = [...new Set([...notes.map((n) => text(n.jobId)), ...tasks.map((t) => text(t.jobId)), ...files.map((f) => text(f.metadata?.jobId))])].filter(
      (id) => Types.ObjectId.isValid(id),
    );
    const numbers = new Map<string, string>();
    if (!job && jobIds.length > 0) {
      const jobs = await this.connection
        .collection(JOBS_COLLECTION)
        .find({ organizationId, _id: { $in: jobIds.map((id) => new Types.ObjectId(id)) } }, { projection: { number: 1 } })
        .toArray();
      for (const found of jobs) numbers.set(found._id.toString(), text(found.number));
    }
    const tagged = <T extends { jobId?: string }>(item: T): T =>
      item.jobId && numbers.has(item.jobId) ? { ...item, jobNumber: numbers.get(item.jobId) } : item;
    const open = (t: CustomerTask) => (t.status === 'open' ? 0 : 1);
    return {
      notes: notes.map((n) => tagged(this.note(n, caller.sub))),
      // Open ones first, the soonest due at the top; then what is done.
      tasks: tasks
        .map((t) => tagged(this.task(t, team, caller.sub)))
        .sort((a, b) => open(a) - open(b) || (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity) || b.at.getTime() - a.at.getTime()),
      files: files.map((f) => tagged(this.file(f, caller.sub))),
      linkedTasks,
      assignees: [...team.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      canManage: this.canManage(caller),
      limits: { maxFileBytes: UPLOAD_FILE_SIZE_LIMIT_BYTES, maxFiles: MAX_FILES_PER_CUSTOMER },
    };
  }

  /** To-Do tasks the daily report tied to one of this customer's deals, quotations or emails. Read-only here. */
  private async linkedTasks(organizationId: string, customer: { emails: string[]; dealIds: string[]; quoteIds: string[] }): Promise<LinkedTask[]> {
    const messages = customer.emails.length
      ? await this.connection
          .collection('email_intelligence_items')
          .find({ organizationId, $expr: { $in: [{ $toLower: '$fromAddress' }, customer.emails] } }, { projection: { externalMessageId: 1 } })
          .limit(500)
          .toArray()
      : [];
    const messageIds = messages.map((m) => text(m.externalMessageId)).filter(Boolean);
    const named: Doc[] = [];
    if (customer.dealIds.length) named.push({ 'tasks.relatedDealId': { $in: customer.dealIds } });
    if (customer.quoteIds.length) named.push({ 'tasks.relatedQuoteId': { $in: customer.quoteIds } });
    if (messageIds.length) named.push({ 'tasks.relatedEmailId': { $in: messageIds } });
    if (named.length === 0) return [];
    const reports = await this.connection
      .collection('daily_reports')
      .find({ organizationId, $or: named }, { projection: { date: 1, tasks: 1 } })
      .sort({ date: -1 })
      .limit(60)
      .toArray();
    const [deals, quotes, mails] = [new Set(customer.dealIds), new Set(customer.quoteIds), new Set(messageIds)];
    return reports
      .flatMap((report) =>
        (Array.isArray(report.tasks) ? (report.tasks as Doc[]) : [])
          .filter((t) => deals.has(text(t.relatedDealId)) || quotes.has(text(t.relatedQuoteId)) || mails.has(text(t.relatedEmailId)))
          .map((t) => ({ id: t._id.toString(), title: text(t.title), priority: text(t.priority), status: text(t.status), date: text(report.date) })),
      )
      .slice(0, LINKED_TASK_LIMIT);
  }

  // ---- comments ----------------------------------------------------------------------

  async addNote(caller: JwtPayload, customerId: string, body: string, job?: JobScope): Promise<CustomerNote> {
    const written = body.trim();
    if (!written) throw new BadRequestException('Write something first.');
    const customer = await this.target(caller.organizationId, customerId, job);
    const author = await this.nameOf(caller);
    const at = new Date();
    const { insertedId } = await this.connection.collection(NOTES_COLLECTION).insertOne({
      organizationId: caller.organizationId,
      customerId: customer.id,
      customerKeys: customer.keys,
      ...(customer.jobId ? { jobId: customer.jobId } : {}),
      body: written,
      createdBy: caller.sub,
      createdByName: author,
      createdAt: at,
    });
    return { id: insertedId.toString(), body: written, author, at, mine: true, ...(customer.jobId ? { jobId: customer.jobId } : {}) };
  }

  async removeNote(caller: JwtPayload, customerId: string, noteId: string, job?: JobScope): Promise<void> {
    const customer = await this.target(caller.organizationId, customerId, job);
    const filter = { _id: this.objectId(noteId, 'Comment'), ...this.theirs(caller.organizationId, customer) };
    const note = await this.connection.collection(NOTES_COLLECTION).findOne(filter, { projection: { createdBy: 1 } });
    if (!note) throw new NotFoundException('Comment not found.');
    if (text(note.createdBy) !== caller.sub && !this.canManage(caller))
      throw new ForbiddenException('Only the person who wrote a comment, or an administrator, can delete it.');
    await this.connection.collection(NOTES_COLLECTION).deleteOne(filter);
  }

  // ---- tasks -------------------------------------------------------------------------

  /** The person a task is given to must be one of this organization's team. */
  private async assignee(organizationId: string, assigneeId: string | null | undefined, team?: Map<string, string>) {
    if (!assigneeId) return { assigneeId: undefined, assigneeName: undefined, team: team ?? (await this.team(organizationId)) };
    const people = team ?? (await this.team(organizationId));
    const assigneeName = people.get(assigneeId);
    if (!assigneeName) throw new BadRequestException('That person isn’t part of your team.');
    return { assigneeId, assigneeName, team: people };
  }

  async addTask(caller: JwtPayload, customerId: string, dto: CreateCustomerTaskDto, job?: JobScope): Promise<CustomerTask> {
    const title = dto.title.trim();
    if (!title) throw new BadRequestException('Give the task a title.');
    const organizationId = caller.organizationId;
    const customer = await this.target(organizationId, customerId, job);
    const { assigneeId, assigneeName, team } = await this.assignee(organizationId, dto.assigneeId);
    const doc = {
      organizationId,
      customerId: customer.id,
      customerKeys: customer.keys,
      ...(customer.jobId ? { jobId: customer.jobId } : {}),
      title,
      ...(dto.dueDate ? { dueDate: new Date(dto.dueDate) } : {}),
      ...(assigneeId ? { assigneeId, assigneeName } : {}),
      status: 'open',
      createdBy: caller.sub,
      createdByName: team.get(caller.sub) ?? (text(caller.email) || 'Team member'),
      createdAt: new Date(),
    };
    const { insertedId } = await this.connection.collection(TASKS_COLLECTION).insertOne(doc);
    // An open task shows on the board as a follow-up.
    this.directory.invalidate(organizationId);
    return this.task({ ...doc, _id: insertedId }, team, caller.sub);
  }

  async updateTask(caller: JwtPayload, customerId: string, taskId: string, dto: UpdateCustomerTaskDto, job?: JobScope): Promise<CustomerTask> {
    const organizationId = caller.organizationId;
    const customer = await this.target(organizationId, customerId, job);
    const filter = { _id: this.objectId(taskId, 'Task'), ...this.theirs(organizationId, customer) };
    const set: Doc = {};
    const unset: Doc = {};
    if (dto.title !== undefined) {
      if (!dto.title.trim()) throw new BadRequestException('Give the task a title.');
      set.title = dto.title.trim();
    }
    if (dto.dueDate === null) unset.dueDate = '';
    else if (dto.dueDate !== undefined) set.dueDate = new Date(dto.dueDate);
    let team: Map<string, string> | undefined;
    if (dto.assigneeId === null) Object.assign(unset, { assigneeId: '', assigneeName: '' });
    else if (dto.assigneeId !== undefined) {
      const chosen = await this.assignee(organizationId, dto.assigneeId);
      team = chosen.team;
      Object.assign(set, { assigneeId: chosen.assigneeId, assigneeName: chosen.assigneeName });
    }
    if (dto.status === 'done') Object.assign(set, { status: 'done', completedAt: new Date(), completedBy: caller.sub });
    if (dto.status === 'open') {
      set.status = 'open';
      Object.assign(unset, { completedAt: '', completedBy: '' });
    }
    if (Object.keys(set).length + Object.keys(unset).length === 0) throw new BadRequestException('Nothing to change.');
    const updated = await this.connection
      .collection(TASKS_COLLECTION)
      .findOneAndUpdate(
        filter,
        { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { returnDocument: 'after' },
      );
    if (!updated) throw new NotFoundException('Task not found.');
    this.directory.invalidate(organizationId);
    return this.task(updated, team ?? (await this.team(organizationId)), caller.sub);
  }

  async removeTask(caller: JwtPayload, customerId: string, taskId: string, job?: JobScope): Promise<void> {
    const customer = await this.target(caller.organizationId, customerId, job);
    const filter = { _id: this.objectId(taskId, 'Task'), ...this.theirs(caller.organizationId, customer) };
    const task = await this.connection.collection(TASKS_COLLECTION).findOne(filter, { projection: { createdBy: 1 } });
    if (!task) throw new NotFoundException('Task not found.');
    if (text(task.createdBy) !== caller.sub && !this.canManage(caller))
      throw new ForbiddenException('Only the person who added a task, or an administrator, can delete it.');
    await this.connection.collection(TASKS_COLLECTION).deleteOne(filter);
    this.directory.invalidate(caller.organizationId);
  }

  // ---- files -------------------------------------------------------------------------

  /** Attaches a file to a customer, or — with `job` — to that job; `kind: 'proof'` makes it an artwork proof awaiting approval. */
  async addFile(
    caller: JwtPayload,
    customerId: string,
    upload: Express.Multer.File | undefined,
    job?: JobScope,
    kind: 'file' | 'proof' = 'file',
  ): Promise<CustomerFile> {
    if (!upload?.buffer?.length) throw new BadRequestException('Choose a file to upload.');
    // Files are only ever handed back as downloads, never shown in the page — but nothing that runs is taken in.
    const name = cleanFileName(upload.originalname);
    assertAcceptableFile(name);
    const organizationId = caller.organizationId;
    const customer = await this.target(organizationId, customerId, job);
    // The limit is the customer's, whichever job a file is attached on.
    const count = await this.connection.collection(`${FILES_BUCKET}.files`).countDocuments(this.filesOf(organizationId, { keys: customer.keys }));
    if (count >= MAX_FILES_PER_CUSTOMER) throw new BadRequestException(`A customer can hold up to ${MAX_FILES_PER_CUSTOMER} files. Delete one to add another.`);
    const uploadedByName = await this.nameOf(caller);
    const metadata = {
      organizationId,
      customerId: customer.id,
      customerKeys: customer.keys,
      ...(customer.jobId ? { jobId: customer.jobId } : {}),
      kind,
      ...(kind === 'proof' ? { proofStatus: 'awaiting' } : {}),
      contentType: text(upload.mimetype) || 'application/octet-stream',
      uploadedBy: caller.sub,
      uploadedByName,
    };
    const id = await this.gridFs.upload(FILES_BUCKET, name, upload.buffer, metadata);
    return {
      id,
      name,
      size: upload.buffer.length,
      type: metadata.contentType,
      uploadedBy: uploadedByName,
      at: new Date(),
      mine: true,
      ...(customer.jobId ? { jobId: customer.jobId } : {}),
      kind,
      ...(kind === 'proof' ? { proofStatus: 'awaiting' } : {}),
    };
  }

  private async foundFile(caller: JwtPayload, customerId: string, fileId: string, job?: JobScope): Promise<Doc> {
    const customer = await this.target(caller.organizationId, customerId, job);
    const doc = await this.connection
      .collection(`${FILES_BUCKET}.files`)
      .findOne({ _id: this.objectId(fileId, 'File'), ...this.filesOf(caller.organizationId, customer) });
    if (!doc) throw new NotFoundException('File not found.');
    return doc;
  }

  async openFile(caller: JwtPayload, customerId: string, fileId: string, job?: JobScope): Promise<{ stream: NodeJS.ReadableStream; file: CustomerFile }> {
    const doc = await this.foundFile(caller, customerId, fileId, job);
    return { stream: this.gridFs.openDownloadStream(FILES_BUCKET, doc._id.toString()), file: this.file(doc, caller.sub) };
  }

  /** Where a job's artwork proof stands: awaiting approval, approved, or changes needed (with what to change). */
  async setProof(caller: JwtPayload, job: JobScope, fileId: string, status: string, note?: string): Promise<CustomerFile> {
    if (!PROOF_STATUSES.some((o) => o.status === status)) throw new BadRequestException('That isn’t one of the options for a proof.');
    const doc = await this.foundFile(caller, job.customerId, fileId, job);
    if (doc.metadata?.kind !== 'proof') throw new NotFoundException('Proof not found.');
    const written = (note ?? '').trim().slice(0, 500);
    await this.connection.collection(`${FILES_BUCKET}.files`).updateOne({ _id: doc._id }, {
      $set: {
        'metadata.proofStatus': status,
        'metadata.proofBy': caller.sub,
        'metadata.proofAt': new Date(),
        ...(written ? { 'metadata.proofNote': written } : {}),
      },
      ...(written ? {} : { $unset: { 'metadata.proofNote': '' } }),
    } as Doc);
    return this.file({ ...doc, metadata: { ...doc.metadata, proofStatus: status, proofNote: written || undefined } }, caller.sub);
  }

  async removeFile(caller: JwtPayload, customerId: string, fileId: string, job?: JobScope): Promise<CustomerFile> {
    const doc = await this.foundFile(caller, customerId, fileId, job);
    if (text(doc.metadata?.uploadedBy) !== caller.sub && !this.canManage(caller))
      throw new ForbiddenException('Only the person who added a file, or an administrator, can delete it.');
    await this.gridFs.delete(FILES_BUCKET, doc._id.toString());
    return this.file(doc, caller.sub);
  }

  // ---- statuses set by hand ------------------------------------------------------------

  /**
   * Sets one step of a customer to a status the team chooses, or (status null) back to what the connected
   * systems say. Saved in HaiVE only — no CRM is written to. One record per customer holds the choice for
   * each step, with who made every change.
   */
  async setStatus(caller: JwtPayload, customerId: string, stage: StageKey, status: string | null): Promise<{ stage: StageKey; status: string | null }> {
    const organizationId = caller.organizationId;
    if (status !== null && !STAGE_OPTIONS[stage].some((o) => o.status === status))
      throw new BadRequestException('That isn’t one of the options for this status.');
    const customer = await this.directory.identity(organizationId, customerId);
    const statuses = this.connection.collection(STATUSES_COLLECTION);
    // Two rows that became one customer may each have a record: the newest is kept current, the others let go of this step.
    const records = await statuses
      .find({ organizationId, customerKeys: { $in: customer.keys } }, { projection: { customerKeys: 1 } })
      .sort({ updatedAt: -1 })
      .toArray();
    const at = new Date();
    const byName = await this.nameOf(caller);
    const change = { stage, status, by: caller.sub, byName, at };
    const [record, ...older] = records;
    if (!record && status === null) return { stage, status };
    if (!record) {
      await statuses.insertOne({
        organizationId,
        customerId: customer.id,
        customerKeys: customer.keys,
        stages: { [stage]: { status, by: caller.sub, byName, at } },
        history: [change],
        createdAt: at,
        updatedAt: at,
      });
    } else {
      const keys = [...new Set([...(Array.isArray(record.customerKeys) ? record.customerKeys.map(text) : []), ...customer.keys])];
      await statuses.updateOne({ _id: record._id, organizationId }, {
        $set: {
          customerId: customer.id,
          customerKeys: keys,
          updatedAt: at,
          ...(status === null ? {} : { [`stages.${stage}`]: { status, by: caller.sub, byName, at } }),
        },
        ...(status === null ? { $unset: { [`stages.${stage}`]: '' } } : {}),
        $push: { history: { $each: [change], $slice: -STATUS_HISTORY_LIMIT } },
      } as Doc);
      if (older.length > 0) await statuses.updateMany({ _id: { $in: older.map((r) => r._id) }, organizationId }, { $unset: { [`stages.${stage}`]: '' } });
    }
    // The board, its tiles and its reminders all read this.
    this.directory.invalidate(organizationId);
    return { stage, status };
  }
}

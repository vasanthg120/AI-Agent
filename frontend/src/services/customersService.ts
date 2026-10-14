import { axiosClient } from '@/api/axiosClient';

// Customers (backend/src/customer-intelligence): one row per customer, built
// from every connected CRM and the mailbox together — enquiries, deals,
// quotations, invoices, payments and email matched to the same customer. The
// backend sends only what the page shows; nothing raw from a CRM.

export interface NamedValue {
  name: string;
  value: string;
}

export interface TimelineEvent {
  at: string;
  // The last five are the team's own: what it wrote, set itself to do, attached, set by hand, and the jobs it made.
  kind:
    | 'contact'
    | 'enquiry'
    | 'deal'
    | 'quotation'
    | 'order'
    | 'payment'
    | 'email_received'
    | 'email_sent'
    | 'follow_up'
    | 'comment'
    | 'task'
    | 'file'
    | 'status'
    | 'job';
  title: string;
  detail?: string;
  amount?: number;
  // Something is still owed on this event (an unanswered email, an open quotation, a follow-up that is due).
  attention?: boolean;
}

export type CustomerType = 'new' | 'existing' | 'returning';
export type QuoteState = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';
export type InvoiceStatus = 'draft' | 'invoiced' | 'paid';
export type PaymentState = 'paid' | 'partially_paid' | 'unpaid' | 'overdue' | 'not_recorded' | 'nothing_due';
export type OrderState = 'converted' | 'previous_order' | 'not_converted' | 'none';
export type MailState = 'reply_needed' | 'follow_up' | 'not_replied' | 'replied' | 'not_contacted' | 'none';
export type CrmState = 'lead' | 'opportunity' | 'customer' | 'lost';
export type CustomerFlag =
  'reply_needed' | 'follow_up_required' | 'quote_pending' | 'payment_pending' | 'payment_overdue';

// A job made from one of the customer's quotations (services/customerJobsService.ts).
export interface JobRef {
  id: string;
  number: string;
}

// One step of the work with a customer, as the board shows it: a coloured chip and one line under it.
export type StageKey = 'inquiry' | 'quote' | 'order' | 'payment' | 'email' | 'followUp';
// done: finished · progress: moving · waiting: needs attention soon · attention: act now · muted: just a fact · none: nothing there.
export type StageTone = 'done' | 'progress' | 'waiting' | 'attention' | 'muted' | 'none';
export interface Stage {
  key: StageKey;
  title: string;
  label: string;
  tone: StageTone;
  detail?: string;
  // The status as a value ("sent", "paid"…).
  status: string;
  // Present when the team set this step by hand: its full name, who and when, and what the connected systems say instead.
  manual?: { label: string; by?: string; at?: string; automatic: string };
}
// What a status can be set to by hand, as the panel's dropdowns offer it.
export interface StageOption {
  status: string;
  label: string;
  tone: StageTone;
}
export type FollowUpState = 'overdue' | 'today' | 'upcoming' | 'none';

export interface CustomerAction {
  // overdue: should already have happened · today · soon · none: nothing to do.
  urgency: 'overdue' | 'today' | 'soon' | 'none';
  title: string;
  detail: string;
}

export interface QuoteLine {
  id: string;
  number?: string;
  name?: string;
  date?: string;
  amount: number;
  state: QuoteState;
  stateLabel: string;
  expiresAt?: string;
}

export interface InvoiceLine {
  id: string;
  number?: string;
  date?: string;
  amount: number;
  status: InvoiceStatus;
  statusLabel: string;
  // Null when what was paid isn't recorded.
  paid: number | null;
  outstanding: number | null;
  dueDate?: string;
  overdue: boolean;
  cost: number | null;
  marginPct: number | null;
  quotationNumber?: string;
}

export interface Customer {
  id: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  // The connected systems this customer's records came from.
  sources: string[];
  currency: string;
  type: CustomerType;
  typeLabel: string;
  typeReason: string;
  active: boolean;
  lastActivity: { at: string; label: string } | null;
  daysSinceLastActivity: number | null;
  // Who looks after them in the CRM: the owner of their latest quotation, else of their deal.
  owner?: string;
  inquiries: {
    count: number;
    latestAt?: string;
    latestSummary?: string;
    open: boolean;
    channel?: string;
    location?: string;
  };
  quotes: { count: number; openCount: number; openValue: number; latest: QuoteLine | null };
  invoices: { count: number; total: number; latest: InvoiceLine | null };
  payment: {
    status: PaymentState;
    label: string;
    billed: number;
    paid: number | null;
    outstanding: number | null;
    overdueAmount: number;
  };
  orders: { status: OrderState; label: string; count: number; totalValue: number; lastOrderAt?: string };
  mail: {
    status: MailState;
    label: string;
    received: number;
    sent: number;
    unanswered: number;
    lastReceivedAt?: string;
    lastSentAt?: string;
  };
  crm: { status: CrmState; label: string };
  // What is still to do: reminders on their emails and the team's own tasks.
  followUp: { status: FollowUpState; label: string; count: number; nextAt?: string; nextTitle?: string };
  flags: CustomerFlag[];
  // The jobs made from their quotations, newest first.
  jobs: JobRef[];
  nextAction: CustomerAction;
  // The whole picture in two or three sentences, worked out from the records.
  insight: string;
  // Inquiry → Quote → Order → Payment → Email → Follow-up.
  stages: Stage[];
  // The saved AI summary, when one was written and nothing has changed since.
  aiSummary?: string;
}

export interface OrderComparison {
  previous: { label: string; date?: string; value: number; marginPct: number | null };
  current: { label: string; date?: string; value: number; marginPct: number | null; isQuotation: boolean };
  valueDifference: number;
  valueDifferencePct: number | null;
  marginDifference: number | null;
  note: string;
}

export interface CustomerAnalysis {
  statusLabel: string;
  summary: string;
  nextAction: string;
  recommendations: string[];
  issues: string[];
  pricingAdvice: string;
  suggestedMessage: string;
  generatedAt: string;
  stale: boolean;
}

// Somebody the customer's records name, with how to reach them.
export interface CustomerPerson {
  name?: string;
  email?: string;
  phone?: string;
}

// How a customer's records hang together: inquiry → deal → quotation → job → invoice → payment.
// A job is HaiVE's own: a quotation the team decided to produce.
export type RecordKind = 'inquiry' | 'deal' | 'quotation' | 'job' | 'invoice' | 'payment';
export interface JourneyStep {
  kind: RecordKind;
  title: string;
  detail?: string;
  at?: string;
  tone: StageTone;
  // The quotation or invoice this step opens, when it is one.
  documentId?: string;
  // The job this step opens, when it is one.
  jobId?: string;
  // Placed here by its date, not by a link the record carries.
  byDate?: boolean;
}
export interface Journey {
  at?: string;
  steps: JourneyStep[];
}

// One quotation or invoice in full, with what it is connected to.
export interface CustomerDocument {
  id: string;
  kind: 'quotation' | 'invoice';
  number?: string;
  title?: string;
  date?: string;
  amount: number;
  status: string;
  tone: StageTone;
  owner?: string;
  source?: string;
  validUntil?: string;
  dueDate?: string;
  preparedFor: { company?: string; contact?: string; email?: string; phone?: string };
  // Product lines, when the system that holds the document records them.
  lines: { description: string; detail?: string; quantity: number; unitPrice: number; total: number }[];
  // The items alone, before tax and fees. Null when there are no items.
  subtotal: number | null;
  // Tax and fees added on top of the items.
  charges: { kind: 'tax' | 'fee'; name: string; amount: number }[];
  // Where the items are held: on the document itself, or on the deal it was raised from.
  linesFrom?: 'document' | 'deal';
  // Said when the items (with tax and fees) don't come to the document's amount.
  linesNote?: string;
  // Null when what was paid isn't recorded.
  paid: number | null;
  outstanding: number | null;
  payments: { date: string; amount: number }[];
  links: JourneyStep[];
  // The job a quotation was converted into, when it was.
  job?: JobRef;
}

export interface CustomerEmail {
  id: string;
  direction: 'received' | 'sent';
  at: string;
  subject: string;
  needsReply: boolean;
}

export interface CustomerFollowUp {
  title: string;
  dueDate: string;
  status: 'pending' | 'done' | 'dismissed';
  // Still to do, and its day has come or passed.
  due: boolean;
}

// ---- what the team attaches to a customer: comments, tasks, files (saved in HaiVE only) ----
// Each may belong to one of the customer's jobs: it then shows on the job, and here tagged with it.

export interface CustomerNote {
  id: string;
  body: string;
  author: string;
  at: string;
  mine: boolean;
  jobId?: string;
  jobNumber?: string;
}

export interface CustomerTask {
  id: string;
  title: string;
  dueDate?: string;
  status: 'open' | 'done';
  assigneeId?: string;
  assignee?: string;
  createdBy: string;
  at: string;
  completedAt?: string;
  overdue: boolean;
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
  at: string;
  mine: boolean;
  jobId?: string;
  jobNumber?: string;
  // An artwork proof of a job, with where its approval stands.
  kind: 'file' | 'proof';
  proofStatus?: string;
  proofNote?: string;
}

// A task from the To-Do list that names one of this customer's records.
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
  assignees: { id: string; name: string }[];
  // Whether the viewer may remove what others added (owners and admins).
  canManage: boolean;
  limits: { maxFileBytes: number; maxFiles: number };
}

export interface CustomerTaskInput {
  title: string;
  dueDate?: string;
  assigneeId?: string;
}

// `dueDate` / `assigneeId` set to null clear them.
export interface CustomerTaskChange {
  status?: 'open' | 'done';
  title?: string;
  dueDate?: string | null;
  assigneeId?: string | null;
}

// Writing comments, tasks and files — on a customer, or on one of their jobs. The Comments, Tasks and
// Files tabs work through this, so the same tabs serve the customer panel and the job panel.
export interface WorkspaceApi {
  addNote(body: string): Promise<CustomerNote>;
  removeNote(noteId: string): Promise<void>;
  addTask(task: CustomerTaskInput): Promise<CustomerTask>;
  updateTask(taskId: string, change: CustomerTaskChange): Promise<CustomerTask>;
  removeTask(taskId: string): Promise<void>;
  uploadFile(file: File): Promise<CustomerFile>;
  downloadFile(fileId: string): Promise<Blob>;
  removeFile(fileId: string): Promise<void>;
}

export interface CustomerDetail extends Customer {
  // Everyone their records name, newest first.
  people: CustomerPerson[];
  address?: string;
  // What each of the six statuses can be set to by hand.
  statusOptions: Record<StageKey, StageOption[]>;
  // Inquiry → deal → quotation → invoice → payment, one chain per piece of business, newest first.
  journeys: Journey[];
  // Every quotation and invoice in full, each with what it is connected to.
  documents: CustomerDocument[];
  emails: CustomerEmail[];
  followUps: CustomerFollowUp[];
  // What they asked for most recently, in their words.
  inquiry: {
    receivedAt?: string;
    fields: NamedValue[];
    form?: string;
    channel?: string;
    location?: string;
    source: string;
  } | null;
  quotations: QuoteLine[];
  invoiceList: InvoiceLine[];
  comparison: OrderComparison | null;
  // Information that is missing, or that disagrees between systems.
  gaps: string[];
  timeline: TimelineEvent[];
  customerRepliesInDays: number | null;
  weReplyInHours: number | null;
  analysis: CustomerAnalysis | null;
}

export interface CustomerSource {
  id: string;
  label: string;
  customers: number;
  connected: boolean;
  // Whether "Sync now" can pull from it.
  canSync: boolean;
  lastSyncAt?: string;
  // Why the last sync failed, when it did.
  lastError?: string;
}

export interface CustomerSyncResult {
  results: { source: string; ok: boolean; error?: string }[];
}

export interface CustomerStats {
  total: number;
  // Customers with an inquiry no order has closed yet.
  openInquiries: number;
  existing: number;
  quotePending: number;
  quotePendingValue: number;
  paymentPending: number;
  outstanding: number;
  needsFollowUp: number;
}

export type CustomerSort =
  'activity' | 'name' | 'owner' | 'type' | 'quotes' | 'invoices' | 'payment' | 'orders' | 'followUp' | 'urgency';

// The board's filters. Each holds the values to keep; "none" stands for having no such thing.
export type CustomerFilterKey = 'owner' | 'type' | 'quote' | 'payment' | 'mail' | 'channel';
export type CustomerFilters = Partial<Record<CustomerFilterKey, string[]>>;

export interface CustomerListResponse {
  sources: CustomerSource[];
  currency: string;
  stats: CustomerStats;
  // What the Owner and Inquiry-channel filters can offer: the values these customers really have.
  filterOptions: { owners: string[]; channels: string[] };
  total: number;
  page: number;
  pageSize: number;
  sort: CustomerSort;
  direction: 'asc' | 'desc';
  items: Customer[];
}

export interface CustomerQuery {
  // A source id, or 'all'.
  source?: string;
  // Only customers with something happening between these two moments (ISO).
  from?: string;
  to?: string;
  // One of the views the backend knows (existing, quote_pending, follow_up…), or 'all'.
  view?: string;
  search?: string;
  sort?: CustomerSort;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  filters?: CustomerFilters;
}

// What goes on the URL: empty values left out, each filter as one comma-separated list.
const toParams = ({ filters, ...query }: CustomerQuery) =>
  Object.fromEntries(
    [
      ...Object.entries(query),
      ...Object.entries(filters ?? {}).map(([key, values]) => [key, (values ?? []).join(',')]),
    ].filter(([, v]) => v !== undefined && v !== ''),
  );

export const customersService = {
  async list(query: CustomerQuery): Promise<CustomerListResponse> {
    const { data } = await axiosClient.get<CustomerListResponse>('/customers', { params: toParams(query) });
    return data;
  },

  // The board as a spreadsheet: the same view and filters, every page.
  async export(query: CustomerQuery): Promise<Blob> {
    const { page: _page, pageSize: _pageSize, ...rest } = query;
    const { data } = await axiosClient.get<Blob>('/customers/export', {
      params: toParams(rest),
      responseType: 'blob',
      timeout: 120_000,
    });
    return data;
  },

  async get(id: string): Promise<CustomerDetail> {
    const { data } = await axiosClient.get<CustomerDetail>(`/customers/${id}`);
    return data;
  },

  // Pulls the latest from the connected CRMs now: one source, or every one that can be synced.
  async sync(source?: string): Promise<CustomerSyncResult> {
    const { data } = await axiosClient.post<CustomerSyncResult>('/customers/sync', undefined, {
      params: source && source !== 'all' ? { source } : undefined,
      timeout: 200_000,
    });
    return data;
  },

  // Sets one of the six statuses by hand, or (null) hands it back to what the connected systems say.
  // Saved in HaiVE only: no CRM is changed.
  async setStatus(id: string, stage: StageKey, status: string | null): Promise<void> {
    await axiosClient.patch(`/customers/${id}/status`, { stage, status });
  },

  // Comments, tasks and files on one customer, and who a task can be given to.
  async workspace(id: string): Promise<CustomerWorkspace> {
    const { data } = await axiosClient.get<CustomerWorkspace>(`/customers/${id}/workspace`);
    return data;
  },

  async addNote(id: string, body: string): Promise<CustomerNote> {
    const { data } = await axiosClient.post<CustomerNote>(`/customers/${id}/notes`, { body });
    return data;
  },

  async removeNote(id: string, noteId: string): Promise<void> {
    await axiosClient.delete(`/customers/${id}/notes/${noteId}`);
  },

  async addTask(id: string, task: CustomerTaskInput): Promise<CustomerTask> {
    const { data } = await axiosClient.post<CustomerTask>(`/customers/${id}/tasks`, task);
    return data;
  },

  async updateTask(id: string, taskId: string, change: CustomerTaskChange): Promise<CustomerTask> {
    const { data } = await axiosClient.patch<CustomerTask>(`/customers/${id}/tasks/${taskId}`, change);
    return data;
  },

  async removeTask(id: string, taskId: string): Promise<void> {
    await axiosClient.delete(`/customers/${id}/tasks/${taskId}`);
  },

  async uploadFile(id: string, file: File): Promise<CustomerFile> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await axiosClient.post<CustomerFile>(`/customers/${id}/files`, form, { timeout: 180_000 });
    return data;
  },

  // The file itself: fetched with the viewer's session, then handed to the browser to save.
  async downloadFile(id: string, fileId: string): Promise<Blob> {
    const { data } = await axiosClient.get<Blob>(`/customers/${id}/files/${fileId}`, {
      responseType: 'blob',
      timeout: 180_000,
    });
    return data;
  },

  async removeFile(id: string, fileId: string): Promise<void> {
    await axiosClient.delete(`/customers/${id}/files/${fileId}`);
  },

  // The same calls with the customer filled in, for the Comments, Tasks and Files tabs.
  workspaceApi(id: string): WorkspaceApi {
    return {
      addNote: (body) => customersService.addNote(id, body),
      removeNote: (noteId) => customersService.removeNote(id, noteId),
      addTask: (task) => customersService.addTask(id, task),
      updateTask: (taskId, change) => customersService.updateTask(id, taskId, change),
      removeTask: (taskId) => customersService.removeTask(id, taskId),
      uploadFile: (file) => customersService.uploadFile(id, file),
      downloadFile: (fileId) => customersService.downloadFile(id, fileId),
      removeFile: (fileId) => customersService.removeFile(id, fileId),
    };
  },

  // A billed AI call; the saved analysis is reused unless the facts changed or `refresh` is set.
  async analyze(id: string, refresh = false): Promise<CustomerAnalysis> {
    const { data } = await axiosClient.post<CustomerAnalysis>(`/customers/${id}/analysis`, undefined, {
      params: refresh ? { refresh: true } : undefined,
      timeout: 120_000,
    });
    return data;
  },
};

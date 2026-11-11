import { axiosClient } from '@/api/axiosClient';
import type {
  CustomerFile,
  CustomerNote,
  CustomerTask,
  CustomerWorkspace,
  StageTone,
  WorkspaceApi,
} from './customersService';

// Jobs (backend/src/customer-intelligence/customer-jobs.service.ts): quotations
// the team decided to produce. A job is HaiVE's own record — made from a
// quotation by "Convert to job", numbered J-0001 onwards — and its seven
// statuses are set by hand. Nothing here is written to a CRM.

export type JobStatusKey = 'production' | 'payment' | 'purchasing' | 'orderType' | 'artwork' | 'orderStatus' | 'progress' | 'prodReady';

export type JobDocumentKind = 'job-sheet' | 'proof-sheet' | 'packing-slip' | 'decorator-spec-sheet' | 'shipping-label';

export interface JobStatusOption {
  status: string;
  label: string;
  // On a chip there is room for a dozen letters.
  short?: string;
  tone: StageTone;
}

export interface JobStatusColumn {
  key: JobStatusKey;
  title: string;
  options: JobStatusOption[];
}

// One of a job's seven statuses as the board shows it: a chip, empty until somebody sets it.
export interface JobStatusChip {
  key: JobStatusKey;
  title: string;
  // The chosen option's value, or '' while not set.
  status: string;
  label: string;
  full: string;
  tone: StageTone;
}

// The lists every dropdown of the Job board and the job panel reads.
export interface JobOptions {
  columns: JobStatusColumn[];
  items: JobStatusOption[];
  purchaseOrders: JobStatusOption[];
  proofs: JobStatusOption[];
  shipments: JobStatusOption[];
  credits: JobStatusOption[];
}

export interface Job {
  id: string;
  number: string;
  title: string;
  quotationId: string;
  quotationNumber?: string;
  createdAt: string;
  dueDate?: string;
  // Not done, and its due date has passed.
  overdue: boolean;
  done: boolean;
  owner?: string;
  // `id` is the customer's row today — absent when no connected system holds them any more.
  customer: { id?: string; name: string; company?: string };
  amount: number;
  currency: string;
  statuses: JobStatusChip[];
  // JobBoard spec additions — all additive, all optional.
  createdBy?: string;
  productionHouseVendorId?: string;
  productionHouseVendorName?: string;
  inHandsDate?: string;
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
  orderedAt?: string;
  expectedAt?: string;
  receivedAt?: string;
  deadline?: string;
  backorderDueDate?: string;
  addedBy: string;
  at: string;
}

export interface JobCredit {
  id: string;
  creditNumber?: string;
  description: string;
  amount?: number;
  status: string;
  label: string;
  tone: StageTone;
  createdByName: string;
  createdAt: string;
  deletedAt?: string;
}

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

export interface JobShipment {
  id: string;
  carrier: string;
  trackingNumber?: string;
  status: string;
  label: string;
  tone: StageTone;
  shippedAt?: string;
  deliveredAt?: string;
  note?: string;
  addedBy: string;
  at: string;
}

export interface JobEvent {
  at: string;
  by: string;
  text: string;
}

export interface JobDetail extends Job {
  // Who the job is for, as the quotation named them.
  contact: { name: string; company?: string; contact?: string; email?: string; phone?: string };
  quotationSource?: string;
  items: JobItem[];
  // The items alone, before tax and fees. Null when the quotation held no items.
  subtotal: number | null;
  charges: { kind: 'tax' | 'fee'; name: string; amount: number }[];
  purchaseOrders: JobPurchaseOrder[];
  shipments: JobShipment[];
  credits: JobCredit[];
  // What happened on the job, newest first.
  history: JobEvent[];
  createdBy: string;
  // Whether the viewer may delete the job (owners and admins).
  canManage: boolean;
  options: JobOptions;
}

export type JobSort = 'number' | 'created' | 'due' | 'customer' | 'owner' | 'amount';

export interface JobListResponse {
  items: Job[];
  total: number;
  page: number;
  pageSize: number;
  // How many jobs each quick view keeps.
  stats: Record<string, number>;
  owners: string[];
  options: JobOptions;
}

export interface JobQuery {
  // all, active, overdue, awaiting_payment, awaiting_artwork, to_order, done.
  view?: string;
  search?: string;
  sort?: JobSort;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  owner?: string;
  // The Customer Profile's own Jobs tab — every job of this one customer.
  customerId?: string;
  // SalesBoard's "View Linked Job" action.
  quotationId?: string;
  // One value per column: an option's value, or 'unset'.
  statuses?: Partial<Record<JobStatusKey, string>>;
  productionHouseVendorId?: string;
  voided?: 'only' | 'include';
  decorationId?: string;
  vendorId?: string;
  xeroLinked?: 'only' | 'unlinked';
  hasReference?: 'only' | 'missing';
}

// A purchase order or a shipment as its form sends it. null clears a field.
export type JobEntryInput = Record<string, string | number | null | undefined>;

const base = (jobId: string) => `/customer-jobs/${jobId}`;

export const customerJobsService = {
  async list({ statuses, ...query }: JobQuery): Promise<JobListResponse> {
    const params = Object.fromEntries(
      [...Object.entries(query), ...Object.entries(statuses ?? {})].filter(([, v]) => v !== undefined && v !== ''),
    );
    const { data } = await axiosClient.get<JobListResponse>('/customer-jobs', { params });
    return data;
  },

  async get(jobId: string): Promise<JobDetail> {
    const { data } = await axiosClient.get<JobDetail>(base(jobId));
    return data;
  },

  // Hoops-parity Job actions — Job Sheet / Proof Sheet / Packing Slip /
  // Decorator Spec Sheet / Shipping Label, each a real PDF built from the
  // job's own data (backend/src/customer-intelligence/customer-job-documents.service.ts).
  async downloadDocument(jobId: string, kind: JobDocumentKind): Promise<Blob> {
    const { data } = await axiosClient.get<Blob>(`${base(jobId)}/documents/${kind}`, { responseType: 'blob' });
    return data;
  },

  // "Convert to job" on one of a customer's quotations. Asking twice gives the same job.
  async convert(customerId: string, quotationId: string): Promise<{ job: JobDetail; created: boolean }> {
    const { data } = await axiosClient.post<{ job: JobDetail; created: boolean }>(`/customers/${customerId}/jobs`, {
      quotationId,
    });
    return data;
  },

  // `dueDate`/`productionHouseVendorId`/`inHandsDate`/`decorationId`/`xeroInvoiceNumber`
  // set to null removes that field.
  async update(
    jobId: string,
    change: {
      title?: string;
      dueDate?: string | null;
      productionHouseVendorId?: string | null;
      inHandsDate?: string | null;
      decorationId?: string | null;
      vendorIds?: string[];
      xeroInvoiceNumber?: string | null;
    },
  ): Promise<JobDetail> {
    const { data } = await axiosClient.patch<JobDetail>(base(jobId), change);
    return data;
  },

  // One of the eight statuses — or (null) back to not set. `proofFileId`
  // is required when moving Overall Status to a value that asserts
  // remittance was received (see customer-jobs.service.ts's
  // REMITTANCE_PROOF_REQUIRED) — must be a file already attached to this job.
  async setStatus(jobId: string, key: JobStatusKey, status: string | null, proofFileId?: string): Promise<JobDetail> {
    const { data } = await axiosClient.patch<JobDetail>(`${base(jobId)}/status`, { key, status, proofFileId });
    return data;
  },

  async setVoided(jobId: string, voided: boolean, reason?: string | null): Promise<JobDetail> {
    const { data } = await axiosClient.patch<JobDetail>(`${base(jobId)}/void`, { voided, reason });
    return data;
  },

  async setReferenceFile(jobId: string, file: File): Promise<JobDetail> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await axiosClient.post<JobDetail>(`${base(jobId)}/reference`, form);
    return data;
  },

  async downloadReferenceFile(jobId: string): Promise<Blob> {
    const { data } = await axiosClient.get<Blob>(`${base(jobId)}/reference`, { responseType: 'blob' });
    return data;
  },

  async getXeroInvoiceStatus(jobId: string): Promise<XeroInvoiceStatus> {
    const { data } = await axiosClient.get<XeroInvoiceStatus>(`${base(jobId)}/xero-invoice`);
    return data;
  },

  async setItemStatus(jobId: string, index: number, status: string): Promise<JobDetail> {
    const { data } = await axiosClient.patch<JobDetail>(`${base(jobId)}/items/${index}`, { status });
    return data;
  },

  async remove(jobId: string): Promise<void> {
    await axiosClient.delete(base(jobId));
  },

  // Purchase orders ('purchase-orders'), shipments ('shipments') and
  // credits ('credits') are all kept the same way.
  async addEntry(jobId: string, list: 'purchase-orders' | 'shipments' | 'credits', entry: JobEntryInput): Promise<JobDetail> {
    const { data } = await axiosClient.post<JobDetail>(`${base(jobId)}/${list}`, entry);
    return data;
  },

  async updateEntry(
    jobId: string,
    list: 'purchase-orders' | 'shipments' | 'credits',
    entryId: string,
    change: JobEntryInput,
  ): Promise<JobDetail> {
    const { data } = await axiosClient.patch<JobDetail>(`${base(jobId)}/${list}/${entryId}`, change);
    return data;
  },

  async removeEntry(jobId: string, list: 'purchase-orders' | 'shipments' | 'credits', entryId: string): Promise<JobDetail> {
    const { data } = await axiosClient.delete<JobDetail>(`${base(jobId)}/${list}/${entryId}`);
    return data;
  },

  // The job's comments, tasks, files and artwork proofs. They are its customer's own, tagged with the job.
  async workspace(jobId: string): Promise<CustomerWorkspace> {
    const { data } = await axiosClient.get<CustomerWorkspace>(`${base(jobId)}/workspace`);
    return data;
  },

  async uploadProof(jobId: string, file: File): Promise<CustomerFile> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await axiosClient.post<CustomerFile>(`${base(jobId)}/proofs`, form, { timeout: 180_000 });
    return data;
  },

  // Awaiting approval, approved, or changes needed — with what to change.
  async setProof(jobId: string, fileId: string, status: string, note?: string): Promise<CustomerFile> {
    const { data } = await axiosClient.patch<CustomerFile>(`${base(jobId)}/proofs/${fileId}`, {
      status,
      ...(note ? { note } : {}),
    });
    return data;
  },

  async sendProof(jobId: string, fileId: string): Promise<{ sent: boolean; to: string }> {
    const { data } = await axiosClient.post<{ sent: boolean; to: string }>(`${base(jobId)}/proofs/${fileId}/send`);
    return data;
  },

  // The same calls the customer panel makes, with the job filled in — for the Comments, Tasks and Files tabs.
  workspaceApi(jobId: string): WorkspaceApi {
    return {
      addNote: async (body) => (await axiosClient.post<CustomerNote>(`${base(jobId)}/notes`, { body })).data,
      removeNote: async (noteId) => {
        await axiosClient.delete(`${base(jobId)}/notes/${noteId}`);
      },
      addTask: async (task) => (await axiosClient.post<CustomerTask>(`${base(jobId)}/tasks`, task)).data,
      updateTask: async (taskId, change) =>
        (await axiosClient.patch<CustomerTask>(`${base(jobId)}/tasks/${taskId}`, change)).data,
      removeTask: async (taskId) => {
        await axiosClient.delete(`${base(jobId)}/tasks/${taskId}`);
      },
      uploadFile: async (file) => {
        const form = new FormData();
        form.append('file', file);
        return (await axiosClient.post<CustomerFile>(`${base(jobId)}/files`, form, { timeout: 180_000 })).data;
      },
      downloadFile: async (fileId) =>
        (await axiosClient.get<Blob>(`${base(jobId)}/files/${fileId}`, { responseType: 'blob', timeout: 180_000 }))
          .data,
      removeFile: async (fileId) => {
        await axiosClient.delete(`${base(jobId)}/files/${fileId}`);
      },
    };
  },
};

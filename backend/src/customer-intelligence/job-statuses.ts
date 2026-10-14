// What a job can be said to be. A job is HaiVE's own record — a quotation the
// team decided to produce — and none of the connected systems says where it
// stands in production, so every status here is set by hand from a dropdown.
// Defined once: the board, the panel and the validation all read these lists.

import { StageTone } from './customer-profile.builder';

export type JobStatusKey = 'production' | 'payment' | 'purchasing' | 'orderType' | 'artwork' | 'progress' | 'prodReady';

export interface JobStatusOption {
  status: string;
  label: string;
  /** On a chip there is room for a dozen letters. */
  short?: string;
  tone: StageTone;
}

export interface JobStatusColumn {
  key: JobStatusKey;
  title: string;
  options: JobStatusOption[];
}

const option = (status: string, label: string, tone: StageTone, short?: string): JobStatusOption => ({ status, label, tone, ...(short ? { short } : {}) });

/** The seven columns of the Job board, left to right. Each starts empty and is set by the team. */
export const JOB_STATUS_COLUMNS: JobStatusColumn[] = [
  {
    key: 'production',
    title: 'Production',
    options: [option('in_house', 'In house', 'progress'), option('outsourced', 'Outsourced', 'progress'), option('not_started', 'Not started', 'muted')],
  },
  {
    key: 'payment',
    title: 'Payment',
    options: [
      option('waiting_payment', 'Waiting for payment', 'waiting', 'Awaiting pay'),
      option('waiting_remittance', 'Waiting for remittance', 'attention', 'Remittance'),
      option('received', 'Payment received', 'done', 'Received'),
    ],
  },
  {
    key: 'purchasing',
    title: 'Purchasing',
    options: [
      option('need_to_order', 'Need to order', 'waiting', 'To order'),
      option('ready_to_order', 'Ready to order', 'progress', 'Ready'),
      option('ordered', 'Ordered', 'progress'),
      option('received', 'Received', 'done'),
      // The customer supplies the goods: nothing to buy.
      option('byo', 'BYO', 'muted'),
    ],
  },
  {
    key: 'orderType',
    title: 'Order type',
    options: [option('normal', 'Normal', 'muted'), option('priority', 'Priority', 'waiting'), option('rush', 'Rush', 'attention')],
  },
  {
    key: 'artwork',
    title: 'Artwork',
    options: [
      option('awaiting_approval', 'Awaiting artwork approval', 'waiting', 'Awaiting OK'),
      option('approved', 'Artwork approved', 'progress', 'Approved'),
      option('completed', 'Order completed', 'done', 'Completed'),
    ],
  },
  {
    key: 'progress',
    title: 'Progress',
    options: [option('in_progress', 'In progress', 'progress'), option('done', 'Done', 'done')],
  },
  {
    key: 'prodReady',
    title: 'Prod ready',
    options: [option('not_ready', 'Not ready yet', 'attention', 'Not ready'), option('ready', 'Production ready', 'done', 'Ready')],
  },
];

export const JOB_STATUS_KEYS = JOB_STATUS_COLUMNS.map((column) => column.key);

/** Each item of a job, each purchase order, each proof and each shipment has a short status of its own. */
export const ITEM_STATUSES: JobStatusOption[] = [
  option('not_started', 'Not started', 'none'),
  option('in_progress', 'In progress', 'progress'),
  option('done', 'Done', 'done'),
];
export const PURCHASE_ORDER_STATUSES: JobStatusOption[] = [
  option('to_order', 'To order', 'waiting'),
  option('ordered', 'Ordered', 'progress'),
  option('received', 'Received', 'done'),
];
export const PROOF_STATUSES: JobStatusOption[] = [
  option('awaiting', 'Awaiting approval', 'waiting'),
  option('approved', 'Approved', 'done'),
  option('changes', 'Changes needed', 'attention'),
];
export const SHIPMENT_STATUSES: JobStatusOption[] = [
  option('not_shipped', 'Not shipped', 'waiting'),
  option('shipped', 'Shipped', 'progress'),
  option('delivered', 'Delivered', 'done'),
];

/** One status of a job as the board shows it: a chip, empty until somebody sets it. */
export interface JobStatusChip {
  key: JobStatusKey;
  title: string;
  /** The chosen option's value, or '' while unset. */
  status: string;
  label: string;
  /** The option's full name, for the menu and the tooltip. */
  full: string;
  tone: StageTone;
}

export function jobStatusChips(statuses: Record<string, unknown> | undefined): JobStatusChip[] {
  return JOB_STATUS_COLUMNS.map((column) => {
    const chosen = column.options.find((o) => o.status === statuses?.[column.key]);
    return chosen
      ? { key: column.key, title: column.title, status: chosen.status, label: chosen.short ?? chosen.label, full: chosen.label, tone: chosen.tone }
      : { key: column.key, title: column.title, status: '', label: 'Not set', full: 'Not set', tone: 'none' as const };
  });
}

// The quick views above the board: which jobs each one keeps.
export const JOB_VIEWS: Record<string, (job: { statuses?: Record<string, unknown>; overdue: boolean; done: boolean }) => boolean> = {
  all: () => true,
  active: (job) => !job.done,
  overdue: (job) => job.overdue,
  awaiting_payment: (job) => !job.done && ['waiting_payment', 'waiting_remittance'].includes(String(job.statuses?.payment ?? '')),
  awaiting_artwork: (job) => !job.done && job.statuses?.artwork === 'awaiting_approval',
  to_order: (job) => !job.done && ['need_to_order', 'ready_to_order'].includes(String(job.statuses?.purchasing ?? '')),
  done: (job) => job.done,
};

// What a job can be said to be. A job is HaiVE's own record — a quotation the
// team decided to produce — and none of the connected systems says where it
// stands in production, so every status here is set by hand from a dropdown.
// Defined once: the board, the panel and the validation all read these lists.

import { StageTone } from './customer-profile.builder';

export type JobStatusKey = 'production' | 'payment' | 'purchasing' | 'orderType' | 'artwork' | 'orderStatus' | 'progress' | 'prodReady';

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

/** The eight columns of the Job board, left to right. Each starts empty and is set by the team.
 *
 * Reconciled against the Hoops-parity JobBoard spec's requested option
 * lists: every pre-existing option VALUE below is unchanged (so no job's
 * saved status is reinterpreted), and every newly-requested option is
 * added alongside it. Two columns were relabeled (title only, values
 * untouched) where the spec's own vocabulary was clearly the same concept
 * under a different name — 'Payment' -> 'Overall Status' (its 3 existing
 * values are 3 of the 15 requested ones, word for word) and 'Progress' ->
 * 'Active Clients' (its 2 existing values, in_progress/done, are 2 of the
 * 5 requested ones). 'Order Status' is a genuinely new 8th column — the
 * spec explicitly asks for it kept separate from Overall Status/
 * Purchasing/Prod Ready, and its own option list doesn't overlap closely
 * enough with the pre-existing 'Artwork' column to safely reuse that key's
 * values, so 'Artwork' is left completely untouched. */
export const JOB_STATUS_COLUMNS: JobStatusColumn[] = [
  {
    key: 'production',
    // Kept as the original single-word title — "Production method" (tried
    // first) overflowed the chip column's fixed ~112-126px width as one
    // unbroken word ("PRODUCTION" alone, uppercase, is wider than that) and
    // visually ran into the next header. Distinguished from the new
    // "Production house" column by position and content (a status chip vs
    // a vendor name), not by a longer label.
    title: 'Production',
    options: [option('in_house', 'In house', 'progress'), option('outsourced', 'Outsourced', 'progress'), option('not_started', 'Not started', 'muted')],
  },
  {
    key: 'payment',
    title: 'Overall Status',
    options: [
      option('received', 'Payment Received', 'done', 'Pay received'),
      option('waiting_stock', 'Waiting Stock', 'waiting', 'Wait stock'),
      option('waiting_payment', 'Waiting Payment', 'waiting', 'Awaiting pay'),
      option('in_production', 'In Production', 'progress', 'In prod'),
      option('complete', 'Complete', 'done'),
      option('ready_for_pickup', 'Ready for Pickup', 'done', 'Ready'),
      option('ready_for_pickup_followup_2', 'Ready for Pickup — Follow-up 2', 'attention', 'Pickup F/U2'),
      option('cc', 'C&C', 'progress'),
      option('review_request', 'Review Request', 'waiting', 'Review req'),
      option('partially_paid', 'Partially Paid', 'waiting', 'Part paid'),
      option('credit', 'Credit', 'muted'),
      option('tbc_remittance_received', 'TBC Remittance Received', 'progress', 'TBC remit'),
      option('square_payment', 'Square Payment', 'done', 'Square'),
      option('fifty_percent', '50 Percent', 'waiting', '50%'),
      option('waiting_remittance', 'Waiting for Remittance', 'attention', 'Remittance'),
    ],
  },
  {
    key: 'purchasing',
    title: 'Purchasing',
    options: [
      option('need_to_order', 'Need to Order', 'waiting', 'To order'),
      option('ready_to_order', 'Ready to order', 'progress', 'Ready'),
      option('created', 'Created', 'muted'),
      option('ordered', 'Ordered', 'progress'),
      option('partially_ordered', 'Partially Ordered', 'progress', 'Part ordered'),
      option('received', 'Received', 'done'),
      option('partially_received', 'Partially Received', 'waiting', 'Part recv'),
      option('some_backordered', 'Some Backordered', 'attention', 'Backordered'),
      option('on_hold', 'On Hold', 'attention'),
      // The customer supplies the goods: nothing to buy.
      option('byo', 'BYO', 'muted'),
      option('delivery_charges', 'Delivery Charges', 'muted', 'Del. charges'),
    ],
  },
  {
    key: 'orderType',
    title: 'Order type',
    options: [
      option('normal', 'Normal', 'muted'),
      option('priority', 'Priority', 'waiting'),
      option('rush', 'Rush', 'attention'),
      option('na', 'N/A', 'none'),
    ],
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
  // New — kept separate from Overall Status/Purchasing/Prod ready per the spec's
  // own instruction, since its option list is its own thing, not a rewording
  // of any pre-existing column.
  {
    key: 'orderStatus',
    title: 'Order Status',
    options: [
      option('awaiting_art_approval', 'Awaiting Art Approval', 'waiting', 'Await art'),
      option('artwork_approval', 'Artwork Approval', 'progress', 'Art approval'),
      option('in_progress', 'In Progress', 'progress'),
      option('order_completed', 'Order Completed', 'done', 'Completed'),
      option('partially_completed', 'Partially Completed', 'waiting', 'Part done'),
      option('artwork_mockup_required', 'Artwork / Mockup Required', 'attention', 'Mockup req'),
      option('personalize_requirement', 'Personalize Requirement', 'waiting', 'Personalize'),
    ],
  },
  {
    key: 'progress',
    title: 'Active Clients',
    options: [
      option('active', 'Active', 'progress'),
      option('in_progress', 'In progress', 'progress'),
      option('hold', 'Hold', 'attention'),
      option('not_active', 'Not Active', 'muted'),
      option('done', 'Done', 'done'),
    ],
  },
  {
    key: 'prodReady',
    title: 'Prod ready',
    options: [option('not_ready', 'Not Yet Ready', 'attention', 'Not ready'), option('ready', 'Production Ready', 'done', 'Ready')],
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

// JobBoard spec's Credits section (J) — a credit is "issued" until voided;
// voiding stamps a Deleted Date (customer-jobs.service.ts's ENTRIES.credits
// stamps config) rather than hard-deleting the record, so the audit trail
// the spec asks for ("distinguish... a credit that has been deleted or
// voided") stays intact. removeEntry remains available separately for a
// genuine data-entry mistake.
export const CREDIT_STATUSES: JobStatusOption[] = [
  option('issued', 'Issued', 'done'),
  option('voided', 'Voided', 'muted'),
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

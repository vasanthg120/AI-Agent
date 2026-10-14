import type { BadgeVariant } from '@/components/ui';
import type {
  CrmState,
  CustomerFlag,
  CustomerType,
  InvoiceStatus,
  MailState,
  OrderState,
  PaymentState,
  QuoteState,
} from '@/services/customersService';

// One colour language for the whole Customers view: red = act now, amber =
// soon, green = good, blue = new/open, grey = nothing to say.
export const TYPE_VARIANT: Record<CustomerType, BadgeVariant> = {
  new: 'info',
  existing: 'success',
  returning: 'accent',
};

export const QUOTE_VARIANT: Record<QuoteState, BadgeVariant> = {
  draft: 'neutral',
  sent: 'info',
  accepted: 'success',
  rejected: 'danger',
  expired: 'neutral',
};

export const INVOICE_VARIANT: Record<InvoiceStatus, BadgeVariant> = {
  draft: 'neutral',
  invoiced: 'info',
  paid: 'success',
};

export const PAYMENT_VARIANT: Record<PaymentState, BadgeVariant> = {
  paid: 'success',
  partially_paid: 'warning',
  unpaid: 'warning',
  overdue: 'danger',
  not_recorded: 'neutral',
  nothing_due: 'neutral',
};

export const ORDER_VARIANT: Record<OrderState, BadgeVariant> = {
  converted: 'success',
  previous_order: 'accent',
  not_converted: 'neutral',
  none: 'neutral',
};

export const MAIL_VARIANT: Record<MailState, BadgeVariant> = {
  reply_needed: 'danger',
  follow_up: 'warning',
  not_replied: 'neutral',
  replied: 'success',
  not_contacted: 'info',
  none: 'neutral',
};

export const CRM_VARIANT: Record<CrmState, BadgeVariant> = {
  lead: 'info',
  opportunity: 'accent',
  customer: 'success',
  lost: 'neutral',
};

export const FLAG_LABEL: Record<CustomerFlag, string> = {
  reply_needed: 'Reply needed',
  follow_up_required: 'Follow-up required',
  quote_pending: 'Quote pending',
  payment_pending: 'Payment pending',
  payment_overdue: 'Payment overdue',
};

export const FLAG_VARIANT: Record<CustomerFlag, BadgeVariant> = {
  reply_needed: 'danger',
  follow_up_required: 'warning',
  quote_pending: 'info',
  payment_pending: 'warning',
  payment_overdue: 'danger',
};

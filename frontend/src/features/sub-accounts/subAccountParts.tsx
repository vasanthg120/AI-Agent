import clsx from 'clsx';
import { Badge, type BadgeVariant } from '@/components/ui';
import { initialsFromName } from '@/utils/format';
import { formatCurrency } from '@/utils/currency';
import type { BillingSnapshot, SubAccountRow } from '@/services/subAccountsService';
import styles from './subAccountParts.module.css';

/** A business's logo, or its initials when it has none. */
export function AccountLogo({ name, logo, size = 'md' }: { name: string; logo?: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={clsx(styles.logo, styles[size])} aria-hidden>
      {logo ? <img src={logo} alt="" /> : initialsFromName(name)}
    </span>
  );
}

const SUBSCRIPTION_LABEL: Record<string, { label: string; variant: BadgeVariant }> = {
  active: { label: 'Paid', variant: 'success' },
  trialing: { label: 'Trial', variant: 'info' },
  past_due: { label: 'Payment failed', variant: 'warning' },
  expired: { label: 'Expired', variant: 'danger' },
  canceled: { label: 'Cancelled', variant: 'neutral' },
  none: { label: 'No subscription', variant: 'warning' },
};

export function SubscriptionBadge({ status }: { status: string }) {
  const known = SUBSCRIPTION_LABEL[status] ?? { label: status, variant: 'neutral' as BadgeVariant };
  return <Badge variant={known.variant}>{known.label}</Badge>;
}

const STATUS_LABEL: Record<SubAccountRow['status'], { label: string; variant: BadgeVariant }> = {
  active: { label: 'Active', variant: 'success' },
  suspended: { label: 'Suspended', variant: 'danger' },
  archived: { label: 'Archived', variant: 'neutral' },
};

export function AccountStatusBadge({ status }: { status: SubAccountRow['status'] }) {
  const { label, variant } = STATUS_LABEL[status];
  return <Badge variant={variant}>{label}</Badge>;
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

const CYCLE_LABEL: Record<string, string> = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };

/** "₹1,200 / year", or a dash when there's no price to show. */
export function formatPrice(billing: Pick<BillingSnapshot, 'amount' | 'currency' | 'cycle'>): string {
  if (billing.amount == null || !billing.currency) return '—';
  const per = billing.cycle ? CYCLE_LABEL[billing.cycle] : undefined;
  return `${formatCurrency(billing.amount, billing.currency)}${per ? ` / ${per}` : ''}`;
}

import { axiosClient } from '@/api/axiosClient';

// The Main Account owner's Dashboard: every business side by side
// (backend/src/analytics-dashboard/businesses-overview.service.ts).

export interface Amount {
  count: number;
  value: number;
}

export interface BusinessHealthItem {
  kind: 'mailbox' | 'crm';
  label: string;
  status: 'ok' | 'failing' | 'reconnect' | 'never' | 'stale';
  lastOkAt?: string;
  since?: string;
  reason?: string;
}

export type BusinessListKind =
  | 'won'
  | 'lost'
  | 'open'
  | 'pipeline'
  | 'past_due'
  | 'quotes'
  | 'quotes_accepted'
  | 'emails_waiting'
  | 'emails_overdue'
  | 'new_enquiries';

export interface AttentionItem {
  businessId: string;
  businessName: string;
  severity: 'critical' | 'warning' | 'info';
  text: string;
  list?: BusinessListKind | 'missed_calls';
}

export interface BusinessOverviewRow {
  id: string;
  name: string;
  isMain: boolean;
  isCurrent: boolean;
  currency: string;
  timeZone: string;
  locked: boolean;
  revenue: { achieved: number; target: number | null; pct: number | null; periodGonePct: number };
  deals: { won: Amount; lost: Amount; open: Amount; winRatePct: number | null };
  pipeline: { open: Amount; pastDue: Amount };
  quotes: { created: Amount; accepted: Amount };
  emails: { waiting: number; overdue: number; newEnquiries: number; received: number | null; replied: number | null; missed: number | null };
  calls: { total: number; connected: number; missed: number; talkSeconds: number; avgScore: number | null } | null;
  people: { total: number; active: number } | null;
  health: BusinessHealthItem[];
}

export interface CurrencyTotal {
  currency: string;
  businesses: number;
  revenue: number;
  target: number | null;
  won: Amount;
  pipeline: Amount;
  pastDue: Amount;
}

export interface BusinessesOverview {
  dateFrom: string;
  dateTo: string;
  months: { first: string; last: string };
  businesses: BusinessOverviewRow[];
  totals: {
    byCurrency: CurrencyTotal[];
    deals: { won: number; lost: number };
    emails: { waiting: number; overdue: number; newEnquiries: number; replied: number; missed: number };
    calls: { total: number; missed: number; talkSeconds: number };
  };
  attention: AttentionItem[];
  generatedAt: string;
}

export interface BusinessListRow {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  note?: string;
  value?: number;
  currency: string;
  dealId?: string;
  at?: string;
  businessId: string;
  businessName: string;
}

export const businessesOverviewService = {
  async overview(dateFrom: string, dateTo: string): Promise<BusinessesOverview> {
    const { data } = await axiosClient.get<BusinessesOverview>('/analytics-dashboard/businesses', { params: { dateFrom, dateTo } });
    return data;
  },

  /** The records behind one number — one business, or every one ('all'). */
  async list(kind: BusinessListKind, dateFrom: string, dateTo: string, organizationId = 'all'): Promise<{ items: BusinessListRow[]; total: number }> {
    const { data } = await axiosClient.get<{ items: BusinessListRow[]; total: number }>('/analytics-dashboard/businesses/list', {
      params: { kind, dateFrom, dateTo, organizationId },
    });
    return data;
  },
};

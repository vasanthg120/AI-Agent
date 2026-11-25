import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FiAlertTriangle, FiCornerUpLeft, FiMail, FiSend, FiUserPlus } from 'react-icons/fi';
import type { IconType } from 'react-icons';
import { AnimatedNumber, Card, Skeleton } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import { customerActivityService } from '@/services/customerActivityService';
import { emailAnalyticsService, type BiFilters } from '@/services/emailAnalyticsService';
import { EmailDetailModal } from '@/features/business-intelligence/components/EmailDetailModal';
import { LiveIndicator } from '@/components/live/LiveIndicator';
import { useLiveData } from '@/hooks/useLiveData';
import { CustomerMixCard } from './CustomerMixCard';
import { InboxIntentCard } from './InboxIntentCard';
import { PendingConversationsCard } from './PendingConversationsCard';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import styles from '../analytics-dashboard.module.css';
import statStyles from './CustomersAndEmailStats.module.css';

// Switching tabs and back within this window reuses the cached result
// instead of refiring the same request — these numbers don't move
// second-to-second, so there's no accuracy cost, only fewer redundant calls.
const STALE_TIME = 30_000;

type CustomerCategory = 'new' | 'existing' | 'lost';

const CATEGORY_TITLES: Record<CustomerCategory, string> = {
  new: 'New Customers',
  existing: 'Existing Customers',
  lost: 'Lost Customers',
};

function StatCard({
  icon: Icon,
  label,
  value,
  note,
  onClick,
}: {
  icon: IconType;
  label: string;
  value: number;
  note: string;
  onClick?: () => void;
}) {
  return (
    <Card className={statStyles.cell} interactive={!!onClick} onClick={onClick}>
      <span className={statStyles.iconBadge}>
        <Icon size={16} />
      </span>
      <div className={statStyles.label}>{label}</div>
      <div className={statStyles.value}>
        <AnimatedNumber value={value} />
      </div>
      <div className={statStyles.note}>{note}</div>
    </Card>
  );
}

// Consolidated: this tab used to duplicate the same sent/missed/by-intent
// numbers in two places (a lighter version here, a fuller version on a
// separate "Email Analytics" tab) — collapsed into one real data source
// (emailAnalyticsService) so the stat tiles above can never disagree with
// that other tab. Customer Mix is unique to this tab (no BI equivalent) and
// stays as-is.
export function CustomersAndEmailSection({ dateFrom, dateTo, storeId }: { dateFrom: string; dateTo: string; storeId?: string }) {
  const filters: BiFilters = { dateFrom, dateTo, employeeId: [], storeId: storeId ? [storeId] : [] };
  const user = useAuthStore((s) => s.user);
  // Mirrors customer-activity.controller.ts's breakdown-stats branching:
  // owner/admin/manager get the org/store-scoped relationship endpoint,
  // everyone else (consultant) is forced onto the self-scoped one.
  const isPersonalScope = !hasRole(user, 'owner') && !hasRole(user, 'admin') && !hasRole(user, 'manager');

  // Drives the New/Existing/Lost popups — set by clicking a CustomerMixCard
  // segment. Only one can be open at a time, so a single piece of state is
  // enough.
  const [activeCategory, setActiveCategory] = useState<CustomerCategory | null>(null);
  // Drives every email-list popup on this tab — Sent/Replied/Missed/New
  // enquiries stat tiles and each By-intent row all funnel through the same
  // {kind, intent} shape emailAnalyticsService.listEmails already accepts,
  // so this is one shared query/modal instead of five near-identical ones.
  const [emailListQuery, setEmailListQuery] = useState<{ kind: 'sent' | 'replied' | 'missed' | 'all'; intent?: string; title: string } | null>(
    null,
  );
  // Second level for a New/Existing/Lost row — that business's own
  // correlated emails, fetched on demand rather than bundled into the
  // breakdown response (which would fetch relationship data for every
  // business up front, most of which nobody ever opens).
  const [selectedBusiness, setSelectedBusiness] = useState<{ key: string; businessName: string } | null>(null);
  // Third level for an email-list row — the real EmailDetailModal, reused
  // as-is from Business Intelligence so the two surfaces can never render
  // an email's detail differently.
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);

  const { data: customers, isLoading: customersLoading } = useQuery({
    queryKey: ['analytics-dashboard-customer-breakdown', dateFrom, dateTo],
    queryFn: () => customerActivityService.getBreakdownStats(dateFrom, dateTo),
    refetchInterval: 60_000,
    staleTime: STALE_TIME,
  });

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['dash-email-summary', filters],
    queryFn: () => emailAnalyticsService.getSummary(filters),
    placeholderData: keepPreviousData,
    staleTime: STALE_TIME,
  });

  // Live: opening this tab asks the caller's own mailbox for new mail and replies
  // (no AI); the Dashboard itself asks the CRMs. Every number here reloads the moment either lands.
  const live = useLiveData({
    crm: false,
    email: true,
    invalidate: [['dash-email-summary'], ['dash-email-list'], ['analytics-dashboard-customer-breakdown'], ['dash-business-timeline']],
  });

  const { data: emailListResult, isLoading: emailListLoading } = useQuery({
    queryKey: ['dash-email-list', filters, emailListQuery?.kind, emailListQuery?.intent],
    queryFn: () => emailAnalyticsService.listEmails(emailListQuery!.kind, filters, 1, 100, emailListQuery!.intent),
    enabled: !!emailListQuery,
  });

  // getCustomerTimeline (not getRelationshipView) — the latter's
  // correlatedEmails is deliberately today-only (see its own doc comment),
  // which meant this popup showed "No records" for any business with no
  // email activity literally today, even one with months of real history.
  // getCustomerTimeline is a strict superset: same deals/quotes, plus
  // emailHistory — real EmailIntelligenceItem records matched via the
  // stored resolvedGroupKey field, not scoped to today.
  const { data: businessDetail, isLoading: businessDetailLoading } = useQuery({
    queryKey: ['dash-business-timeline', selectedBusiness?.key, isPersonalScope],
    queryFn: () =>
      isPersonalScope
        ? customerActivityService.getPersonalCustomerTimeline(selectedBusiness!.key)
        : customerActivityService.getCustomerTimeline(selectedBusiness!.key),
    enabled: !!selectedBusiness,
  });

  const categoryItems: Record<CustomerCategory, { key: string; businessName: string }[]> = {
    new: customers?.newItems ?? [],
    existing: customers?.existingItems ?? [],
    lost: customers?.lostItems ?? [],
  };

  const categoryRows: DrillDownRow[] = activeCategory ? categoryItems[activeCategory].map((item) => ({ id: item.key, title: item.businessName })) : [];

  const emailListRows: DrillDownRow[] = (emailListResult?.items ?? []).map((item) => ({
    id: item._id,
    title: item.subject || '(no subject)',
    subtitle: item.matchedBusinessName ?? item.fromAddress,
    meta: new Date(item.receivedAt).toLocaleString(),
  }));

  const emailHistoryRows: DrillDownRow[] = (businessDetail?.emailHistory ?? []).map((email) => ({
    id: email._id,
    title: email.subject || '(no subject)',
    subtitle: email.matchedBusinessName ?? email.fromAddress,
    meta: new Date(email.receivedAt).toLocaleString(),
  }));

  return (
    <div className={styles.tabContent}>
      <div className={statStyles.syncRow}>
        <LiveIndicator live={live} mailboxOnly />
      </div>

      {summaryLoading || !summary || customersLoading || !customers ? (
        <Skeleton height={100} />
      ) : (
        <div className={statStyles.grid}>
          <StatCard
            icon={FiUserPlus}
            label="New customers"
            value={customers.newCount}
            note="in this period"
            onClick={() => setActiveCategory('new')}
          />
          <StatCard
            icon={FiSend}
            label="Sent (AI draft)"
            value={summary.sentCount}
            note={`of ${summary.sentCount + summary.repliedCount + summary.missedCount} relevant`}
            onClick={() => setEmailListQuery({ kind: 'sent', title: 'Sent (AI draft)' })}
          />
          <StatCard
            icon={FiCornerUpLeft}
            label="Replied in Outlook"
            value={summary.repliedCount}
            note="answered directly, not via AI draft"
            onClick={() => setEmailListQuery({ kind: 'replied', title: 'Replied in Outlook' })}
          />
          <StatCard
            icon={FiAlertTriangle}
            label="Missed emails"
            value={summary.missedCount}
            note="24h+ with no reply"
            onClick={() => setEmailListQuery({ kind: 'missed', title: 'Missed Emails' })}
          />
          <StatCard
            icon={FiMail}
            label="New enquiries"
            value={summary.newEnquiryCount}
            note="awaiting triage"
            onClick={() => setEmailListQuery({ kind: 'all', intent: 'new_enquiry', title: 'New Enquiries' })}
          />
        </div>
      )}

      <div className={styles.twoColumn}>
        {customersLoading || !customers ? (
          <Skeleton height={280} />
        ) : (
          <CustomerMixCard
            newCount={customers.newCount}
            existingCount={customers.existingCount}
            lostCount={customers.lostCount}
            totalConsidered={customers.totalConsidered}
            onSegmentClick={setActiveCategory}
          />
        )}
        {summaryLoading || !summary ? (
          <Skeleton height={280} />
        ) : (
          <InboxIntentCard
            byIntent={summary.byIntent}
            onIntentClick={(intent, label) => setEmailListQuery({ kind: 'all', intent, title: label })}
          />
        )}
      </div>

      <PendingConversationsCard dateFrom={dateFrom} dateTo={dateTo} storeId={storeId} />

      <DrillDownModal
        open={!!emailListQuery}
        onClose={() => setEmailListQuery(null)}
        title={emailListQuery?.title ?? ''}
        isLoading={emailListLoading}
        rows={emailListRows}
        onRowClick={(row) => setSelectedEmailId(row.id)}
      />

      <DrillDownModal
        open={!!activeCategory}
        onClose={() => setActiveCategory(null)}
        title={activeCategory ? CATEGORY_TITLES[activeCategory] : ''}
        isLoading={false}
        rows={categoryRows}
        onRowClick={(row) => setSelectedBusiness({ key: row.id, businessName: row.title })}
      />

      <DrillDownModal
        open={!!selectedBusiness}
        onClose={() => setSelectedBusiness(null)}
        title={selectedBusiness ? `Emails — ${selectedBusiness.businessName}` : ''}
        isLoading={businessDetailLoading}
        rows={emailHistoryRows}
        onRowClick={(row) => setSelectedEmailId(row.id)}
      />

      <EmailDetailModal id={selectedEmailId} onClose={() => setSelectedEmailId(null)} />

    </div>
  );
}

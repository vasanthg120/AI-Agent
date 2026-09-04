import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { FiClock, FiTarget, FiInbox, FiChevronRight, FiArrowUpRight } from 'react-icons/fi';
import type { IconType } from 'react-icons';
import { Card } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { dealsService } from '@/services/dealsService';
import { aiFollowupSummaryService } from '@/services/aiFollowupSummaryService';
import styles from './ActionQueueCard.module.css';

interface QueueItem {
  id: string;
  icon: IconType;
  title: string;
  subtitle: string;
  onSelect: () => void;
}

export interface ActionQueueCardProps {
  dateFrom: string;
  dateTo: string;
  storeId?: string;
  // Already fetched by the Overview tab (AnalyticsDashboardOverview.emailActivity) —
  // no need for this card to fetch it again.
  newEnquiryCount: number;
  onOpenFollowUps: () => void;
  onOpenPipeline: () => void;
  onOpenCustomers: () => void;
}

// Every item here traces to a real record, never invented: the overdue
// follow-up is the org's actual most-overdue FollowUpReminder (real
// businessName + dueDate, days-late computed client-side), the opportunity
// is the real highest-value open deal in range, and the enquiry count is the
// same emailActivity.newEnquiryCount already shown elsewhere on this page.
// An item is only ever included when its underlying data is real and
// present — nothing is padded to hit a fixed count.
export function ActionQueueCard({ dateFrom, dateTo, storeId, newEnquiryCount, onOpenFollowUps, onOpenPipeline, onOpenCustomers }: ActionQueueCardProps) {
  const { data: followups } = useQuery({
    queryKey: ['ai-followup-overview'],
    queryFn: () => aiFollowupSummaryService.getOverview(),
  });

  const { data: topDeal } = useQuery({
    queryKey: ['analytics-top-open-deal', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered(
        { dealStatus: ['open'], dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) },
        1,
        1,
        'monetaryValue',
        'desc',
      ),
  });

  const items = useMemo<QueueItem[]>(() => {
    const list: QueueItem[] = [];
    const today = dayjs();

    const mostOverdue = (followups?.followUpReminders ?? [])
      .filter((f) => f.status === 'pending' && dayjs(f.dueDate).isBefore(today, 'day'))
      .sort((a, b) => dayjs(a.dueDate).valueOf() - dayjs(b.dueDate).valueOf())[0];
    if (mostOverdue) {
      const daysLate = today.diff(dayjs(mostOverdue.dueDate), 'day');
      list.push({
        id: 'followup',
        icon: FiClock,
        title: 'Overdue follow-up',
        subtitle: `${mostOverdue.businessName ?? mostOverdue.title} · ${daysLate} day${daysLate === 1 ? '' : 's'} late`,
        onSelect: onOpenFollowUps,
      });
    }

    const deal = topDeal?.items[0];
    if (deal && deal.monetaryValue > 0) {
      list.push({
        id: 'opportunity',
        icon: FiTarget,
        title: 'High-value opportunity',
        subtitle: `${deal.name} · ${money(deal.monetaryValue)}`,
        onSelect: onOpenPipeline,
      });
    }

    if (newEnquiryCount > 0) {
      list.push({
        id: 'enquiry',
        icon: FiInbox,
        title: 'New enquiry to qualify',
        subtitle: `${newEnquiryCount} ${newEnquiryCount === 1 ? 'enquiry' : 'enquiries'} waiting in inbox`,
        onSelect: onOpenCustomers,
      });
    }

    return list;
  }, [followups, topDeal, newEnquiryCount, onOpenFollowUps, onOpenPipeline, onOpenCustomers]);

  return (
    <Card className={styles.card}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.label}>Action Queue</div>
          <div className={styles.title}>Needs attention</div>
        </div>
        {items.length > 0 && <span className={styles.countBadge}>{items.length}</span>}
      </div>

      {items.length === 0 ? (
        <div className={styles.empty}>Nothing needs attention right now.</div>
      ) : (
        <div className={styles.list}>
          {items.map((item) => (
            <button key={item.id} type="button" className={styles.item} onClick={item.onSelect}>
              <span className={styles.iconBadge}>
                <item.icon size={16} />
              </span>
              <span className={styles.itemBody}>
                <span className={styles.itemTitle}>{item.title}</span>
                <span className={styles.itemSubtitle}>{item.subtitle}</span>
              </span>
              <FiChevronRight size={14} className={styles.chevron} />
            </button>
          ))}
        </div>
      )}

      <button type="button" className={styles.openQueueBtn} onClick={onOpenFollowUps}>
        Open action queue
        <FiArrowUpRight size={14} />
      </button>
    </Card>
  );
}

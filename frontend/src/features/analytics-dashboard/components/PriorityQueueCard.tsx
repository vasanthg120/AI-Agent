import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { Card } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { dealsService } from '@/services/dealsService';
import { quotesService } from '@/services/quotesService';
import type { FollowUpReminder } from '@/services/aiFollowupSummaryService';
import { ROUTES } from '@/constants/routes';
import styles from './PriorityQueueCard.module.css';

interface QueueItem {
  id: string;
  step: string;
  title: string;
  subtitle: string;
  status: string;
  statusTone: 'overdue' | 'due-soon' | 'positive';
  actionLabel: string;
  onAction: () => void;
}

export interface PriorityQueueCardProps {
  followUpReminders: FollowUpReminder[];
}

// Every item traces to a real record — no LLM prose is parsed for
// structured fields (quote #, amount, close date), since that would risk
// misrepresenting what the AI actually said. Instead each of the 3 slots is
// independently derived from its own real source: the org's most-overdue
// pending follow-up reminder, the open deal (with a linked quote) closing
// soonest, and the most recently fully-paid quote. A slot is only shown
// when its underlying condition is genuinely true.
export function PriorityQueueCard({ followUpReminders }: PriorityQueueCardProps) {
  const navigate = useNavigate();

  const { data: openDeals } = useQuery({
    queryKey: ['dash-followups-open-deals'],
    queryFn: () => dealsService.listFiltered({ dealStatus: ['open'] }, 1, 50, 'expectedClosingDate', 'asc'),
  });
  const { data: quotesResult } = useQuery({
    queryKey: ['dash-followups-quotes'],
    queryFn: () => quotesService.listFiltered({}, 1, 100),
  });

  const items = useMemo<QueueItem[]>(() => {
    const list: QueueItem[] = [];
    const today = dayjs();

    const mostOverdue = followUpReminders
      .filter((f) => f.status === 'pending' && dayjs(f.dueDate).isBefore(today, 'day'))
      .sort((a, b) => dayjs(a.dueDate).valueOf() - dayjs(b.dueDate).valueOf())[0];
    if (mostOverdue) {
      const daysOverdue = today.diff(dayjs(mostOverdue.dueDate), 'day');
      list.push({
        id: `followup-${mostOverdue._id}`,
        step: '01',
        title: `Re-engage ${mostOverdue.businessName ?? mostOverdue.title}`,
        subtitle: `${mostOverdue.title} · ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue`,
        status: 'Overdue',
        statusTone: 'overdue',
        actionLabel: 'Draft reply',
        onAction: () => navigate(ROUTES.emailIntelligence),
      });
    }

    const quotes = quotesResult?.items ?? [];
    const quoteByDealId = new Map(quotes.filter((q) => q.dealId).map((q) => [q.dealId!, q]));
    const dealsWithQuotesSoon = (openDeals?.items ?? []).filter((d) => d.expectedClosingDate && quoteByDealId.has(d._id));
    const closingSoon = dealsWithQuotesSoon[0];
    if (closingSoon) {
      const quote = quoteByDealId.get(closingSoon._id)!;
      list.push({
        id: `deal-${closingSoon._id}`,
        step: '02',
        title: `Confirm decision date with ${quote.clientDetails?.companyName ?? closingSoon.name}`,
        subtitle: `Quote #${quote.quoteNumber ?? quote._id.slice(-4)} · ${money(quote.quoteAmount)} · closes ${dayjs(closingSoon.expectedClosingDate).format('MMM DD')}`,
        status: 'Due soon',
        statusTone: 'due-soon',
        actionLabel: 'View deal',
        onAction: () => navigate(ROUTES.dashboard),
      });
    }

    const fullyPaid = quotes
      .filter((q) => q.paidAmount > 0 && q.paidAmount >= q.quoteAmount)
      .sort((a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf())[0];
    if (fullyPaid) {
      list.push({
        id: `paid-${fullyPaid._id}`,
        step: '03',
        title: `Send a thank-you to ${fullyPaid.clientDetails?.companyName ?? fullyPaid.quoteName ?? 'this customer'}`,
        subtitle: `Payment received · ${money(fullyPaid.paidAmount)}`,
        status: 'Positive',
        statusTone: 'positive',
        actionLabel: 'Open customer',
        onAction: () => navigate(ROUTES.dashboard),
      });
    }

    return list;
  }, [followUpReminders, openDeals, quotesResult, navigate]);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.label}>Suggested Actions</div>
          <div className={styles.title}>Priority queue</div>
        </div>
        <span className={styles.count}>{items.length} action{items.length === 1 ? '' : 's'}</span>
      </div>

      {items.length === 0 ? (
        <div className={styles.empty}>Nothing urgent right now.</div>
      ) : (
        <div className={styles.list}>
          {items.map((item) => (
            <div key={item.id} className={styles.row}>
              <span className={styles.step}>{item.step}</span>
              <div className={styles.body}>
                <div className={styles.itemTitle}>{item.title}</div>
                <div className={styles.itemSubtitle}>{item.subtitle}</div>
              </div>
              <span className={`${styles.statusPill} ${styles[`status-${item.statusTone}`]}`}>{item.status}</span>
              <button type="button" className={styles.actionBtn} onClick={item.onAction}>
                {item.actionLabel}
                <span aria-hidden>↗</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

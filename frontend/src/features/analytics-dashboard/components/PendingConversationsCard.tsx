import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FiInbox, FiArrowUpRight, FiChevronRight } from 'react-icons/fi';
import { Card } from '@/components/ui';
import { emailAnalyticsService, type BiFilters } from '@/services/emailAnalyticsService';
import { ROUTES } from '@/constants/routes';
import styles from './PendingConversationsCard.module.css';

export interface PendingConversationsCardProps {
  dateFrom: string;
  dateTo: string;
  storeId?: string;
}

// Real new-enquiry emails still in status:'pending' (not yet approved/sent/
// rejected) — the same status field the real AI Email Inbox page itself
// uses for its own Pending/Approved/Rejected tabs, so "awaiting triage" here
// means exactly what it means there.
export function PendingConversationsCard({ dateFrom, dateTo, storeId }: PendingConversationsCardProps) {
  const navigate = useNavigate();
  const filters: BiFilters = { dateFrom, dateTo, employeeId: [], storeId: storeId ? [storeId] : [] };

  const { data } = useQuery({
    queryKey: ['dash-pending-enquiries', dateFrom, dateTo, storeId],
    queryFn: () => emailAnalyticsService.listEmails('all', filters, 1, 5, 'new_enquiry'),
  });

  const pending = (data?.items ?? []).filter((item) => item.status === 'pending');

  return (
    <Card className={styles.card}>
      {pending.length === 0 ? (
        <div className={styles.row}>
          <span className={styles.iconBadge}>
            <FiInbox size={18} />
          </span>
          <div className={styles.body}>
            <div className={styles.title}>No pending conversations</div>
            <p className={styles.subtitle}>Your email inbox is clear. New customer enquiries will appear here for triage.</p>
          </div>
          <button type="button" className={styles.openBtn} onClick={() => navigate(ROUTES.emailIntelligence)}>
            Open inbox
            <FiArrowUpRight size={14} />
          </button>
        </div>
      ) : (
        <>
          <div className={styles.headerRow}>
            <div className={styles.headerText}>
              <div className={styles.title}>
                {pending.length} pending conversation{pending.length === 1 ? '' : 's'}
              </div>
              <p className={styles.subtitle}>New customer enquiries awaiting triage.</p>
            </div>
            <button type="button" className={styles.openBtn} onClick={() => navigate(ROUTES.emailIntelligence)}>
              Open inbox
              <FiArrowUpRight size={14} />
            </button>
          </div>
          <div className={styles.list}>
            {/* Each row opens that exact email in the inbox (same EmailIntelligenceItem
                id the inbox's ?openEmailId= deep link expects), not just the inbox. */}
            {pending.map((item, i) => (
              <motion.button
                key={item._id}
                type="button"
                className={styles.item}
                onClick={() => navigate(`${ROUTES.emailIntelligence}?openEmailId=${item._id}`)}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: i * 0.05 }}
              >
                <span className={styles.iconBadge}>
                  <FiInbox size={16} />
                </span>
                <span className={styles.itemBody}>
                  <span className={styles.itemTitle}>{item.subject || '(no subject)'}</span>
                  <span className={styles.itemMeta}>{item.matchedBusinessName ?? item.fromAddress}</span>
                </span>
                <FiChevronRight className={styles.itemChevron} aria-hidden />
              </motion.button>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

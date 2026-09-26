import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { FiUsers } from 'react-icons/fi';
import { Card, Skeleton, Avatar, Badge, EmptyState } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { employeeProductivityService } from '@/services/employeeProductivityService';
import styles from './ProductivitySection.module.css';

function completionPct(completed: number, assigned: number): number {
  return assigned > 0 ? Math.round((completed / assigned) * 100) : 0;
}

// Colour band for a member's overall completion — green on pace, amber
// slipping, red well behind — so the list scans without reading numbers.
function completionTone(pct: number | null): string | undefined {
  if (pct === null) return undefined;
  if (pct >= 75) return styles.overallGood;
  if (pct >= 40) return styles.overallOk;
  return styles.overallLow;
}

// Business Intelligence section 3 — Employee Work Completion & Productivity.
// Same real endpoint/data as before (employeeProductivityService.getOverview,
// unchanged), just restyled from a flat table into per-member cards.
export function ProductivitySection({ dateFrom, dateTo, storeId }: { dateFrom: string; dateTo: string; storeId?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['dash-productivity', dateFrom, dateTo, storeId],
    queryFn: () => employeeProductivityService.getOverview({ dateFrom, dateTo, employeeId: [], storeId: storeId ? [storeId] : [] }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Workload by member</div>
        <p className={styles.subtitle}>Emails, quotes and deals — assigned, completed, pending, overdue.</p>
      </div>

      {data && data.quoteCoveragePct !== null && data.quoteCoveragePct < 100 && (
        <div className={styles.coverageNote}>
          Quote ownership coverage: {data.quoteCoveragePct}% of quotes in this range have a real assigned employee.
        </div>
      )}

      {isLoading || !data ? (
        <Skeleton height={140} />
      ) : data.rows.length === 0 ? (
        <EmptyState compact icon={FiUsers} title="No eligible employees in scope for this period" />
      ) : (
        <div className={styles.list}>
          {data.rows.map((r, i) => (
            <motion.div
              key={r.userId}
              className={styles.row}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1], delay: Math.min(i, 10) * 0.05 }}
            >
              <div className={styles.rowTop}>
                <div className={styles.memberInfo}>
                  <Avatar name={r.userName} size="md" />
                  <div>
                    <div className={styles.memberName}>{r.userName}</div>
                    <div className={styles.memberMeta}>
                      {r.deals.completed}/{r.deals.assigned} deals done
                      {r.deals.overdue > 0 && ` · ${r.deals.overdue} overdue`}
                      {r.deals.pending > 0 && ` · ${r.deals.pending} pending`}
                    </div>
                  </div>
                </div>
                <div className={styles.rowStats}>
                  <span className={styles.wonValue}>{money(r.deals.wonValue)}</span>
                  {r.deals.overdue > 0 && <Badge variant="danger">{r.deals.overdue} overdue</Badge>}
                </div>
              </div>

              <div className={styles.bucketGrid}>
                {(
                  [
                    ['Deals', r.deals],
                    ['Emails', r.emails],
                    ['Quotes', r.quotes],
                  ] as const
                ).map(([label, bucket]) => (
                  <div key={label} className={styles.bucket}>
                    <div className={styles.bucketHeader}>
                      <span className={styles.bucketLabel}>{label}</span>
                      <span className={styles.bucketValue}>
                        {bucket.completed}/{bucket.assigned} done
                      </span>
                    </div>
                    <div className={styles.bucketTrack}>
                      <div className={styles.bucketFill} style={{ width: `${completionPct(bucket.completed, bucket.assigned)}%` }} />
                    </div>
                  </div>
                ))}
              </div>

              <div
                className={clsx(
                  styles.overall,
                  r.overallCompletionPct === null && styles.overallMuted,
                  completionTone(r.overallCompletionPct),
                )}
              >
                Overall completion <strong>{r.overallCompletionPct !== null ? `${r.overallCompletionPct}%` : '—'}</strong>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </Card>
  );
}

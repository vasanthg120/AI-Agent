import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Card, Skeleton, Avatar, Badge } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { employeeProductivityService } from '@/services/employeeProductivityService';
import styles from './ProductivitySection.module.css';

function completionPct(completed: number, assigned: number): number {
  return assigned > 0 ? Math.round((completed / assigned) * 100) : 0;
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
        <div className={styles.empty}>No eligible employees in scope for this period.</div>
      ) : (
        <div className={styles.list}>
          {data.rows.map((r) => (
            <div key={r.userId} className={styles.row}>
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

              <div className={clsx(styles.overall, r.overallCompletionPct === null && styles.overallMuted)}>
                Overall completion {r.overallCompletionPct !== null ? `${r.overallCompletionPct}%` : '—'}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

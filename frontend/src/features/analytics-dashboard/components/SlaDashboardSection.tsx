import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiAlertOctagon, FiAlertTriangle, FiCheckCircle, FiClock, FiInbox, FiShield, FiTrendingUp } from 'react-icons/fi';
import { Avatar, Badge, SectionCard, Skeleton, StatTile } from '@/components/ui';
import { emailSlaService } from '@/services/emailSlaService';
import styles from './SlaDashboardSection.module.css';

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

// The SLA dashboard endpoint returns only assignedUserId per employee row, so
// names come from the caller's own id→name map (the overview's leaderboard/
// workload rows) — never render a raw database id to the user.
export function SlaDashboardSection({ userNames }: { userNames?: Map<string, string> }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['email-sla-dashboard'],
    queryFn: () => emailSlaService.getDashboard(),
    retry: false,
  });

  if (error) return null;
  if (isLoading || !data) return <Skeleton height={140} />;
  if (data.totalEligible === 0) return null;

  const nameFor = (id: string | null | undefined) => (id ? (userNames?.get(id) ?? 'Unknown user') : 'Unassigned');
  const complianceTone =
    data.compliancePct === null ? undefined : data.compliancePct >= 90 ? styles.good : data.compliancePct >= 70 ? styles.ok : styles.bad;
  const maxEmployee = Math.max(1, ...data.byEmployee.map((e) => e.total));

  return (
    <SectionCard title="Email SLA Compliance" icon={FiShield}>
      <div className={clsx(styles.compliance, complianceTone)}>
        <span className={styles.complianceValue}>{data.compliancePct !== null ? `${data.compliancePct}%` : '—'}</span>
        <span className={styles.complianceText}>
          of {data.totalEligible} eligible emails were answered within their SLA
          {data.breached > 0 && ` · ${data.breached} breached`}
        </span>
      </div>

      <div className={styles.grid}>
        <StatTile icon={FiInbox} value={data.totalEligible} label="Eligible emails" />
        <StatTile icon={FiAlertOctagon} value={data.breached} label="Breached" />
        <StatTile icon={FiAlertTriangle} value={data.openOverdue} label="Open overdue" />
        <StatTile icon={FiTrendingUp} value={data.escalated} label="Escalated" />
        <StatTile icon={FiClock} value={formatSeconds(data.avgResponseSeconds)} label="Avg response" />
        <StatTile icon={FiCheckCircle} value={formatSeconds(data.medianResponseSeconds)} label="Median response" />
      </div>

      <div className={styles.breakdownGrid}>
        <div>
          <div className={styles.breakdownTitle}>By priority</div>
          {data.byPriority.length === 0 ? (
            <div className={styles.none}>No data yet.</div>
          ) : (
            data.byPriority.map((p, i) => {
              const breachedPct = p.total > 0 ? (p.breached / p.total) * 100 : 0;
              return (
                <motion.div
                  key={p.priority}
                  className={styles.row}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: i * 0.05 }}
                >
                  <div className={styles.rowTop}>
                    <span className={styles.rowLabel}>{p.priority}</span>
                    <span className={styles.rowMeta}>
                      <span>{p.total} total</span>
                      {p.breached > 0 && <Badge variant="danger">{p.breached} breached</Badge>}
                      <span>{formatSeconds(p.avgResponseSeconds)} avg</span>
                    </span>
                  </div>
                  {/* Green = answered in time, red = breached share. */}
                  <div className={styles.split} aria-hidden>
                    <span className={styles.splitOk} style={{ width: `${100 - breachedPct}%` }} />
                    <span className={styles.splitBad} style={{ width: `${breachedPct}%` }} />
                  </div>
                </motion.div>
              );
            })
          )}
        </div>

        <div>
          <div className={styles.breakdownTitle}>By employee</div>
          {data.byEmployee.length === 0 ? (
            <div className={styles.none}>No data yet.</div>
          ) : (
            data.byEmployee.map((e, i) => (
              <motion.div
                key={e.assignedUserId ?? `unassigned-${i}`}
                className={styles.row}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: i * 0.05 }}
              >
                <div className={styles.rowTop}>
                  <span className={styles.person}>
                    <Avatar name={nameFor(e.assignedUserId)} size="sm" />
                    <span className={styles.rowLabel}>{nameFor(e.assignedUserId)}</span>
                  </span>
                  <span className={styles.rowMeta}>
                    <span>{e.total} total</span>
                    {e.breached > 0 && <Badge variant="danger">{e.breached} breached</Badge>}
                  </span>
                </div>
                <div className={styles.volume} aria-hidden>
                  <span className={styles.volumeFill} style={{ width: `${(e.total / maxEmployee) * 100}%` }} />
                </div>
              </motion.div>
            ))
          )}
        </div>
      </div>
    </SectionCard>
  );
}

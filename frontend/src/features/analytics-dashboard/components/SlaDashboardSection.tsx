import { useQuery } from '@tanstack/react-query';
import { Badge, SectionCard, Skeleton, StatTile } from '@/components/ui';
import { emailSlaService } from '@/services/emailSlaService';
import styles from './SlaDashboardSection.module.css';

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

// New, separate SLA tracking surface (email-sla module) — deliberately not
// merged into EmailResponseSlaTable above, which stays exactly as-is
// (renamed "Unanswered Email Aging"). This reads slaDueAt/isBreached
// tracked per-email, a genuinely different metric from that table's
// missed/aging-bucket breakdown.
export function SlaDashboardSection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['email-sla-dashboard'],
    queryFn: () => emailSlaService.getDashboard(),
    retry: false,
  });

  // The feature is flag-gated server-side (EMAIL_SLA_ENABLED) — when off,
  // every number is legitimately zero, which isn't worth its own card. A
  // real error (network/permissions) is silently skipped too, since this
  // section is additive and must never break the rest of the dashboard.
  if (error) return null;
  if (isLoading || !data) return <Skeleton height={140} />;
  if (data.totalEligible === 0) return null;

  return (
    <SectionCard title="Email SLA Compliance">
      <div className={styles.grid}>
        <StatTile value={data.totalEligible} label="Eligible emails" />
        <StatTile value={data.compliancePct !== null ? `${data.compliancePct}%` : '—'} label="Compliance" />
        <StatTile value={data.breached} label="Breached" />
        <StatTile value={data.openOverdue} label="Open overdue" />
        <StatTile value={data.escalated} label="Escalated" />
        <StatTile value={formatSeconds(data.avgResponseSeconds)} label="Avg response" />
        <StatTile value={formatSeconds(data.medianResponseSeconds)} label="Median response" />
      </div>

      <div className={styles.breakdownGrid}>
        <div>
          <div className={styles.breakdownTitle}>By priority</div>
          {data.byPriority.length === 0 ? (
            <div className={styles.row}>No data yet.</div>
          ) : (
            data.byPriority.map((p) => (
              <div key={p.priority} className={styles.row}>
                <span className={styles.rowLabel}>{p.priority}</span>
                <span className={styles.rowMeta}>
                  <span>{p.total} total</span>
                  {p.breached > 0 && <Badge variant="danger">{p.breached} breached</Badge>}
                  <span>{formatSeconds(p.avgResponseSeconds)} avg</span>
                </span>
              </div>
            ))
          )}
        </div>

        <div>
          <div className={styles.breakdownTitle}>By employee</div>
          {data.byEmployee.length === 0 ? (
            <div className={styles.row}>No data yet.</div>
          ) : (
            data.byEmployee.map((e) => (
              <div key={e.assignedUserId} className={styles.row}>
                <span className={styles.rowLabel}>{e.assignedUserId}</span>
                <span className={styles.rowMeta}>
                  <span>{e.total} total</span>
                  {e.breached > 0 && <Badge variant="danger">{e.breached} breached</Badge>}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </SectionCard>
  );
}

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, Skeleton } from '@/components/ui';
import { emailAnalyticsService } from '@/services/emailAnalyticsService';
import { EmailDetailModal } from '@/features/business-intelligence/components/EmailDetailModal';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import styles from './EmailResponseSlaTable.module.css';

function bucketCount(buckets: { bucket: string; count: number }[] | undefined, key: string): number {
  return buckets?.find((b) => b.bucket.toLowerCase() === key)?.count ?? 0;
}

function urgencyCount(byUrgency: { value: string; count: number }[] | undefined): number {
  return byUrgency?.find((u) => u.value.toLowerCase() === 'urgent')?.count ?? 0;
}

export interface EmailResponseSlaTableProps {
  dateFrom: string;
  dateTo: string;
  storeId?: string;
}

// "Missed" here means the app's own real definition (see
// EmailIntelligenceService.getEmailProductivityStats): a relevant email
// still pending a reply more than 24h after it was received — not a
// generic "response time" metric this app doesn't compute. Urgent and the
// three age buckets (24-48h/48-72h/72h+) both come from the same real
// per-employee "missed" breakdown (byUrgency/ageBuckets); there is no 0-24h
// bucket because a missed email is by definition already >24h old.
export function EmailResponseSlaTable({ dateFrom, dateTo, storeId }: EmailResponseSlaTableProps) {
  const filters = { dateFrom, dateTo, storeId: storeId ? [storeId] : [] };
  const [selectedEmployee, setSelectedEmployee] = useState<{ userId: string; userName: string } | null>(null);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);

  const { data: employeeMissed, isLoading: employeeMissedLoading } = useQuery({
    queryKey: ['dash-email-sla-employee-missed', dateFrom, dateTo, storeId, selectedEmployee?.userId],
    queryFn: () => emailAnalyticsService.listEmails('missed', { ...filters, employeeId: [selectedEmployee!.userId] }, 1, 100),
    enabled: !!selectedEmployee,
  });

  const { data: sent, isLoading: sentLoading } = useQuery({
    queryKey: ['dash-email-sla-sent', dateFrom, dateTo, storeId],
    queryFn: () => emailAnalyticsService.getByEmployee('sent', filters),
  });
  const { data: missed, isLoading: missedLoading } = useQuery({
    queryKey: ['dash-email-sla-missed', dateFrom, dateTo, storeId],
    queryFn: () => emailAnalyticsService.getByEmployee('missed', filters),
  });

  const rows = useMemo(() => {
    const byUser = new Map<string, { userName: string; sent: number; missed: number; urgent: number; b24: number; b48: number; b72: number }>();
    for (const r of sent?.rows ?? []) {
      byUser.set(r.userId, { userName: r.userName, sent: r.count, missed: 0, urgent: 0, b24: 0, b48: 0, b72: 0 });
    }
    for (const r of missed?.rows ?? []) {
      const existing = byUser.get(r.userId) ?? { userName: r.userName, sent: 0, missed: 0, urgent: 0, b24: 0, b48: 0, b72: 0 };
      existing.missed = r.count;
      existing.urgent = urgencyCount(r.byUrgency);
      existing.b24 = bucketCount(r.ageBuckets, '24-48h');
      existing.b48 = bucketCount(r.ageBuckets, '48-72h');
      existing.b72 = bucketCount(r.ageBuckets, '72h+');
      byUser.set(r.userId, existing);
    }
    return [...byUser.entries()].map(([userId, v]) => ({ userId, ...v })).sort((a, b) => b.sent + b.missed - (a.sent + a.missed));
  }, [sent, missed]);

  const isLoading = sentLoading || missedLoading;

  const employeeMissedRows: DrillDownRow[] = (employeeMissed?.items ?? []).map((item) => ({
    id: item._id,
    title: item.subject || '(no subject)',
    subtitle: item.matchedBusinessName ?? item.fromAddress,
    meta: new Date(item.receivedAt).toLocaleString(),
  }));

  return (
    <Card className={styles.card}>
      <div className={styles.title}>
        Unanswered Email Aging
      </div>
      <p className={styles.subtitle}>Sent vs missed, bucketed by time to reply.</p>

      {isLoading ? (
        <Skeleton height={120} />
      ) : rows.length === 0 ? (
        <div className={styles.empty}>No email activity in scope for this period.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Sent</th>
                <th>Missed</th>
                <th>Urgent</th>
                <th>24-48h</th>
                <th>48-72h</th>
                <th>72h+</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const total = r.sent + r.missed;
                const missedPct = total > 0 ? (r.missed / total) * 100 : 0;
                return (
                  <tr key={r.userId} className={styles.clickableRow} onClick={() => setSelectedEmployee({ userId: r.userId, userName: r.userName })}>
                    <td className={styles.nameCell}>{r.userName}</td>
                    <td>{r.sent}</td>
                    <td>
                      <div className={styles.missedCell}>
                        <span>{r.missed}</span>
                        <div className={styles.missedTrack}>
                          <div className={styles.missedFill} style={{ width: `${missedPct}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className={r.urgent > 0 ? styles.urgentValue : undefined}>{r.urgent}</td>
                    <td>{r.b24}</td>
                    <td>{r.b48}</td>
                    <td>{r.b72}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <DrillDownModal
        open={!!selectedEmployee}
        onClose={() => setSelectedEmployee(null)}
        title={selectedEmployee ? `${selectedEmployee.userName} — Missed Emails` : ''}
        isLoading={employeeMissedLoading}
        rows={employeeMissedRows}
        onRowClick={(row) => setSelectedEmailId(row.id)}
      />
      <EmailDetailModal id={selectedEmailId} onClose={() => setSelectedEmailId(null)} />
    </Card>
  );
}

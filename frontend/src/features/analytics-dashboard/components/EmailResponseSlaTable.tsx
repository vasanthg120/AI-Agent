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

type DrillKind = 'sent' | 'replied' | 'missed';

const DRILL_TITLE: Record<DrillKind, string> = {
  sent: 'Sent (AI draft)',
  replied: 'Replied in Outlook',
  missed: 'Missed',
};

export interface EmailResponseSlaTableProps {
  dateFrom: string;
  dateTo: string;
  storeId?: string;
}

// Three real, mutually-exclusive outcomes for a relevant inbound email —
// never a generic "response time" metric this app doesn't compute:
//   - Sent: replied via this app's own AI-draft-and-send flow (sentAt set).
//   - Replied: answered directly in the real Outlook client, detected by
//     cross-referencing the email's conversation thread against Sent Items
//     during sync (externalReplyDetectedAt set) — see
//     EmailIntelligenceSyncService.detectExternalReplies. Without this, an
//     email a salesperson already handled — just not through this app —
//     used to get miscounted as Missed once it crossed 24h old.
//   - Missed: still status:'pending' more than 24h after receivedAt, with
//     neither of the above. Urgent and the three age buckets (24-48h/
//     48-72h/72h+) come from this same per-employee "missed" breakdown;
//     there is no 0-24h bucket because a missed email is by definition
//     already >24h old.
// Click any Sent/Replied/Missed number to see that employee's actual list.
export function EmailResponseSlaTable({ dateFrom, dateTo, storeId }: EmailResponseSlaTableProps) {
  const filters = { dateFrom, dateTo, storeId: storeId ? [storeId] : [] };
  const [drillDown, setDrillDown] = useState<{ userId: string; userName: string; kind: DrillKind } | null>(null);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);

  const { data: employeeDrillItems, isLoading: employeeDrillLoading } = useQuery({
    queryKey: ['dash-email-sla-employee-drill', dateFrom, dateTo, storeId, drillDown?.userId, drillDown?.kind],
    queryFn: () => emailAnalyticsService.listEmails(drillDown!.kind, { ...filters, employeeId: [drillDown!.userId] }, 1, 100),
    enabled: !!drillDown,
  });

  const { data: sent, isLoading: sentLoading } = useQuery({
    queryKey: ['dash-email-sla-sent', dateFrom, dateTo, storeId],
    queryFn: () => emailAnalyticsService.getByEmployee('sent', filters),
  });
  const { data: replied, isLoading: repliedLoading } = useQuery({
    queryKey: ['dash-email-sla-replied', dateFrom, dateTo, storeId],
    queryFn: () => emailAnalyticsService.getByEmployee('replied', filters),
  });
  const { data: missed, isLoading: missedLoading } = useQuery({
    queryKey: ['dash-email-sla-missed', dateFrom, dateTo, storeId],
    queryFn: () => emailAnalyticsService.getByEmployee('missed', filters),
  });

  const rows = useMemo(() => {
    const byUser = new Map<
      string,
      { userName: string; sent: number; replied: number; missed: number; urgent: number; b24: number; b48: number; b72: number }
    >();
    const get = (userId: string, userName: string) => {
      const existing = byUser.get(userId);
      if (existing) return existing;
      const created = { userName, sent: 0, replied: 0, missed: 0, urgent: 0, b24: 0, b48: 0, b72: 0 };
      byUser.set(userId, created);
      return created;
    };
    for (const r of sent?.rows ?? []) get(r.userId, r.userName).sent = r.count;
    for (const r of replied?.rows ?? []) get(r.userId, r.userName).replied = r.count;
    for (const r of missed?.rows ?? []) {
      const row = get(r.userId, r.userName);
      row.missed = r.count;
      row.urgent = urgencyCount(r.byUrgency);
      row.b24 = bucketCount(r.ageBuckets, '24-48h');
      row.b48 = bucketCount(r.ageBuckets, '48-72h');
      row.b72 = bucketCount(r.ageBuckets, '72h+');
    }
    return [...byUser.entries()]
      .map(([userId, v]) => ({ userId, ...v }))
      .sort((a, b) => b.sent + b.replied + b.missed - (a.sent + a.replied + a.missed));
  }, [sent, replied, missed]);

  const isLoading = sentLoading || repliedLoading || missedLoading;

  const drillRows: DrillDownRow[] = (employeeDrillItems?.items ?? []).map((item) => ({
    id: item._id,
    title: item.subject || '(no subject)',
    subtitle: item.matchedBusinessName ?? item.fromAddress,
    meta: new Date(item.receivedAt).toLocaleString(),
  }));

  const openDrill = (userId: string, userName: string, kind: DrillKind) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setDrillDown({ userId, userName, kind });
  };

  return (
    <Card className={styles.card}>
      <div className={styles.title}>Email response SLA</div>
      <p className={styles.subtitle}>Sent (AI draft), replied (answered directly in Outlook), and missed — click a number to see the list.</p>

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
                <th>Replied</th>
                <th>Missed</th>
                <th>Urgent</th>
                <th>24-48h</th>
                <th>48-72h</th>
                <th>72h+</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const total = r.sent + r.replied + r.missed;
                const missedPct = total > 0 ? (r.missed / total) * 100 : 0;
                return (
                  <tr key={r.userId}>
                    <td className={styles.nameCell}>{r.userName}</td>
                    <td className={styles.clickableCell} onClick={openDrill(r.userId, r.userName, 'sent')}>
                      {r.sent}
                    </td>
                    <td className={styles.clickableCell} onClick={openDrill(r.userId, r.userName, 'replied')}>
                      {r.replied}
                    </td>
                    <td className={styles.clickableCell} onClick={openDrill(r.userId, r.userName, 'missed')}>
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
        open={!!drillDown}
        onClose={() => setDrillDown(null)}
        title={drillDown ? `${drillDown.userName} — ${DRILL_TITLE[drillDown.kind]}` : ''}
        isLoading={employeeDrillLoading}
        rows={drillRows}
        onRowClick={(row) => setSelectedEmailId(row.id)}
      />
      <EmailDetailModal id={selectedEmailId} onClose={() => setSelectedEmailId(null)} />
    </Card>
  );
}

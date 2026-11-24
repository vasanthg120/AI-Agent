import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Skeleton } from '@/components/ui';
import { workAutomationService } from '@/services/workAutomationService';
import type { EodReportDetail, TaskSnapshot } from '@/services/workAutomationService';
import { assessmentSentence, DELIVERY_VARIANT, evidenceLabel, platformLabel, skipReasonLabel } from './workUtils';
import styles from './Work.module.css';

function Group({ title, items, evidence }: { title: string; items: TaskSnapshot[]; evidence?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.group}>
      <h4 className={styles.groupTitle}>
        {title} <Badge>{items.length}</Badge>
      </h4>
      <div className={styles.list}>
        {items.map((t) => (
          <div key={t.taskId} className={styles.row}>
            <div className={styles.rowMain}>
              <span className={styles.title}>{t.title}</span>
              <div className={styles.meta}>
                <span>{t.priority}</span>
                <span>{platformLabel(t.sourcePlatform)}</span>
                {t.dueDate && <span>due {new Date(t.dueDate).toLocaleDateString()}</span>}
              </div>
              {evidence && t.evidence && (
                <span className={styles.evidence}>
                  {evidenceLabel(t.evidence.type)}: {t.evidence.detail}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One generated EOD report with its delivery log. Admins may retry failed deliveries. */
export function EodReportView({ reportId, canResend }: { reportId: string; canResend?: boolean }) {
  const report = useQuery({ queryKey: ['work-eod', reportId], queryFn: () => workAutomationService.report(reportId) });
  const deliveries = useQuery({ queryKey: ['work-eod-deliveries', reportId], queryFn: () => workAutomationService.deliveries(reportId) });

  if (report.isLoading) return <Skeleton height={160} />;
  if (!report.data) return null;
  const r: EodReportDetail = report.data;
  const s = r.sections;

  return (
    <div className={styles.report}>
      <div className={styles.meta}>
        <strong>{r.employeeName}</strong>
        <span>
          {r.date} ({r.timezone})
        </span>
        {r.wasMissed && <Badge variant="warning">Generated late</Badge>}
      </div>
      {r.summary && (
        <div>
          <div className={styles.meta}>{r.summarySource === 'ai' ? 'AI summary of the verified records below' : 'Summary'}</div>
          <p className={styles.summary}>{r.summary}</p>
        </div>
      )}
      {s?.assessment && s.assessment.headline !== 'worked' && (
        <div className={styles.note} data-testid="assessment">
          {assessmentSentence(s.assessment, s.counts.pending + s.counts.overdue + s.counts.blocked + s.counts.awaitingVerification)}
        </div>
      )}
      {r.dataGaps.length > 0 && <div className={styles.note}>{r.dataGaps.join(' ')}</div>}
      {s && (
        <>
          <Group title="Completed" items={s.completed} evidence />
          <Group title="Overdue" items={s.overdue} />
          <Group title="Blocked" items={s.blocked} />
          <Group title="Awaiting verification" items={s.awaitingVerification} />
          <Group title="Pending" items={s.pending} />
          <Group title="Customer follow-ups still open" items={s.customerFollowUps.pending} />
          {s.meetings.items.length > 0 && (
            <div className={styles.group}>
              <h4 className={styles.groupTitle}>
                Meetings <Badge>{s.meetings.items.length}</Badge>
              </h4>
              {s.meetings.items.map((m, i) => (
                <div key={i} className={styles.meta}>
                  {m.title}
                </div>
              ))}
            </div>
          )}
          {s.crmUpdates.length > 0 && (
            <div className={styles.group}>
              <h4 className={styles.groupTitle}>
                CRM updates <Badge>{s.crmUpdates.length}</Badge>
              </h4>
              {s.crmUpdates.map((c, i) => (
                <div key={i} className={styles.meta}>
                  {c.entity} {c.kind}
                  {c.customerName ? ` — ${c.customerName}` : ''}
                </div>
              ))}
            </div>
          )}
          <Group title="Next-day priorities" items={s.nextDayPriorities} />
        </>
      )}
      <div className={styles.group}>
        <h4 className={styles.groupTitle}>Email delivery</h4>
        {(deliveries.data ?? []).length === 0 && <span className={styles.meta}>No deliveries recorded.</span>}
        {(deliveries.data ?? []).map((d) => (
          <div key={d.role} className={styles.meta}>
            <Badge variant={DELIVERY_VARIANT[d.status]}>{d.status}</Badge>
            <span>{d.role === 'manager' ? 'Manager' : 'Employee'}</span>
            {d.recipientEmail && <span>{d.recipientEmail}</span>}
            {d.channel && <span>via {d.channel}</span>}
            {d.attempts > 0 && <span>{d.attempts} attempt(s)</span>}
            {d.skippedReason && <span>{skipReasonLabel(d.skippedReason)}</span>}
            {d.lastError && d.status === 'failed' && <span className={styles.error}>{d.lastError}</span>}
          </div>
        ))}
        {canResend && (deliveries.data ?? []).some((d) => d.status === 'failed') && (
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={async () => {
                await workAutomationService.resend(reportId);
                void deliveries.refetch();
              }}
            >
              Retry failed deliveries
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

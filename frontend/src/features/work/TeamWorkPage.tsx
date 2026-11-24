import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiUsers } from 'react-icons/fi';
import { Badge, EmptyState, Modal, PageHeader, Skeleton, StatTile } from '@/components/ui';
import { workAutomationService } from '@/services/workAutomationService';
import type { TeamRow } from '@/services/workAutomationService';
import { EodReportView } from './EodReportView';
import { WorkTaskRow } from './WorkTaskRow';
import { REPORT_STATE_LABEL, REPORT_STATE_VARIANT } from './workUtils';
import styles from './Work.module.css';

/** A manager's (or admin's) view of the people they oversee: task state, who has an EOD report, who is missing one. */
export function TeamWorkPage() {
  const queryClient = useQueryClient();
  const team = useQuery({ queryKey: ['work-team'], queryFn: () => workAutomationService.team() });
  const [person, setPerson] = useState<TeamRow | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);

  const personDay = useQuery({
    queryKey: ['work-user-day', person?.userId],
    queryFn: () => workAutomationService.userDay(person!.userId),
    enabled: !!person,
  });

  const t = team.data;

  return (
    <div className={styles.page}>
      <PageHeader icon={FiUsers} title="Team Work" subtitle="Task status and daily EOD reports for the people who report to you." />

      {team.isLoading ? (
        <Skeleton height={160} />
      ) : !t || t.rows.length === 0 ? (
        <EmptyState icon={FiUsers} title="No one reports to you yet" description="An admin sets each person's reporting manager under Settings → Work automation." />
      ) : (
        <>
          <div className={styles.tiles}>
            <StatTile label="People" value={t.totals.people} />
            <StatTile label="Open tasks" value={t.totals.open} />
            <StatTile label="Overdue" value={t.totals.overdue} />
            <StatTile label="Completed today" value={t.totals.completedToday} />
            <StatTile label="EOD reports" value={t.totals.reportsGenerated} />
            <StatTile label="Missing reports" value={t.totals.reportsMissing} />
          </div>
          <div className={styles.meta}>
            {t.date} ({t.timezone}) · reports are generated at {t.eodTime}
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th>Person</th>
                <th className={styles.num}>Open</th>
                <th className={styles.num}>Overdue</th>
                <th className={styles.num}>Completed today</th>
                <th className={styles.num}>Awaiting verification</th>
                <th>EOD report</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r) => (
                <tr key={r.userId} className={styles.clickable} onClick={() => setPerson(r)} data-testid="team-row">
                  <td>
                    {r.name}
                    <div className={styles.meta}>{r.email}</div>
                  </td>
                  <td className={styles.num}>{r.counts.open}</td>
                  <td className={styles.num}>{r.counts.overdue}</td>
                  <td className={styles.num}>{r.counts.completedToday}</td>
                  <td className={styles.num}>{r.counts.awaitingVerification}</td>
                  <td>
                    <Badge variant={REPORT_STATE_VARIANT[r.report.state]}>{REPORT_STATE_LABEL[r.report.state]}</Badge>
                    {r.report.reportId && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className={styles.link}
                          onClick={(e) => {
                            e.stopPropagation();
                            setReportId(r.report.reportId ?? null);
                          }}
                        >
                          View
                        </button>
                      </>
                    )}
                    {r.report.deliveries.manager && <div className={styles.meta}>Manager copy: {r.report.deliveries.manager}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <Modal open={!!person} onClose={() => setPerson(null)} title={person ? `${person.name} — today` : undefined} maxWidth={760}>
        {personDay.isLoading && <Skeleton height={120} />}
        {personDay.data && (
          <div className={styles.list}>
            {[...personDay.data.overdue, ...personDay.data.open, ...personDay.data.completed].length === 0 && <span className={styles.meta}>No tracked work.</span>}
            {[...personDay.data.overdue, ...personDay.data.open, ...personDay.data.completed].map((task) => (
              <WorkTaskRow
                key={task.id}
                task={task}
                isAssignee={false}
                canVerify
                onChanged={() => {
                  void queryClient.invalidateQueries({ queryKey: ['work-user-day', person?.userId] });
                  void queryClient.invalidateQueries({ queryKey: ['work-team'] });
                }}
              />
            ))}
          </div>
        )}
      </Modal>

      <Modal open={!!reportId} onClose={() => setReportId(null)} title="End-of-day report" maxWidth={760}>
        {reportId && <EodReportView reportId={reportId} canResend={t?.admin} />}
      </Modal>
    </div>
  );
}

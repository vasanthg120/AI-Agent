import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  FiBriefcase,
  FiCalendar,
  FiCheckCircle,
  FiChevronLeft,
  FiChevronRight,
  FiClock,
  FiDownload,
  FiFileText,
  FiMail,
  FiUserPlus,
} from 'react-icons/fi';
import { Badge, Button, Dropdown, IconButton, SectionCard, Skeleton, StatTile, Tabs } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { dayjs, todayUtc } from '@/utils/date';
import { todoEodService } from '@/services/todoEodService';
import { GenerateReportEmptyState } from './components/GenerateReportEmptyState';
import { MonthCalendar } from './components/MonthCalendar';
import { PRIORITY_VARIANT } from './components/TaskCard';
import styles from './EodPage.module.css';

const VIEW_TABS = [
  { id: 'report', label: 'Report' },
  { id: 'calendar', label: 'Calendar' },
];

// A real, separate EOD page — previously the only place an EOD report's own
// content (DailyReport.summary) ever rendered anywhere in the whole
// frontend was a truncated line on the owner/admin-only Agent Activity
// dashboard (AgentFocusedView.tsx); an ordinary user had no way to see
// their own end-of-day report at all. Every figure below (other than the
// narrative summary itself) is a real, live aggregate — see
// tasks.service.ts's getEodSummary — never an LLM-narrated approximation,
// so this can never disagree with what actually happened that day.
//
// Report/Calendar tabs + a Download option mirror To-Do's own
// TodoEodPage.tsx exactly (same Tabs control, same date-nav row, same
// Dropdown-based export) — reuses todoEodService.downloadExport(), the same
// task-export endpoint To-Do already uses, scoped to whichever day is being
// viewed here, so the two pages feel like one consistent feature, not two
// unrelated ones with different UX for the same kind of action.
export function EodPage() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'report' | 'calendar'>('report');
  const [month, setMonth] = useState(todayUtc().slice(0, 7));
  // The report view is scoped to a single day (EOD reports are per-day) —
  // default to today, but let the user step back/forward, or jump via the
  // Calendar tab, to whichever day actually has a generated report.
  const [eodDate, setEodDate] = useState(todayUtc());
  const isToday = eodDate === todayUtc();

  const { data, isLoading } = useQuery({
    queryKey: ['eod-summary', eodDate],
    queryFn: () => todoEodService.getEodSummary(eodDate),
  });

  const { data: calendarData } = useQuery({
    queryKey: ['eod-calendar', month],
    queryFn: () => todoEodService.getCalendar(month, 'eod'),
    enabled: view === 'calendar',
  });

  const handleGenerated = () => {
    void queryClient.invalidateQueries({ queryKey: ['eod-summary', eodDate] });
    void queryClient.invalidateQueries({ queryKey: ['eod-calendar', month] });
  };

  const handleSelectDate = (date: string) => {
    setEodDate(date);
    setView('report');
  };

  const handleDownload = async (format: 'pdf' | 'csv') => {
    try {
      await todoEodService.downloadEodExport(format, eodDate);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <span className={styles.pageTitle}>EOD Report</span>
        <div className={styles.headerActions}>
          <Tabs items={VIEW_TABS} activeId={view} onChange={(id) => setView(id as 'report' | 'calendar')} />
          <Dropdown
            align="right"
            trigger={
              <Button type="button" variant="outline" leftIcon={<FiDownload />}>
                Download
              </Button>
            }
            items={[
              { id: 'pdf', label: 'Export as PDF', onSelect: () => void handleDownload('pdf') },
              { id: 'csv', label: 'Export as CSV', onSelect: () => void handleDownload('csv') },
            ]}
          />
        </div>
      </div>

      {view === 'calendar' ? (
        <SectionCard title="Calendar" icon={FiCalendar}>
          <MonthCalendar month={month} days={calendarData?.days ?? []} selectedDate={eodDate} onSelectDate={handleSelectDate} onMonthChange={setMonth} />
        </SectionCard>
      ) : (
        <>
          <div className={styles.dateNav}>
            <IconButton
              icon={<FiChevronLeft />}
              label="Previous day"
              onClick={() => setEodDate(dayjs(eodDate).subtract(1, 'day').format('YYYY-MM-DD'))}
            />
            <span className={styles.dateLabel}>{dayjs(eodDate).format('dddd, MMM D, YYYY')}</span>
            <IconButton
              icon={<FiChevronRight />}
              label="Next day"
              onClick={() => setEodDate(dayjs(eodDate).add(1, 'day').format('YYYY-MM-DD'))}
            />
            {!isToday && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setEodDate(todayUtc())}>
                Today
              </Button>
            )}
          </div>

          {isLoading || !data ? (
            <>
              <Skeleton height={100} />
              <Skeleton height={220} />
            </>
          ) : !data.reportExists ? (
            <SectionCard title="Summary" icon={FiFileText}>
              <GenerateReportEmptyState
                reportType="eod"
                title={isToday ? "Today's EOD report hasn't been generated yet" : 'No EOD report for this day'}
                description={
                  isToday
                    ? 'It runs automatically near closing time. An admin can generate it now instead of waiting.'
                    : "This day doesn't have a generated EOD report."
                }
                showAction={isToday}
                onGenerated={handleGenerated}
              />
            </SectionCard>
          ) : (
            <>
              {data.narrativeSummary && (
                <SectionCard title="Summary" icon={FiFileText}>
                  <p className={styles.narrative}>{data.narrativeSummary}</p>
                </SectionCard>
              )}

              <div className={styles.statGrid}>
                <StatTile icon={FiCheckCircle} value={data.tasksCompleted.length} label="Tasks Completed" />
                <StatTile icon={FiClock} value={data.tasksPending.length} label="Tasks Pending" />
                <StatTile icon={FiMail} value={data.email.received} label="Emails Received" />
                <StatTile icon={FiMail} value={data.email.responded} label="Emails Responded" />
                <StatTile icon={FiBriefcase} value={data.crm.dealsCreated + data.crm.quotesCreated} label="New CRM Records" />
                <StatTile icon={FiUserPlus} value={data.newContactsAcrossOrg + data.newAccountsAcrossOrg} label="New Contacts/Accounts (org-wide)" />
              </div>

              <div className={styles.columns}>
                <SectionCard title="Email Activity" icon={FiMail}>
                  <div className={styles.detailRow}>
                    <span>Received</span>
                    <span className={styles.detailValue}>{data.email.received}</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span>Sent</span>
                    <span className={styles.detailValue}>{data.email.sent}</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span>Responded to</span>
                    <span className={styles.detailValue}>{data.email.responded}</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span>Still pending</span>
                    <span className={styles.detailValue}>{data.email.pending}</span>
                  </div>
                </SectionCard>

                <SectionCard title="CRM Activity" icon={FiBriefcase}>
                  <div className={styles.detailRow}>
                    <span>Deals created</span>
                    <span className={styles.detailValue}>{data.crm.dealsCreated}</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span>Deals updated</span>
                    <span className={styles.detailValue}>{data.crm.dealsUpdated}</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span>Quotes created</span>
                    <span className={styles.detailValue}>{data.crm.quotesCreated}</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span>Quotes updated</span>
                    <span className={styles.detailValue}>{data.crm.quotesUpdated}</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span>New contacts (org-wide)</span>
                    <span className={styles.detailValue}>{data.newContactsAcrossOrg}</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span>New accounts (org-wide)</span>
                    <span className={styles.detailValue}>{data.newAccountsAcrossOrg}</span>
                  </div>
                </SectionCard>
              </div>

              <SectionCard title="Tasks Completed" icon={FiCheckCircle}>
                {data.tasksCompleted.length === 0 ? (
                  <div className={styles.emptyState}>Nothing completed on this day.</div>
                ) : (
                  <div className={styles.taskList}>
                    {data.tasksCompleted.map((task) => (
                      <div key={task.id} className={styles.taskRow}>
                        <span>{task.title}</span>
                        <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>

              <SectionCard title="Pending — Needs Attention" icon={FiClock}>
                {data.tasksPending.length === 0 ? (
                  <div className={styles.emptyState}>Nothing pending on this day.</div>
                ) : (
                  <div className={styles.taskList}>
                    {data.tasksPending.map((task) => (
                      <div key={task.id} className={styles.taskRow}>
                        <span>{task.title}</span>
                        <div className={styles.taskRowBadges}>
                          {task.isOverdue && <Badge variant="danger">Overdue</Badge>}
                          <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </>
          )}
        </>
      )}
    </div>
  );
}

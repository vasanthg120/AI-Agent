import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import {
  FiBriefcase,
  FiCalendar,
  FiCheckCircle,
  FiClock,
  FiDownload,
  FiFileText,
  FiMail,
  FiStar,
  FiSun,
  FiUserPlus,
} from 'react-icons/fi';
import {
  AnimatedNumber,
  Badge,
  Button,
  Dropdown,
  EmptyState,
  PageHeader,
  SectionCard,
  Skeleton,
  StatTile,
  Tabs,
} from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { dayjs, todayUtc } from '@/utils/date';
import { todoEodService, type TodoTask } from '@/services/todoEodService';
import { DateStepper } from './components/DateStepper';
import { GenerateReportEmptyState } from './components/GenerateReportEmptyState';
import { MonthCalendar } from './components/MonthCalendar';
import { PRIORITY_VARIANT } from './components/TaskCard';
import styles from './EodPage.module.css';

const VIEW_TABS = [
  { id: 'report', label: 'Report', icon: <FiFileText /> },
  { id: 'calendar', label: 'Calendar', icon: <FiCalendar /> },
];

const EASE = [0.16, 1, 0.3, 1] as const;

// A ring showing what share of the day's tasks got done.
function CompletionRing({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <div className={styles.ringWrap}>
      <svg className={styles.ring} viewBox="0 0 84 84" aria-hidden>
        <circle cx="42" cy="42" r={r} className={styles.ringTrack} />
        <motion.circle
          cx="42"
          cy="42"
          r={r}
          className={styles.ringFill}
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - pct / 100) }}
          transition={{ duration: 1.1, ease: EASE }}
        />
      </svg>
      <span className={styles.ringCenter}>
        <span className={styles.ringPct}>
          <AnimatedNumber value={pct} />%
        </span>
        <span className={styles.ringCaption}>done</span>
      </span>
    </div>
  );
}

// A labelled figure with a bar showing it as a share of `max`.
function MeterRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max === 0 ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div className={styles.meterRow}>
      <div className={styles.meterTop}>
        <span>{label}</span>
        <span className={styles.detailValue}>
          <AnimatedNumber value={value} />
        </span>
      </div>
      <div className={styles.meterTrack}>
        <motion.div
          className={styles.meterFill}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: EASE, delay: 0.15 }}
        />
      </div>
    </div>
  );
}

function TaskList({ tasks, showOverdue }: { tasks: TodoTask[]; showOverdue?: boolean }) {
  return (
    <div className={styles.taskList}>
      {tasks.map((task, i) => (
        <motion.div
          key={task.id}
          className={styles.taskRow}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25, delay: Math.min(i, 10) * 0.03 }}
        >
          <span>{task.title}</span>
          <div className={styles.taskRowBadges}>
            {showOverdue && task.isOverdue && <Badge variant="danger">Overdue</Badge>}
            <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

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
// TodoEodPage.tsx exactly (same Tabs control, same DateStepper, same
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

  const totalTasks = data ? data.tasksCompleted.length + data.tasksPending.length : 0;
  const responseRate = data && data.email.received > 0 ? Math.round((data.email.responded / data.email.received) * 100) : null;
  const crmMax = data ? Math.max(1, data.crm.dealsCreated, data.crm.dealsUpdated, data.crm.quotesCreated, data.crm.quotesUpdated) : 1;

  return (
    <div className={styles.page}>
      <PageHeader
        icon={FiSun}
        title="EOD Report"
        subtitle="How the day went — tasks, email and CRM activity, summarized at closing time."
        actions={
          <>
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
          </>
        }
      />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view === 'calendar' ? 'calendar' : `report-${eodDate}`}
          className={styles.viewArea}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: EASE }}
        >
          {view === 'calendar' ? (
            <SectionCard title="Pick a day" icon={FiCalendar}>
              <p className={styles.calendarHint}>Days with a dot have an EOD report. Click one to open it.</p>
              <div className={styles.calendarWrap}>
                <MonthCalendar
                  month={month}
                  days={calendarData?.days ?? []}
                  selectedDate={eodDate}
                  onSelectDate={handleSelectDate}
                  onMonthChange={setMonth}
                />
              </div>
            </SectionCard>
          ) : (
            <>
              <DateStepper date={eodDate} onChange={setEodDate} />

              {isLoading || !data ? (
                <div className={styles.loading}>
                  <Skeleton height={150} />
                  <div className={styles.statGrid}>
                    {[0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} height={96} />
                    ))}
                  </div>
                  <Skeleton height={220} />
                </div>
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
                  <div className={styles.hero}>
                    <CompletionRing done={data.tasksCompleted.length} total={totalTasks} />
                    <div className={styles.heroText}>
                      <span className={styles.heroTitle}>
                        {data.tasksCompleted.length} of {totalTasks} tasks completed
                      </span>
                      <span className={styles.heroSub}>
                        {responseRate !== null
                          ? `${responseRate}% of incoming emails got a reply`
                          : 'No incoming email this day'}
                        {data.reportGeneratedAt && ` · Report generated ${dayjs(data.reportGeneratedAt).format('h:mm A')}`}
                      </span>
                    </div>
                  </div>

                  {data.narrativeSummary && (
                    <div className={styles.aiSummary}>
                      <span className={styles.aiBadge}>
                        <FiStar /> AI summary
                      </span>
                      <p className={styles.narrative}>{data.narrativeSummary}</p>
                    </div>
                  )}

                  <div className={styles.statGrid}>
                    <StatTile icon={FiCheckCircle} value={data.tasksCompleted.length} label="Tasks completed" />
                    <StatTile icon={FiClock} value={data.tasksPending.length} label="Tasks pending" />
                    <StatTile icon={FiMail} value={data.email.received} label="Emails received" />
                    <StatTile icon={FiMail} value={data.email.responded} label="Emails responded" />
                    <StatTile icon={FiBriefcase} value={data.crm.dealsCreated + data.crm.quotesCreated} label="New CRM records" />
                    <StatTile
                      icon={FiUserPlus}
                      value={data.newContactsAcrossOrg + data.newAccountsAcrossOrg}
                      label="New contacts/accounts (org-wide)"
                    />
                  </div>

                  <div className={styles.columns}>
                    <SectionCard title="Email activity" icon={FiMail}>
                      <div className={styles.meters}>
                        <MeterRow label="Received" value={data.email.received} max={Math.max(1, data.email.received, data.email.sent)} />
                        <MeterRow label="Sent" value={data.email.sent} max={Math.max(1, data.email.received, data.email.sent)} />
                        <MeterRow label="Responded to" value={data.email.responded} max={Math.max(1, data.email.received)} />
                        <MeterRow label="Still pending" value={data.email.pending} max={Math.max(1, data.email.received)} />
                      </div>
                    </SectionCard>

                    <SectionCard title="CRM activity" icon={FiBriefcase}>
                      <div className={styles.meters}>
                        <MeterRow label="Deals created" value={data.crm.dealsCreated} max={crmMax} />
                        <MeterRow label="Deals updated" value={data.crm.dealsUpdated} max={crmMax} />
                        <MeterRow label="Quotes created" value={data.crm.quotesCreated} max={crmMax} />
                        <MeterRow label="Quotes updated" value={data.crm.quotesUpdated} max={crmMax} />
                      </div>
                      <div className={styles.orgNote}>
                        <span>
                          New contacts (org-wide) <strong>{data.newContactsAcrossOrg}</strong>
                        </span>
                        <span>
                          New accounts (org-wide) <strong>{data.newAccountsAcrossOrg}</strong>
                        </span>
                      </div>
                    </SectionCard>
                  </div>

                  <div className={styles.columns}>
                    <SectionCard title="Tasks completed" icon={FiCheckCircle}>
                      {data.tasksCompleted.length === 0 ? (
                        <EmptyState compact icon={FiCheckCircle} title="Nothing completed on this day" />
                      ) : (
                        <TaskList tasks={data.tasksCompleted} />
                      )}
                    </SectionCard>

                    <SectionCard title="Pending — needs attention" icon={FiClock}>
                      {data.tasksPending.length === 0 ? (
                        <EmptyState compact icon={FiClock} title="Nothing left pending" description="Every task was wrapped up." />
                      ) : (
                        <TaskList tasks={data.tasksPending} showOverdue />
                      )}
                    </SectionCard>
                  </div>
                </>
              )}
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

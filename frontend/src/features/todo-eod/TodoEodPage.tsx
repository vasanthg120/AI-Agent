import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiCalendar, FiCheckSquare, FiChevronLeft, FiChevronRight, FiDownload } from 'react-icons/fi';
import { Badge, Button, Card, Dropdown, IconButton, SectionCard, Switch, Tabs } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { dayjs, todayUtc } from '@/utils/date';
import { todoEodService } from '@/services/todoEodService';
import { Board } from './components/Board';
import { GenerateReportEmptyState } from './components/GenerateReportEmptyState';
import { MonthCalendar } from './components/MonthCalendar';
import { PRIORITY_VARIANT } from './components/TaskCard';
import type { TaskSource } from './utils/taskSource';
import styles from './TodoEodPage.module.css';

// Same queryKey shape as Board.tsx's own ['tasks', params] — React Query
// dedupes identical keys, so this is a second subscriber to the exact same
// cached fetch, never a duplicate request. Only used to decide whether
// today's board is empty because nothing has been generated yet (in which
// case Board's own per-column empty state doesn't explain why, or offer
// anything to do about it) vs. genuinely no tasks — a past date is never
// treated this way, since "Generate Now" can't retroactively backfill it.
function useTodayBoardIsEmpty(params: { dateFrom: string; dateTo: string; mine?: boolean }, enabled: boolean) {
  const { data, isLoading } = useQuery({
    queryKey: ['tasks', params],
    queryFn: () => todoEodService.getTasks(params),
    enabled,
  });
  return enabled && !isLoading && (data?.length ?? 0) === 0;
}

const VIEW_TABS = [
  { id: 'board', label: 'Board' },
  { id: 'calendar', label: 'Calendar' },
];

// category is freeform AI-extracted text (see utils/taskSource.ts), so this
// filter is a best-effort keyword split, not a guaranteed-accurate source
// field — "All" stays the default so nothing is ever hidden by a misclassification.
const SOURCE_TABS: { id: TaskSource | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'crm', label: 'CRM' },
  { id: 'mail', label: 'Mail' },
  { id: 'other', label: 'Other' },
];

export function TodoEodPage() {
  const [view, setView] = useState<'board' | 'calendar'>('board');
  const [sourceFilter, setSourceFilter] = useState<TaskSource | 'all'>('all');
  // Default ON — the personal view (assigned to me + still-unassigned) is
  // now the normal page behavior, matching the server-side default in
  // TasksService.list()/calendarSummary() (both already default to "mine"
  // even if this param is omitted entirely — this toggle is the explicit
  // opt-out to the full shared board, not the thing granting the filtering).
  const [mineOnly, setMineOnly] = useState(true);
  const [month, setMonth] = useState(todayUtc().slice(0, 7));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // The board is scoped to a single day (tasks are grouped per DailyReport,
  // which is per-day) — default to today, but let the user step back to
  // whichever day actually has a generated report, since "today" may not
  // have one yet (morning/EOD generation runs on a schedule). Uses UTC
  // "today" (todayUtc()), matching how the backend buckets reports — the
  // browser's local date can be a full day behind UTC for hours at a time,
  // which made the board default to a date with no data.
  const [boardDate, setBoardDate] = useState(todayUtc());

  const queryClient = useQueryClient();
  const boardParams = { dateFrom: boardDate, dateTo: boardDate, mine: mineOnly || undefined };
  const isToday = boardDate === todayUtc();
  const todayBoardIsEmpty = useTodayBoardIsEmpty(boardParams, isToday);

  const { data: calendarData } = useQuery({
    queryKey: ['tasks-calendar', month],
    queryFn: () => todoEodService.getCalendar(month),
    enabled: view === 'calendar',
  });

  const { data: dateTasks } = useQuery({
    queryKey: ['tasks', { dateFrom: selectedDate ?? undefined, dateTo: selectedDate ?? undefined }],
    queryFn: () => todoEodService.getTasks({ dateFrom: selectedDate ?? undefined, dateTo: selectedDate ?? undefined }),
    enabled: view === 'calendar' && !!selectedDate,
  });

  const handleDownload = async (format: 'pdf' | 'csv') => {
    try {
      const date = view === 'calendar' ? selectedDate : boardDate;
      const params = date ? { dateFrom: date, dateTo: date } : {};
      await todoEodService.downloadExport(format, params);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <span className={styles.pageTitle}>To-Do</span>
        <div className={styles.headerActions}>
          <Tabs items={VIEW_TABS} activeId={view} onChange={(id) => setView(id as 'board' | 'calendar')} />
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

      {view === 'board' ? (
        <>
          <div className={styles.boardDateNav}>
            <IconButton
              icon={<FiChevronLeft />}
              label="Previous day"
              onClick={() => setBoardDate(dayjs(boardDate).subtract(1, 'day').format('YYYY-MM-DD'))}
            />
            <span className={styles.boardDateLabel}>{dayjs(boardDate).format('dddd, MMM D, YYYY')}</span>
            <IconButton
              icon={<FiChevronRight />}
              label="Next day"
              onClick={() => setBoardDate(dayjs(boardDate).add(1, 'day').format('YYYY-MM-DD'))}
            />
            {boardDate !== todayUtc() && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setBoardDate(todayUtc())}>
                Today
              </Button>
            )}
          </div>
          <div className={styles.boardFilterRow}>
            <Tabs items={SOURCE_TABS} activeId={sourceFilter} onChange={(id) => setSourceFilter(id as TaskSource | 'all')} />
            <Switch label="My tasks only" checked={mineOnly} onChange={setMineOnly} />
          </div>
          {todayBoardIsEmpty ? (
            <Card>
              <GenerateReportEmptyState
                reportType="morning"
                title="Today's to-do list hasn't been generated yet"
                description="It runs automatically near opening time. An admin can generate it now instead of waiting."
                onGenerated={() => void queryClient.invalidateQueries({ queryKey: ['tasks', boardParams] })}
              />
            </Card>
          ) : (
            <Board params={boardParams} sourceFilter={sourceFilter} />
          )}
        </>
      ) : (
        <div className={styles.calendarLayout}>
          <div className={styles.calendarPanel}>
            <SectionCard title="Calendar" icon={FiCalendar}>
              <MonthCalendar
                month={month}
                days={calendarData?.days ?? []}
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
                onMonthChange={setMonth}
              />
            </SectionCard>
          </div>
          <div className={styles.selectedDateTasks}>
            <SectionCard title={selectedDate ? `Tasks — ${selectedDate}` : 'Tasks'} icon={FiCheckSquare}>
              {!selectedDate ? (
                <div className={styles.emptyState}>Select a date to see its tasks.</div>
              ) : !dateTasks || dateTasks.length === 0 ? (
                <div className={styles.emptyState}>No tasks for {selectedDate}.</div>
              ) : (
                dateTasks.map((task) => (
                  <div key={task.id} className={styles.taskRow}>
                    <span>{task.title}</span>
                    <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
                  </div>
                ))
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  );
}

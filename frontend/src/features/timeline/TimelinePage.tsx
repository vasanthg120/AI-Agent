import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import type { IconType } from 'react-icons';
import {
  FiAlertTriangle,
  FiAward,
  FiCheckCircle,
  FiClock,
  FiDollarSign,
  FiFileText,
  FiUser,
  FiUsers,
  FiX,
} from 'react-icons/fi';
import { DateRangeControl, EmptyState, MultiSelectDropdown, PageHeader, SectionCard, Skeleton } from '@/components/ui';
import type { DateRange } from '@/components/ui';
import { timelineService, TIMELINE_EVENT_TYPE_OPTIONS, type TimelineEvent } from '@/services/timelineService';
import { dayjs, formatFullDate, formatRelativeTime } from '@/utils/date';
import styles from './TimelinePage.module.css';

type Tone = 'success' | 'warning' | 'info' | 'accent';

// How each event type looks on the rail — an icon that says what happened
// at a glance, and a tone that says whether it needs attention.
const TYPE_STYLE: Record<string, { icon: IconType; tone: Tone }> = {
  daily_report_generated: { icon: FiFileText, tone: 'success' },
  daily_report_missed: { icon: FiAlertTriangle, tone: 'warning' },
  task_completed: { icon: FiCheckCircle, tone: 'success' },
  achievement_unlocked: { icon: FiAward, tone: 'info' },
  customer_activity_summary_generated: { icon: FiUsers, tone: 'accent' },
  customer_activity_personal_summary_generated: { icon: FiUser, tone: 'accent' },
  finance_summary_generated: { icon: FiDollarSign, tone: 'accent' },
};

const TYPE_LABELS: Record<string, string> = Object.fromEntries(TIMELINE_EVENT_TYPE_OPTIONS.map((o) => [o.value, o.label]));

function typeStyle(type: string) {
  return TYPE_STYLE[type] ?? { icon: FiClock, tone: 'accent' as Tone };
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

function dayLabel(day: string): string {
  const d = dayjs(day);
  if (d.isToday()) return 'Today';
  if (d.isYesterday()) return 'Yesterday';
  return d.format('dddd, MMMM D');
}

function groupByDay(events: TimelineEvent[]): [string, TimelineEvent[]][] {
  const groups = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const key = dayjs(event.occurredAt).format('YYYY-MM-DD');
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.entries()];
}

export function TimelinePage() {
  const [range, setRange] = useState<DateRange>({});
  const [types, setTypes] = useState<string[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ['timeline', range],
    queryFn: () => timelineService.list({ from: range.dateFrom, to: range.dateTo }),
    refetchInterval: 60_000,
  });

  // Server-side date filtering (real, applied via the DTO's from/to); type
  // filtering stays client-side over that already-fetched set — the backend
  // DTO only accepts one `type` string, so forwarding a multi-select
  // selection would misrepresent what's actually being asked for.
  const filtered = data?.filter((e) => types.length === 0 || types.includes(e.type));
  const days = useMemo(() => (filtered ? groupByDay(filtered) : []), [filtered]);

  // Per-type counts over the unfiltered set, so the summary chips double as
  // one-click filters that always show what's available.
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of data ?? []) map.set(e.type, (map.get(e.type) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const toggleType = (type: string) =>
    setTypes((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]));

  return (
    <div className={styles.page}>
      <PageHeader
        icon={FiClock}
        title="Timeline"
        subtitle="The business's memory — every significant event, in the order it happened."
      />

      <div className={styles.filterRow}>
        <DateRangeControl value={range} onChange={setRange} />
        <MultiSelectDropdown label="Type" options={TIMELINE_EVENT_TYPE_OPTIONS} selected={types} onChange={setTypes} />
        {types.length > 0 && (
          <button type="button" className={styles.clearFilters} onClick={() => setTypes([])}>
            <FiX /> Clear filters
          </button>
        )}
      </div>

      {counts.length > 0 && (
        <div className={styles.summary}>
          {counts.map(([type, count]) => {
            const { icon: Icon, tone } = typeStyle(type);
            const active = types.includes(type);
            return (
              <button
                key={type}
                type="button"
                className={clsx(styles.summaryChip, styles[tone], active && styles.summaryChipActive)}
                onClick={() => toggleType(type)}
                aria-pressed={active}
                title={active ? 'Click to remove this filter' : 'Click to show only these'}
              >
                <span className={styles.summaryIcon}>
                  <Icon />
                </span>
                <span className={styles.summaryCount}>{count}</span>
                <span className={styles.summaryLabel}>{typeLabel(type)}</span>
              </button>
            );
          })}
        </div>
      )}

      <SectionCard title={filtered ? `${filtered.length} event${filtered.length === 1 ? '' : 's'}` : 'Events'} icon={FiClock}>
        {isLoading || !filtered ? (
          <div className={styles.skeletons}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={styles.skeletonRow}>
                <Skeleton width={34} height={34} variant="circle" />
                <div className={styles.skeletonText}>
                  <Skeleton height={14} width="45%" />
                  <Skeleton height={12} width="70%" />
                </div>
              </div>
            ))}
          </div>
        ) : days.length === 0 ? (
          <EmptyState
            icon={FiClock}
            title={types.length ? 'No events match these filters' : 'Nothing recorded yet'}
            description={
              types.length
                ? 'Try another event type or a wider date range.'
                : 'Reports, completed tasks and AI summaries appear here as they happen.'
            }
          />
        ) : (
          <div className={styles.days}>
            {days.map(([day, events]) => (
              <section key={day} className={styles.day}>
                <div className={styles.dayHeader}>
                  <span className={styles.dayLabel}>{dayLabel(day)}</span>
                  <span className={styles.dayCount}>{events.length}</span>
                </div>
                <ol className={styles.rail}>
                  <AnimatePresence initial={false}>
                    {events.map((event, i) => {
                      const { icon: Icon, tone } = typeStyle(event.type);
                      return (
                        <motion.li
                          key={event._id}
                          className={styles.event}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -10 }}
                          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1], delay: Math.min(i, 8) * 0.03 }}
                        >
                          <span className={clsx(styles.dot, styles[tone])}>
                            <Icon />
                          </span>
                          <div className={styles.eventCard}>
                            <div className={styles.eventTop}>
                              <span className={styles.eventTitle}>{event.title}</span>
                              <time className={styles.eventTime} dateTime={event.occurredAt} title={formatFullDate(event.occurredAt)}>
                                {dayjs(event.occurredAt).isToday()
                                  ? formatRelativeTime(event.occurredAt)
                                  : dayjs(event.occurredAt).format('h:mm A')}
                              </time>
                            </div>
                            {event.description && <p className={styles.eventDescription}>{event.description}</p>}
                            <span className={clsx(styles.eventType, styles[tone])}>{typeLabel(event.type)}</span>
                          </div>
                        </motion.li>
                      );
                    })}
                  </AnimatePresence>
                </ol>
              </section>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

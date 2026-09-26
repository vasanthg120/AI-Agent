import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiActivity } from 'react-icons/fi';
import type { CallEvent } from '@/services/callCopilotService';
import { ROW_IN } from '../motion';
import styles from './EventsFeed.module.css';

type Tone = 'accent' | 'info' | 'danger' | 'warning' | 'success';

export const EVENT_META: Record<CallEvent['type'], { label: string; tone: Tone }> = {
  intent: { label: 'Intent', tone: 'info' },
  requirement: { label: 'Requirement', tone: 'info' },
  objection: { label: 'Objection', tone: 'danger' },
  pain_point: { label: 'Pain point', tone: 'warning' },
  competitor: { label: 'Competitor', tone: 'warning' },
  budget: { label: 'Budget', tone: 'accent' },
  timeline: { label: 'Timeline', tone: 'accent' },
  buying_signal: { label: 'Buying signal', tone: 'success' },
  commitment: { label: 'Commitment', tone: 'success' },
};

type Filter = CallEvent['type'] | 'all';

// What the customer said that matters, flagged as it's said. Filter chips only
// appear for the kinds that actually came up, so there's never a dead control.
export function EventsFeed({ events }: { events: CallEvent[] }) {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const byType = new Map<CallEvent['type'], number>();
    for (const event of events) byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
    return byType;
  }, [events]);

  // A filter whose signals are all gone (a new call) quietly falls back to "all".
  const active: Filter = filter !== 'all' && !counts.has(filter) ? 'all' : filter;

  const visible = useMemo(
    () =>
      events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => active === 'all' || event.type === active)
        .reverse(),
    [events, active],
  );

  if (events.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyIcon} aria-hidden>
          <FiActivity />
        </span>
        <p>
          <strong>Nothing flagged yet</strong>
          Objections, budget, timeline, competitors and buying signals are picked out here as they&apos;re said.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.chips} role="group" aria-label="Filter signals">
        <button
          type="button"
          className={clsx(styles.chip, active === 'all' && styles.chipActive)}
          aria-pressed={active === 'all'}
          onClick={() => setFilter('all')}
        >
          All <span className={styles.chipCount}>{events.length}</span>
        </button>
        {[...counts.entries()].map(([type, count]) => (
          <button
            key={type}
            type="button"
            className={clsx(styles.chip, styles[EVENT_META[type].tone], active === type && styles.chipActive)}
            aria-pressed={active === type}
            onClick={() => setFilter(type)}
          >
            <span className={styles.chipDot} aria-hidden />
            {EVENT_META[type].label} <span className={styles.chipCount}>{count}</span>
          </button>
        ))}
      </div>

      <ul className={styles.list}>
        <AnimatePresence initial={false} mode="popLayout">
          {visible.map(({ event, index }) => (
            <motion.li
              key={`${index}-${event.type}-${event.text}`}
              layout="position"
              className={clsx(styles.row, styles[EVENT_META[event.type].tone])}
              variants={ROW_IN}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              <span className={styles.rowBadge}>{EVENT_META[event.type].label}</span>
              <span className={styles.rowText}>{event.text}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

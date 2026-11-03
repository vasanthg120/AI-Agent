import type { ReactNode } from 'react';
import { FiClock } from 'react-icons/fi';
import { EmptyState } from '@/components/ui';
import { formatRelativeTime } from '@/utils/date';
import styles from './ActivityTimeline.module.css';

export interface ActivityEvent {
  id: string;
  text: string;
  by?: string;
  at: string;
  icon?: ReactNode;
}

export interface ActivityTimelineProps {
  // Omit entirely (not an empty array) when this record has no activity
  // feed wired up yet — renders the "not connected" state instead of a
  // misleading "nothing happened" empty list.
  events?: ActivityEvent[];
  notConnectedMessage?: string;
  notConnectedAction?: ReactNode;
}

export function ActivityTimeline({ events, notConnectedMessage, notConnectedAction }: ActivityTimelineProps) {
  if (!events) {
    return (
      <EmptyState
        icon={FiClock}
        title="Activity isn't tracked here yet"
        description={notConnectedMessage ?? "This record doesn't have its own activity feed in HaiVE yet."}
        action={notConnectedAction}
      />
    );
  }
  if (events.length === 0) return <p className={styles.muted}>Nothing has happened here yet.</p>;
  return (
    <ol className={styles.timeline}>
      {events.map((event) => (
        <li key={event.id} className={styles.item}>
          <span className={styles.icon}>{event.icon ?? <FiClock aria-hidden />}</span>
          <div className={styles.body}>
            <div className={styles.head}>
              <strong>{event.text}</strong>
              <time dateTime={event.at}>{formatRelativeTime(event.at)}</time>
            </div>
            {event.by && <div className={styles.by}>{event.by}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

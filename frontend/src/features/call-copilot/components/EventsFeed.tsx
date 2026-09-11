import { Badge } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import type { CallEvent } from '@/services/callCopilotService';
import styles from './EventsFeed.module.css';

const EVENT_VARIANT: Record<CallEvent['type'], BadgeVariant> = {
  intent: 'info',
  requirement: 'info',
  objection: 'danger',
  pain_point: 'warning',
  competitor: 'warning',
  budget: 'accent',
  timeline: 'accent',
  buying_signal: 'success',
  commitment: 'success',
};

const EVENT_LABEL: Record<CallEvent['type'], string> = {
  intent: 'Intent',
  requirement: 'Requirement',
  objection: 'Objection',
  pain_point: 'Pain Point',
  competitor: 'Competitor',
  budget: 'Budget',
  timeline: 'Timeline',
  buying_signal: 'Buying Signal',
  commitment: 'Commitment',
};

export function EventsFeed({ events }: { events: CallEvent[] }) {
  if (events.length === 0) {
    return <p className={styles.empty}>Detected signals (objections, budget, competitors, buying signals…) will appear here.</p>;
  }

  return (
    <div className={styles.list}>
      {[...events].reverse().map((event, i) => (
        <div key={i} className={styles.row}>
          <Badge variant={EVENT_VARIANT[event.type]}>{EVENT_LABEL[event.type]}</Badge>
          <span className={styles.text}>{event.text}</span>
        </div>
      ))}
    </div>
  );
}

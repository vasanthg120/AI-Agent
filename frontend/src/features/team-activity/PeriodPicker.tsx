import { useState } from 'react';
import { LayoutGroup, motion } from 'framer-motion';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { FiCalendar } from 'react-icons/fi';
import type { TeamPeriod, TeamPeriodValue } from '@/services/teamActivityService';
import styles from './TeamActivity.module.css';

const PERIODS: { id: TeamPeriod; label: string; short: string }[] = [
  { id: 'today', label: 'Today', short: 'Today' },
  { id: 'yesterday', label: 'Yesterday', short: 'Yest.' },
  { id: 'last7', label: '7 days', short: '7d' },
  { id: 'last30', label: '30 days', short: '30d' },
  { id: 'month', label: 'This month', short: 'Month' },
  { id: 'previous_month', label: 'Last month', short: 'Last mo.' },
  { id: 'custom', label: 'Custom', short: 'Custom' },
];

/** "Today", "Last 7 days", "3 Nov – 9 Nov" — what a period reads as in a sentence. */
export function describePeriod(value: TeamPeriodValue): string {
  switch (value.period) {
    case 'today':
      return 'today';
    case 'yesterday':
      return 'yesterday';
    case 'last7':
      return 'in the last 7 days';
    case 'last30':
      return 'in the last 30 days';
    case 'month':
      return 'this month';
    case 'previous_month':
      return 'last month';
    default: {
      if (!value.from) return 'in the chosen days';
      const from = dayjs(value.from).format('D MMM');
      const to = value.to && value.to !== value.from ? dayjs(value.to).format('D MMM') : null;
      return to ? `from ${from} to ${to}` : `on ${from}`;
    }
  }
}

// Today / Yesterday / 7 days / 30 days / This month / Custom. The server works
// each one out in every business's own timezone ("Today" in Sydney is
// Sydney's today), so only the choice is sent — never a computed date.
export function PeriodPicker({ value, onChange, id = 'period' }: { value: TeamPeriodValue; onChange: (value: TeamPeriodValue) => void; id?: string }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: value.from ?? dayjs().subtract(6, 'day').format('YYYY-MM-DD'), to: value.to ?? today });

  return (
    <div className={styles.periodPicker}>
      <LayoutGroup id={id}>
        <div className={styles.segmented} role="radiogroup" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={value.period === p.id}
              className={clsx(styles.segment, value.period === p.id && styles.segmentActive)}
              onClick={() => onChange(p.id === 'custom' ? { period: 'custom', from: draft.from, to: draft.to } : { period: p.id })}
            >
              {value.period === p.id && <motion.span layoutId={`${id}-thumb`} className={styles.segmentThumb} transition={{ type: 'spring', stiffness: 460, damping: 36 }} />}
              <span className={styles.segmentText}>
                <span className={styles.segmentLong}>{p.label}</span>
                <span className={styles.segmentShort}>{p.short}</span>
              </span>
            </button>
          ))}
        </div>
      </LayoutGroup>
      {value.period === 'custom' && (
        <div className={styles.customDates}>
          <FiCalendar aria-hidden />
          <input
            type="date"
            value={draft.from}
            max={draft.to || today}
            aria-label="First day"
            onChange={(e) => {
              const next = { ...draft, from: e.target.value };
              setDraft(next);
              if (next.from) onChange({ period: 'custom', from: next.from, to: next.to || next.from });
            }}
          />
          <span aria-hidden>–</span>
          <input
            type="date"
            value={draft.to}
            min={draft.from}
            max={today}
            aria-label="Last day"
            onChange={(e) => {
              const next = { ...draft, to: e.target.value };
              setDraft(next);
              if (next.from) onChange({ period: 'custom', from: next.from, to: next.to || next.from });
            }}
          />
        </div>
      )}
    </div>
  );
}

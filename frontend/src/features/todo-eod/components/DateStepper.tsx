import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import { Button, IconButton } from '@/components/ui';
import { dayjs, todayUtc } from '@/utils/date';
import styles from './DateStepper.module.css';

function relativeDay(date: string): string {
  const diff = dayjs(date).diff(dayjs(todayUtc()), 'day');
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  return diff < 0 ? `${-diff} days ago` : `In ${diff} days`;
}

// Day-by-day navigator shared by To-Do and EOD Report: the label slides in
// the direction you stepped, reads "Today / Yesterday / 3 days ago" above
// the full date, and offers a one-click way back to today. "Today" is the
// backend's UTC day (see todayUtc()), not the browser's local date.
export function DateStepper({ date, onChange }: { date: string; onChange: (date: string) => void }) {
  const [direction, setDirection] = useState(0);
  const today = todayUtc();

  const go = (next: string) => {
    setDirection(dayjs(next).isAfter(date) ? 1 : -1);
    onChange(next);
  };

  return (
    <div className={styles.stepper}>
      <IconButton icon={<FiChevronLeft />} label="Previous day" onClick={() => go(dayjs(date).subtract(1, 'day').format('YYYY-MM-DD'))} />
      <div className={styles.window}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={date}
            className={styles.stack}
            initial={{ opacity: 0, x: direction * 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction * -24 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className={styles.relative}>{relativeDay(date)}</span>
            <span className={styles.label}>{dayjs(date).format('dddd, MMM D, YYYY')}</span>
          </motion.div>
        </AnimatePresence>
      </div>
      <IconButton icon={<FiChevronRight />} label="Next day" onClick={() => go(dayjs(date).add(1, 'day').format('YYYY-MM-DD'))} />
      {date !== today && (
        <Button type="button" variant="outline" size="sm" onClick={() => go(today)}>
          Jump to today
        </Button>
      )}
    </div>
  );
}

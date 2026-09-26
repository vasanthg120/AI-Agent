import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { SPRING_SNAPPY } from '../motion';
import styles from './PillTabs.module.css';

export interface PillTabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  // A pulsing red dot — "something is happening in here" (a call in progress).
  live?: boolean;
  // A soft orange pulse — "still being worked on" (a report on its way).
  busy?: boolean;
}

export interface PillTabsProps {
  items: PillTabItem[];
  activeId: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  size?: 'md' | 'sm';
}

// A segmented control whose highlight glides between options. Its own
// layoutId (per instance) so two of these on screen — the page's tabs and the
// debrief dialog's — never animate into each other.
export function PillTabs({ items, activeId, onChange, ariaLabel, size = 'md' }: PillTabsProps) {
  const groupId = useId();
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (index: number) => {
    const next = items[(index + items.length) % items.length];
    onChange(next.id);
    buttons.current[next.id]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      select(index + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      select(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      select(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      select(items.length - 1);
    }
  };

  return (
    <div role="tablist" aria-label={ariaLabel} className={clsx(styles.list, size === 'sm' && styles.small)}>
      {items.map((item, index) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            ref={(node) => {
              buttons.current[item.id] = node;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={clsx(styles.tab, active && styles.tabActive)}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {active && <motion.span layoutId={`${groupId}-pill`} className={styles.pill} transition={SPRING_SNAPPY} />}
            <span className={styles.label}>
              {item.icon}
              {item.label}
              {item.live && <span className={styles.liveDot} aria-label="Call in progress" />}
              {item.busy && <span className={styles.busyDot} aria-label="Still working" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

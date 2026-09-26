import { useId } from 'react';
import type { ReactNode } from 'react';
import type { IconType } from 'react-icons';
import { LayoutGroup, motion } from 'framer-motion';
import clsx from 'clsx';
import { AnimatedNumber } from './AnimatedNumber';
import styles from './ChoiceCards.module.css';

export interface ChoiceCardItem<T extends string> {
  id: T;
  label: string;
  /** One line explaining what picking this card shows. */
  description?: ReactNode;
  icon: IconType;
  /** Optional big number on the card (e.g. how many items are in this queue). */
  count?: number;
  tone?: 'accent' | 'success' | 'warning' | 'danger' | 'neutral';
}

// A row of large, self-explaining option cards — used where a plain tab
// label isn't enough to tell someone which option answers their question
// (report types, inbox queues). The selection highlight glides between cards.
export function ChoiceCards<T extends string>({
  items,
  activeId,
  onChange,
  ariaLabel,
}: {
  items: ChoiceCardItem<T>[];
  activeId: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}) {
  const groupId = useId();
  return (
    <LayoutGroup id={groupId}>
      <div className={styles.cards} role="tablist" aria-label={ariaLabel}>
        {items.map(({ id, label, description, icon: Icon, count, tone = 'accent' }) => {
          const active = id === activeId;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              className={clsx(styles.card, styles[`tone_${tone}`], active && styles.cardActive)}
              onClick={() => onChange(id)}
            >
              {active && (
                <motion.span
                  layoutId="choice-card-active"
                  className={styles.highlight}
                  transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                />
              )}
              <span className={styles.icon}>
                <Icon />
              </span>
              <span className={styles.text}>
                <span className={styles.labelRow}>
                  <span className={styles.label}>{label}</span>
                  {count !== undefined && (
                    <span className={styles.count}>
                      <AnimatedNumber value={count} />
                    </span>
                  )}
                </span>
                {description && <span className={styles.description}>{description}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

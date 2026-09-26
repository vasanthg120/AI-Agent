import { useId } from 'react';
import type { ReactNode } from 'react';
import { LayoutGroup, motion } from 'framer-motion';
import clsx from 'clsx';
import styles from './Tabs.module.css';

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  orientation?: 'horizontal' | 'vertical';
}

const INDICATOR_SPRING = { type: 'spring', stiffness: 460, damping: 38, mass: 0.7 } as const;

export function Tabs({ items, activeId, onChange, orientation = 'horizontal' }: TabsProps) {
  // Scopes the sliding indicator to this one tab list — a bare shared
  // layoutId made the underline fly between two unrelated Tabs whenever a
  // page rendered more than one.
  const groupId = useId();

  return (
    <LayoutGroup id={groupId}>
      <div className={clsx(styles.list, orientation === 'vertical' && styles.vertical)} role="tablist">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={clsx(styles.tab, active && styles.tabActive)}
              onClick={() => onChange(item.id)}
            >
              {item.icon && <span className={styles.icon}>{item.icon}</span>}
              <span className={styles.label}>{item.label}</span>
              {active && <motion.span layoutId="tab-indicator" className={styles.indicator} transition={INDICATOR_SPRING} />}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

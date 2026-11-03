import type { ReactNode } from 'react';
import { Tabs } from '@/components/ui';
import type { TabItem } from '@/components/ui';
import styles from './DetailTabs.module.css';

export interface DetailTabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  children: ReactNode;
}

// Thin wrapper around the existing Tabs primitive for a record detail panel
// (Quote detail, Job detail, ...) — just adds the content frame below the
// tab strip so every detail panel doesn't re-lay this out by hand.
export function DetailTabs({ items, activeId, onChange, children }: DetailTabsProps) {
  return (
    <div className={styles.wrap}>
      <Tabs items={items} activeId={activeId} onChange={onChange} />
      <div className={styles.content}>{children}</div>
    </div>
  );
}

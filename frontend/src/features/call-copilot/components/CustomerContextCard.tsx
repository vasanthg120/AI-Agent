import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FiChevronDown, FiUser } from 'react-icons/fi';
import { ROW_IN, SPRING_SOFT } from '../motion';
import styles from './CustomerContextCard.module.css';

const COLLAPSED_ITEMS = 3;

interface ContextItem {
  index: string;
  source: string;
  text: string;
}

// contextBlob is the pre-formatted text business_search_tool.run() already
// produces — numbered "[n] (source_type) ..." lines merging CRM + documents +
// business knowledge + Mem0 memory. Split back into one row per source so it
// reads as a list of facts; anything that doesn't follow that shape is shown
// exactly as it arrived.
function parseContext(blob: string): ContextItem[] | null {
  const items: ContextItem[] = [];
  for (const raw of blob.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^\[(\d+)\]\s*(?:\(([^)]+)\)\s*)?(.*)$/.exec(line);
    if (match) {
      items.push({ index: match[1], source: match[2] ?? 'context', text: match[3] });
    } else if (items.length > 0) {
      items[items.length - 1].text += `\n${line}`;
    } else {
      return null;
    }
  }
  return items.length > 0 ? items : null;
}

function sourceLabel(source: string): string {
  const words = source.replace(/_/g, ' ').trim();
  if (words.length <= 3) return words.toUpperCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function CustomerContextCard({ contextBlob }: { contextBlob: string }) {
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => parseContext(contextBlob), [contextBlob]);

  if (!contextBlob) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyIcon} aria-hidden>
          <FiUser />
        </span>
        <p>
          <strong>No customer linked</strong>
          Link a deal before you start and its CRM notes and documents show up here. Without one, suggestions use general
          business knowledge only.
        </p>
      </div>
    );
  }

  if (!items) {
    return (
      <div className={styles.rawWrap}>
        <div className={expanded ? styles.raw : `${styles.raw} ${styles.rawClamped}`}>{contextBlob}</div>
        <button type="button" className={styles.toggle} aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {expanded ? 'Show less' : 'Show more'}
          <FiChevronDown className={expanded ? styles.chevronOpen : styles.chevron} aria-hidden />
        </button>
      </div>
    );
  }

  const hidden = items.length - COLLAPSED_ITEMS;

  return (
    <div className={styles.wrapper}>
      <ul className={styles.list}>
        {items.slice(0, COLLAPSED_ITEMS).map((item) => (
          <ContextRow key={item.index} item={item} />
        ))}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.li
              className={styles.more}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={SPRING_SOFT}
            >
              <ul className={styles.list}>
                {items.slice(COLLAPSED_ITEMS).map((item) => (
                  <ContextRow key={item.index} item={item} />
                ))}
              </ul>
            </motion.li>
          )}
        </AnimatePresence>
      </ul>
      {hidden > 0 && (
        <button type="button" className={styles.toggle} aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {expanded ? 'Show less' : `Show ${hidden} more`}
          <FiChevronDown className={expanded ? styles.chevronOpen : styles.chevron} aria-hidden />
        </button>
      )}
    </div>
  );
}

function ContextRow({ item }: { item: ContextItem }) {
  return (
    <motion.li className={styles.row} variants={ROW_IN} initial="hidden" animate="show">
      <span className={styles.source}>{sourceLabel(item.source)}</span>
      <span className={styles.text}>{item.text}</span>
    </motion.li>
  );
}

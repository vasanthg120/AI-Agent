import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiChevronDown } from 'react-icons/fi';
import { useClickOutside } from '@/hooks/useClickOutside';
import { POPUP_SPRING } from './motionPresets';
import styles from './MultiSelectDropdown.module.css';

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface MultiSelectDropdownProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (values: string[]) => void;
}

// No multi-select checklist variant existed anywhere in this app before
// Phase 9a — extends Dropdown.tsx's click-outside + framer-motion open/close
// conventions rather than inventing a new interaction pattern. Promoted from
// features/deal-performance to components/ui in Phase 10a once Finance
// became its second consumer.
export function MultiSelectDropdown({ label, options, selected, onChange }: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useClickOutside(wrapperRef, () => setOpen(false), open);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const triggerLabel = selected.length === 0 ? label : `${label} (${selected.length})`;

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        className={clsx(styles.trigger, selected.length > 0 && styles.triggerActive)}
        onClick={() => setOpen((prev) => !prev)}
      >
        {triggerLabel}
        <FiChevronDown size={14} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.menu}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={POPUP_SPRING}
          >
            {options.map((opt) => (
              <label key={opt.value} className={styles.option}>
                <input type="checkbox" checked={selected.includes(opt.value)} onChange={() => toggle(opt.value)} />
                {opt.label}
              </label>
            ))}
            {selected.length > 0 && (
              <div className={styles.footer}>
                <button type="button" className={styles.clearButton} onClick={() => onChange([])}>
                  Clear
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

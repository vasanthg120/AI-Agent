import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiCheck, FiChevronDown, FiSearch } from 'react-icons/fi';
import { useFloatingMenu } from './useFloatingMenu';
import menuStyles from './FloatingMenu.module.css';
import styles from './MultiSelectDropdown.module.css';

export interface MultiSelectOption {
  value: string;
  label: string;
  hint?: string;
}

export interface MultiSelectDropdownProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** How many options before a search box appears. */
  searchFrom?: number;
  /** Show who is chosen on the button ("Asha, Ravi", "Asha +2") instead of "Label (3)". */
  showNames?: boolean;
  className?: string;
}

// A checklist picker. The menu floats above the page (useFloatingMenu): placed
// inside a collapsing list or a scrolling table it used to be cut off — the
// Deal Assignment "Choose users" menus could not be used. Long lists get a
// search box; the chosen names show on the button.
export function MultiSelectDropdown({ label, options, selected, onChange, searchFrom = 8, showNames, className }: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const position = useFloatingMenu(open, anchorRef, menuRef, close, 240);
  const searchable = options.length >= searchFrom;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const names = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
  const triggerLabel =
    selected.length === 0
      ? label
      : showNames && names.length > 0
        ? names.length <= 2
          ? names.join(', ')
          : `${names[0]} +${names.length - 1}`
        : `${label} (${selected.length})`;

  return (
    <div className={clsx(styles.wrapper, className)}>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, selected.length > 0 && styles.triggerActive, open && styles.triggerOpen)}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={styles.triggerLabel}>{triggerLabel}</span>
        <FiChevronDown size={14} className={clsx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && position && (
            <motion.div
              ref={menuRef}
              className={menuStyles.menu}
              style={{ top: position.top, bottom: position.bottom, left: position.left, width: position.width, maxHeight: position.maxHeight }}
              initial={{ opacity: 0, y: position.top !== undefined ? -4 : 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              {searchable && (
                <label className={menuStyles.search}>
                  <FiSearch aria-hidden />
                  <input ref={searchRef} value={query} placeholder="Search…" aria-label={`Search ${label.toLowerCase()}`} onChange={(e) => setQuery(e.target.value)} />
                </label>
              )}
              <div className={menuStyles.list} role="listbox" aria-multiselectable="true" aria-label={label}>
                {visible.length === 0 ? (
                  <div className={menuStyles.nothing}>Nothing matches “{query.trim()}”</div>
                ) : (
                  visible.map((opt) => {
                    const on = selected.includes(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="option"
                        aria-selected={on}
                        className={clsx(menuStyles.option, on && menuStyles.optionSelected)}
                        onClick={() => toggle(opt.value)}
                      >
                        <span className={clsx(menuStyles.checkbox, on && menuStyles.checkboxOn)} aria-hidden>
                          {on && <FiCheck />}
                        </span>
                        <span className={menuStyles.optionText}>
                          <span className={menuStyles.optionLabel}>{opt.label}</span>
                          {opt.hint && <span className={menuStyles.optionHint}>{opt.hint}</span>}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
              <div className={menuStyles.footer}>
                <span>{selected.length === 0 ? 'None chosen' : `${selected.length} chosen`}</span>
                {selected.length > 0 ? (
                  <button type="button" className={menuStyles.footerButton} onClick={() => onChange([])}>
                    Clear
                  </button>
                ) : (
                  <button type="button" className={menuStyles.footerButton} onClick={() => setOpen(false)}>
                    Done
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

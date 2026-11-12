import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiCheck, FiChevronDown, FiSearch } from 'react-icons/fi';
import { Avatar } from './Avatar';
import { useFloatingMenu } from './useFloatingMenu';
import menuStyles from './FloatingMenu.module.css';
import styles from './SelectMenu.module.css';

export interface SelectMenuOption {
  value: string;
  label: string;
  /** A second, quieter line (an email, a business, a count). */
  hint?: string;
}

export interface SelectMenuProps {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  /** Shown when nothing is chosen. */
  placeholder?: string;
  /** Offer "no value" as the first option, with this label (e.g. "Unassigned"). */
  emptyOption?: string;
  ariaLabel: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** People pickers: an avatar on the button and on every option. */
  avatars?: boolean;
  /** Something before the label on the button (an icon). */
  icon?: ReactNode;
  className?: string;
  /** How many options before a search box appears. */
  searchFrom?: number;
}

// A single-choice picker in the app's own style — for places that used the
// browser's plain <select> (Deal Assignment's owner and "Assign to…"), which
// looked out of place, couldn't be searched, and couldn't show who someone is.
// Type to filter, arrow keys and Enter to choose, Escape to close.
export function SelectMenu({
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  emptyOption,
  ariaLabel,
  disabled,
  size = 'md',
  avatars,
  icon,
  className,
  searchFrom = 7,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);
  const position = useFloatingMenu(open, anchorRef, menuRef, close, 240);

  const choices = useMemo(() => {
    const all: SelectMenuOption[] = emptyOption !== undefined ? [{ value: '', label: emptyOption }, ...options] : options;
    const q = query.trim().toLowerCase();
    return q ? all.filter((o) => o.value === '' || o.label.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q)) : all;
  }, [options, emptyOption, query]);

  const selected = options.find((o) => o.value === value);
  const searchable = options.length >= searchFrom;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(Math.max(0, (emptyOption !== undefined ? [{ value: '' }, ...options] : options).findIndex((o) => o.value === value)));
    // Focus the search (or the list) once the menu is placed.
    const timer = window.setTimeout(() => (searchable ? searchRef.current?.focus() : menuRef.current?.focus()), 0);
    return () => window.clearTimeout(timer);
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (next: string) => {
    setOpen(false);
    anchorRef.current?.focus();
    if (next !== value) onChange(next);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(choices.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = choices[active];
      if (choice) choose(choice.value);
    }
  };

  // Keep the highlighted option in view while moving with the arrow keys.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, styles[size], !selected && styles.triggerEmpty, open && styles.triggerOpen, className)}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
      >
        {icon}
        {avatars && selected && <Avatar name={selected.label} size="sm" />}
        <span className={styles.triggerLabel}>{selected?.label ?? (value === '' && emptyOption !== undefined ? emptyOption : placeholder)}</span>
        <FiChevronDown className={clsx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && position && (
            <motion.div
              ref={menuRef}
              tabIndex={-1}
              className={menuStyles.menu}
              style={{ top: position.top, bottom: position.bottom, left: position.left, width: position.width, maxHeight: position.maxHeight }}
              initial={{ opacity: 0, y: position.top !== undefined ? -4 : 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              onKeyDown={onKeyDown}
            >
              {searchable && (
                <label className={menuStyles.search}>
                  <FiSearch aria-hidden />
                  <input
                    ref={searchRef}
                    value={query}
                    placeholder="Search…"
                    aria-label={`Search ${ariaLabel.toLowerCase()}`}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActive(0);
                    }}
                  />
                </label>
              )}
              <div className={menuStyles.list} role="listbox" id={listId} aria-label={ariaLabel}>
                {choices.length === 0 ? (
                  <div className={menuStyles.nothing}>Nobody matches “{query.trim()}”</div>
                ) : (
                  choices.map((option, index) => {
                    const isSelected = option.value === value;
                    return (
                      <button
                        key={option.value || '__empty'}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        data-index={index}
                        className={clsx(
                          menuStyles.option,
                          index === active && menuStyles.optionActive,
                          isSelected && menuStyles.optionSelected,
                          option.value === '' && menuStyles.emptyOption,
                        )}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => choose(option.value)}
                      >
                        {avatars && option.value !== '' && <Avatar name={option.label} size="sm" />}
                        <span className={menuStyles.optionText}>
                          <span className={menuStyles.optionLabel}>{option.label}</span>
                          {option.hint && <span className={menuStyles.optionHint}>{option.hint}</span>}
                        </span>
                        {isSelected && <FiCheck className={menuStyles.check} aria-hidden />}
                      </button>
                    );
                  })
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

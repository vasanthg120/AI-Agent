import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiBriefcase, FiSearch } from 'react-icons/fi';
import { Input, Spinner } from '@/components/ui';
import { POPUP_SPRING } from '@/components/ui/motionPresets';
import { dealsService, type Deal } from '@/services/dealsService';
import styles from './CustomerPicker.module.css';

export interface SelectedCustomer {
  dealId: string;
  label: string;
}

export interface CustomerPickerProps {
  value: SelectedCustomer | null;
  onChange: (value: SelectedCustomer | null) => void;
  disabled?: boolean;
}

const SEARCH_DEBOUNCE_MS = 250;

// Optional linkage (confirmed: recommended, not required) — searches
// existing deals by name, reusing dealsService.listFiltered exactly as
// TeamPerformanceSummaryCards/AnalyticsDashboardPage already do for their
// own deal drill-downs, rather than adding a new search endpoint.
export function CustomerPicker({ value, onChange, disabled }: CustomerPickerProps) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Deal[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Answers can come back out of order; only the newest request may update the list.
  const latestRequest = useRef(0);

  useEffect(() => {
    const text = query.trim();
    const request = ++latestRequest.current;
    if (!text) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const { items } = await dealsService.listFiltered({ search: text }, 1, 8);
        if (request !== latestRequest.current) return;
        setResults(items);
        setHighlight(0);
      } catch {
        if (request === latestRequest.current) setResults([]);
      } finally {
        if (request === latestRequest.current) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const select = (deal: Deal) => {
    onChange({ dealId: deal._id, label: deal.name });
    setOpen(false);
    setQuery('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setOpen(true);
      setHighlight((h) => (h + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      setHighlight((h) => (h - 1 + results.length) % results.length);
    } else if (event.key === 'Enter' && open && results[highlight]) {
      event.preventDefault();
      select(results[highlight]);
    }
  };

  if (value) {
    return (
      <motion.div
        className={styles.selected}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={POPUP_SPRING}
      >
        <span className={styles.selectedIcon} aria-hidden>
          <FiBriefcase />
        </span>
        <span className={styles.selectedText}>
          <span className={styles.eyebrow}>Linked deal</span>
          <span className={styles.selectedName}>{value.label}</span>
        </span>
        {!disabled && (
          <button type="button" className={styles.clearBtn} onClick={() => onChange(null)}>
            Change
          </button>
        )}
      </motion.div>
    );
  }

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <Input
        placeholder="Link a deal — search by name (optional)"
        value={query}
        disabled={disabled}
        leftIcon={<FiSearch />}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => query.trim() && setOpen(true)}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
      />
      <AnimatePresence>
        {open && (
          <motion.div
            id={listId}
            role="listbox"
            className={styles.dropdown}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={POPUP_SPRING}
          >
            {loading && (
              <div className={styles.rowMuted}>
                <Spinner size={14} /> Searching…
              </div>
            )}
            {!loading && results.length === 0 && <div className={styles.rowMuted}>No deals match &ldquo;{query.trim()}&rdquo;.</div>}
            {!loading &&
              results.map((deal, index) => (
                <button
                  key={deal._id}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  className={clsx(styles.row, index === highlight && styles.rowActive)}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => select(deal)}
                >
                  {deal.name}
                </button>
              ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

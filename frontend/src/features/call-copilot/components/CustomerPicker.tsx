import { useState } from 'react';
import { Input } from '@/components/ui';
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

// Optional linkage (confirmed: recommended, not required) — searches
// existing deals by name, reusing dealsService.listFiltered exactly as
// TeamPerformanceSummaryCards/AnalyticsDashboardPage already do for their
// own deal drill-downs, rather than adding a new search endpoint.
export function CustomerPicker({ value, onChange, disabled }: CustomerPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Deal[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const search = async (text: string) => {
    setQuery(text);
    if (!text.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const { items } = await dealsService.listFiltered({ search: text }, 1, 8);
      setResults(items);
      setOpen(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const select = (deal: Deal) => {
    onChange({ dealId: deal._id, label: deal.name });
    setOpen(false);
    setQuery('');
  };

  if (value) {
    return (
      <div className={styles.selected}>
        <span>Linked to: {value.label}</span>
        {!disabled && (
          <button type="button" className={styles.clearBtn} onClick={() => onChange(null)}>
            Change
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <Input
        placeholder="Search a deal to link this call to (optional)"
        value={query}
        disabled={disabled}
        onChange={(e) => void search(e.target.value)}
      />
      {open && (
        <div className={styles.dropdown}>
          {loading && <div className={styles.rowMuted}>Searching…</div>}
          {!loading && results.length === 0 && <div className={styles.rowMuted}>No matching deals.</div>}
          {!loading &&
            results.map((deal) => (
              <button key={deal._id} type="button" className={styles.row} onClick={() => select(deal)}>
                {deal.name}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

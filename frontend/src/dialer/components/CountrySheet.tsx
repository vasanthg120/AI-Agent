import { useMemo, useState } from 'react';
import { Flag } from '@/features/calling/Flag';
import { COUNTRIES, type Country } from '@/services/callingService';
import { FiCheck, FiSearch } from './icons';
import { Sheet } from './Sheet';
import styles from './CountrySheet.module.css';

/** The country a number typed without "+" belongs to. */
export function CountrySheet({
  open,
  onClose,
  selected,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  selected: Country;
  onSelect: (country: Country) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\+/, '');
    if (!q) return COUNTRIES;
    return COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) || c.dialCode.startsWith(q) || c.iso.toLowerCase() === q);
  }, [query]);

  return (
    <Sheet open={open} onClose={onClose} title="Country">
      <label className={styles.search}>
        <FiSearch />
        <span className="sr-only">Search countries</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Country or code" autoComplete="off" />
      </label>
      <ul className={styles.list}>
        {shown.map((country) => (
          <li key={country.iso}>
            <button
              type="button"
              className={styles.row}
              aria-current={country.iso === selected.iso || undefined}
              onClick={() => {
                onSelect(country);
                setQuery('');
                onClose();
              }}
            >
              <Flag iso={country.iso} size="md" />
              <span className={styles.name}>{country.name}</span>
              <span className={styles.code}>+{country.dialCode}</span>
              {country.iso === selected.iso && <FiCheck className={styles.check} />}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className={styles.empty}>No country matches “{query}”. Type the number with + and its code instead.</li>}
      </ul>
    </Sheet>
  );
}

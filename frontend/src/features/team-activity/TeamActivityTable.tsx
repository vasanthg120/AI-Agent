import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { FiArrowDown, FiArrowUp, FiChevronRight, FiSearch } from 'react-icons/fi';
import { Avatar, EmptyState } from '@/components/ui';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { TeamActivityPerson } from '@/services/teamActivityService';
import { COLUMN_SETS, METRIC_BY_KEY, type MetricKey } from './metrics';
import styles from './TeamActivity.module.css';

type SortKey = MetricKey | 'name';
type ColumnSet = (typeof COLUMN_SETS)[number]['id'];

// Everyone the caller may see, one row each — a short overview, or every
// figure of one kind (deals, email, calls, follow-ups) — sorted by whatever is
// clicked. A row opens that person's page. On a phone the rows become cards.
export function TeamActivityTable({
  people,
  onSelect,
  showBusiness,
  limit,
  searchable = true,
  columnSwitch = true,
}: {
  people: TeamActivityPerson[];
  onSelect: (person: TeamActivityPerson) => void;
  showBusiness: boolean;
  limit?: number;
  searchable?: boolean;
  columnSwitch?: boolean;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'calls', desc: true });
  const [query, setQuery] = useState('');
  const [set, setSet] = useState<ColumnSet>('overview');
  const narrow = useMediaQuery('(max-width: 760px)');
  const columns = (COLUMN_SETS.find((c) => c.id === set) ?? COLUMN_SETS[0]).keys.map((k) => METRIC_BY_KEY[k]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? people.filter((p) => [p.name, p.email, p.businessName, p.role].some((f) => f?.toLowerCase().includes(q))) : people;
    const sorted = [...filtered].sort((a, b) => {
      if (sort.key === 'name') return sort.desc ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name);
      const metric = METRIC_BY_KEY[sort.key];
      const diff = metric.sortValue(b) - metric.sortValue(a);
      return (sort.desc ? diff : -diff) || a.name.localeCompare(b.name);
    });
    return limit ? sorted.slice(0, limit) : sorted;
  }, [people, query, sort, limit]);

  const toggleSort = (key: SortKey) => setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: key !== 'name' }));

  if (people.length === 0) {
    return <EmptyState compact title="Nobody to show yet" description="People appear here once they have a login in this business." />;
  }

  return (
    <div className={styles.tableBlock}>
      {(columnSwitch || (searchable && people.length > 6)) && (
        <div className={styles.tableBar}>
          {columnSwitch && (
            <div className={styles.subTabs} role="tablist" aria-label="Which figures">
              {COLUMN_SETS.map((c) => (
                <button key={c.id} type="button" role="tab" aria-selected={set === c.id} className={clsx(styles.subTab, set === c.id && styles.subTabActive)} onClick={() => setSet(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {searchable && people.length > 6 && (
            <label className={styles.tableSearch}>
              <FiSearch aria-hidden />
              <input value={query} placeholder="Search people" onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState compact icon={FiSearch} title="Nobody matches that search" />
      ) : narrow ? (
        <ul className={styles.personCards}>
          {rows.map((p) => (
            <li key={`${p.businessId}-${p.userId}`}>
              <button type="button" className={styles.personCard} onClick={() => onSelect(p)}>
                <span className={styles.personCell}>
                  <Avatar name={p.name} size="sm" />
                  <span className={styles.personText}>
                    <span className={styles.personName}>{p.name}</span>
                    <span className={styles.personSub}>{[p.role, showBusiness ? p.businessName : undefined].filter(Boolean).join(' · ')}</span>
                  </span>
                  <FiChevronRight className={styles.rowChevron} aria-hidden />
                </span>
                <span className={styles.personFigures}>
                  {columns.map((m) => (
                    <span key={m.key} className={clsx(styles.personFigure, m.alert && m.sortValue(p) > 0 && styles[`cell_${m.alert}`])}>
                      <span className={styles.personFigureLabel}>{m.column}</span>
                      <strong>{m.value(p, p.currency)}</strong>
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <SortHeader label="Person" sortKey="name" sort={sort} onSort={toggleSort} align="left" />
                {columns.map((m) => (
                  <SortHeader key={m.key} label={m.column} title={m.meaning} sortKey={m.key} sort={sort} onSort={toggleSort} />
                ))}
                <th aria-hidden className={styles.chevronCol} />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={`${p.businessId}-${p.userId}`}
                  className={clsx(styles.row, !p.active && styles.rowInactive)}
                  onClick={() => onSelect(p)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(p);
                    }
                  }}
                  aria-label={`Open ${p.name}`}
                >
                  <td>
                    <span className={styles.personCell}>
                      <Avatar name={p.name} size="sm" />
                      <span className={styles.personText}>
                        <span className={styles.personName}>{p.name}</span>
                        <span className={styles.personSub}>
                          {[p.role, showBusiness ? p.businessName : undefined, !p.active ? 'Deactivated' : undefined].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </span>
                  </td>
                  {columns.map((m) => {
                    const raw = m.sortValue(p);
                    return (
                      <td key={m.key} className={clsx(styles.num, raw <= 0 && styles.zero, m.alert && raw > 0 && styles[`cell_${m.alert}`])}>
                        {m.value(p, p.currency)}
                      </td>
                    );
                  })}
                  <td className={styles.chevronCol}>
                    <FiChevronRight className={styles.rowChevron} aria-hidden />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SortHeader({
  label,
  title,
  sortKey,
  sort,
  onSort,
  align = 'right',
}: {
  label: string;
  title?: string;
  sortKey: SortKey;
  sort: { key: SortKey; desc: boolean };
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  return (
    <th className={clsx(align === 'right' && styles.num)} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className={clsx(styles.sortButton, active && styles.sortButtonActive)} onClick={() => onSort(sortKey)} title={title}>
        {label}
        {active && (sort.desc ? <FiArrowDown aria-hidden /> : <FiArrowUp aria-hidden />)}
      </button>
    </th>
  );
}

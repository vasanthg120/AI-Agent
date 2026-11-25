import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { FiArrowDown, FiArrowUp, FiChevronRight, FiSearch } from 'react-icons/fi';
import { Avatar, EmptyState, SelectMenu } from '@/components/ui';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { TeamActivityPerson } from '@/services/teamActivityService';
import { COLUMN_SETS, METRIC_BY_KEY, type MetricKey } from './metrics';
import { StatusLabel } from './EmployeeParts';
import { activityStatus } from './status';
import styles from './TeamActivity.module.css';
import eaStyles from './EmployeeActivity.module.css';

type SortKey = MetricKey | 'name';
export type ColumnSet = (typeof COLUMN_SETS)[number]['id'];
type StatusFilter = 'all' | 'now' | 'active' | 'quiet';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'now', label: 'Active now' },
  { value: 'active', label: 'Active in this period' },
  { value: 'quiet', label: 'Nothing in this period' },
];

/** Did anything in the period: time measured, a call, an email, a deal, a finished task. */
function didSomething(p: TeamActivityPerson): boolean {
  return p.activeSeconds + p.calls + p.emailsSent + p.emailsReplied + p.dealsCreated + p.dealsWon + p.dealsLost + p.followUpsCompleted > 0;
}

// Everyone the caller may see, one row each — a short overview, or every figure
// of one kind (deals, email, calls, tasks, time) — searchable, filtered by status,
// role and team, sorted by whatever is clicked. A row opens that person's page;
// each shows whether they are active now. On a phone the rows become cards.
export function TeamActivityTable({
  people,
  onSelect,
  showBusiness,
  limit,
  searchable = true,
  columnSwitch = true,
  initialSet = 'overview',
  filters = false,
}: {
  people: TeamActivityPerson[];
  onSelect: (person: TeamActivityPerson) => void;
  showBusiness: boolean;
  limit?: number;
  searchable?: boolean;
  columnSwitch?: boolean;
  initialSet?: ColumnSet;
  /** Status, role and team filters above the table. */
  filters?: boolean;
}) {
  const startSort: SortKey = (COLUMN_SETS.find((c) => c.id === initialSet) ?? COLUMN_SETS[0]).keys[0];
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: startSort, desc: true });
  const [query, setQuery] = useState('');
  const [set, setSet] = useState<ColumnSet>(initialSet);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [role, setRole] = useState('');
  const [team, setTeam] = useState('');
  // Cards below a laptop's width: nine figures don't fit a tablet's row.
  const narrow = useMediaQuery('(max-width: 900px)');
  const columns = (COLUMN_SETS.find((c) => c.id === set) ?? COLUMN_SETS[0]).keys.map((k) => METRIC_BY_KEY[k]);
  const roles = useMemo(() => [...new Set(people.map((p) => p.role))].sort(), [people]);
  const teams = useMemo(() => [...new Set(people.map((p) => p.department).filter((d): d is string => !!d))].sort(), [people]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = people.filter((p) => {
      if (q && ![p.name, p.email, p.businessName, p.role, p.department].some((f) => f?.toLowerCase().includes(q))) return false;
      if (role && p.role !== role) return false;
      if (team && p.department !== team) return false;
      if (status === 'now' && activityStatus(p.lastActiveAt).tone !== 'now') return false;
      if (status === 'active' && !didSomething(p)) return false;
      if (status === 'quiet' && didSomething(p)) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      if (sort.key === 'name') return sort.desc ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name);
      const metric = METRIC_BY_KEY[sort.key];
      const diff = metric.sortValue(b) - metric.sortValue(a);
      return (sort.desc ? diff : -diff) || a.name.localeCompare(b.name);
    });
    return limit ? sorted.slice(0, limit) : sorted;
  }, [people, query, sort, limit, role, team, status]);

  const toggleSort = (key: SortKey) => setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: key !== 'name' }));

  if (people.length === 0) {
    return <EmptyState compact title="Nobody to show yet" description="Employees appear here once they have a login in this business." />;
  }

  const sub = (p: TeamActivityPerson) => [p.role, showBusiness ? p.businessName : undefined, p.department, !p.active ? 'Deactivated' : undefined].filter(Boolean).join(' · ');

  return (
    <div className={styles.tableBlock}>
      {(columnSwitch || filters || (searchable && people.length > 6)) && (
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
          <div className={eaStyles.filtersRow}>
            {filters && (
              <>
                <SelectMenu value={status} options={STATUS_OPTIONS} onChange={(v) => setStatus(v as StatusFilter)} ariaLabel="Status" size="sm" className={eaStyles.filterSelect} />
                {roles.length > 1 && (
                  <SelectMenu value={role} options={roles.map((r) => ({ value: r, label: r }))} emptyOption="Every role" onChange={setRole} ariaLabel="Role" size="sm" className={eaStyles.filterSelect} />
                )}
                {teams.length > 0 && (
                  <SelectMenu value={team} options={teams.map((t) => ({ value: t, label: t }))} emptyOption="Every team" onChange={setTeam} ariaLabel="Team" size="sm" className={eaStyles.filterSelect} />
                )}
              </>
            )}
            {searchable && (filters || people.length > 6) && (
              <label className={styles.tableSearch}>
                <FiSearch aria-hidden />
                <input value={query} placeholder="Search employees" aria-label="Search employees" onChange={(e) => setQuery(e.target.value)} />
              </label>
            )}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState compact icon={FiSearch} title="Nobody matches" description="Try another search or filter." />
      ) : narrow ? (
        <ul className={styles.personCards}>
          {rows.map((p) => (
            <li key={`${p.businessId}-${p.userId}`}>
              <button type="button" className={styles.personCard} onClick={() => onSelect(p)}>
                <span className={styles.personCell}>
                  <Avatar name={p.name} size="sm" status={activityStatus(p.lastActiveAt).tone === 'now' ? 'online' : undefined} />
                  <span className={styles.personText}>
                    <span className={styles.personName}>{p.name}</span>
                    <span className={styles.personSub}>{sub(p)}</span>
                    <span className={styles.personSub}>
                      <StatusLabel lastActiveAt={p.lastActiveAt} />
                    </span>
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
                <SortHeader label="Employee" sortKey="name" sort={sort} onSort={toggleSort} align="left" />
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
                      <Avatar name={p.name} size="sm" status={activityStatus(p.lastActiveAt).tone === 'now' ? 'online' : undefined} />
                      <span className={styles.personText}>
                        <span className={styles.personName}>{p.name}</span>
                        <span className={styles.personSub}>{sub(p)}</span>
                        <span className={styles.personSub}>
                          <StatusLabel lastActiveAt={p.lastActiveAt} />
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

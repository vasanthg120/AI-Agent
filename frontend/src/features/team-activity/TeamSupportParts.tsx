import { useState } from 'react';
import clsx from 'clsx';
import { FiAlertTriangle, FiChevronRight, FiInfo } from 'react-icons/fi';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { TeamDepartment, TeamSupportItem } from '@/services/teamActivityService';
import styles from './TeamActivity.module.css';
import taskStyles from './TeamTasks.module.css';

const SHOWN = 4;
const ICON = { warning: FiAlertTriangle, info: FiInfo } as const;

/** Who may need a hand, and why — a line each, worst first; the name opens their page, "See" the records behind it. */
export function SupportList({
  items,
  showBusiness,
  onOpenPerson,
  onOpenList,
}: {
  items: TeamSupportItem[];
  showBusiness: boolean;
  onOpenPerson: (item: TeamSupportItem) => void;
  onOpenList: (item: TeamSupportItem) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <>
      <ul className={taskStyles.support}>
        {shown.map((item, i) => {
          const Icon = ICON[item.severity];
          return (
            <li key={`${item.businessId}-${item.personId}-${i}`} className={taskStyles.supportRow}>
              <Icon className={clsx(taskStyles.supportIcon, taskStyles[`sev_${item.severity}`])} aria-hidden />
              <span className={taskStyles.supportText}>
                <button type="button" className={taskStyles.linkButton} onClick={() => onOpenPerson(item)}>
                  {item.personName}
                </button>
                {showBusiness && item.businessName !== item.personName ? ` (${item.businessName})` : ''} — {item.text}
              </span>
              {item.list && (
                <button type="button" className={taskStyles.supportGo} onClick={() => onOpenList(item)}>
                  See
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > SHOWN && (
        <button type="button" className={taskStyles.more} onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  );
}

/** Each team (department) side by side; a row narrows the people below to that team. */
export function DepartmentsTable({
  departments,
  activeKey,
  showBusiness,
  onSelect,
}: {
  departments: TeamDepartment[];
  activeKey: string | null;
  showBusiness: boolean;
  onSelect: (key: string | null) => void;
}) {
  // Too many figures for a narrow screen: one card per team instead of a table that scrolls sideways.
  const narrow = useMediaQuery('(max-width: 900px)');
  if (narrow) {
    return (
      <ul className={styles.personCards}>
        {departments.map((d) => {
          const active = d.key === activeKey;
          const figures: { label: string; value: string; tone?: 'warning' | 'danger' }[] = [
            { label: 'People active', value: `${d.activePeople}/${d.people}` },
            { label: 'Tasks done', value: String(d.followUpsCompleted) },
            { label: 'Open', value: String(d.followUpsPending) },
            { label: 'Overdue', value: String(d.followUpsOverdue), tone: d.followUpsOverdue > 0 ? 'danger' : undefined },
            { label: 'Replied', value: String(d.emailsReplied) },
            { label: 'Missed emails', value: String(d.emailsMissed), tone: d.emailsMissed > 0 ? 'warning' : undefined },
            { label: 'Calls', value: String(d.calls) },
            { label: 'Need support', value: String(d.needSupport), tone: d.needSupport > 0 ? 'warning' : undefined },
          ];
          return (
            <li key={d.key}>
              <button type="button" className={clsx(styles.personCard, active && taskStyles.deptActive)} aria-pressed={active} onClick={() => onSelect(active ? null : d.key)}>
                <span className={styles.personCell}>
                  <span className={styles.personText}>
                    <span className={styles.personName}>{d.name}</span>
                    {showBusiness && <span className={styles.personSub}>{d.businessName}</span>}
                  </span>
                  <FiChevronRight className={styles.rowChevron} aria-hidden />
                </span>
                <span className={styles.personFigures}>
                  {figures.map((f) => (
                    <span key={f.label} className={clsx(styles.personFigure, f.tone && styles[`cell_${f.tone}`])}>
                      <span className={styles.personFigureLabel}>{f.label}</span>
                      <strong>{f.value}</strong>
                    </span>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Team</th>
            <th className={styles.num}>People</th>
            <th className={styles.num} title="Tasks and follow-ups finished in the period">
              Tasks done
            </th>
            <th className={styles.num} title="Not done yet, now (of which started)">
              Open
            </th>
            <th className={styles.num}>Overdue</th>
            <th className={styles.num} title="Customer emails answered in the period">
              Replied
            </th>
            <th className={styles.num} title="Customer emails that went 24 hours without a reply">
              Missed
            </th>
            <th className={styles.num}>Calls</th>
            <th className={styles.num}>Score</th>
            <th className={styles.num}>Need support</th>
            <th aria-hidden className={styles.chevronCol} />
          </tr>
        </thead>
        <tbody>
          {departments.map((d) => {
            const active = d.key === activeKey;
            const select = () => onSelect(active ? null : d.key);
            return (
              <tr
                key={d.key}
                className={clsx(styles.row, active && taskStyles.deptActive)}
                tabIndex={0}
                aria-pressed={active}
                aria-label={active ? `Show everyone again` : `Show only ${d.name}`}
                onClick={select}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    select();
                  }
                }}
              >
                <td>
                  <span className={styles.personText}>
                    <span className={styles.businessName}>{d.name}</span>
                    {showBusiness && <span className={styles.personSub}>{d.businessName}</span>}
                  </span>
                </td>
                <td className={styles.num}>
                  {d.activePeople}/{d.people}
                </td>
                <td className={styles.num}>{d.followUpsCompleted}</td>
                <td className={styles.num}>
                  {d.followUpsPending}
                  {d.followUpsInProgress ? <span className={styles.personSub}> ({d.followUpsInProgress} started)</span> : null}
                </td>
                <td className={clsx(styles.num, d.followUpsOverdue > 0 ? styles.cell_danger : styles.zero)}>{d.followUpsOverdue}</td>
                <td className={styles.num}>{d.emailsReplied}</td>
                <td className={clsx(styles.num, d.emailsMissed > 0 ? styles.cell_warning : styles.zero)}>{d.emailsMissed}</td>
                <td className={styles.num}>{d.calls}</td>
                <td className={styles.num}>{d.avgCallScore === null ? '—' : `${d.avgCallScore}/10`}</td>
                <td className={clsx(styles.num, d.needSupport > 0 ? styles.cell_warning : styles.zero)}>{d.needSupport}</td>
                <td className={styles.chevronCol}>
                  <FiChevronRight className={styles.rowChevron} aria-hidden />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import { motion } from 'framer-motion';
import clsx from 'clsx';
import type { ActivityCounts } from '@/services/teamActivityService';
import { GROUP_LABELS, METRICS, type MetricDef, type MetricGroup, type MetricKey } from './metrics';
import styles from './TeamActivity.module.css';

const GROUPS: MetricGroup[] = ['sales', 'email', 'calls', 'followups'];

// The figures as tiles, in four rows — deals, email, calls, follow-ups — each
// tile opening the records behind it. `only` keeps a short set (the Dashboard).
export function TeamActivityKpis({
  counts,
  onOpen,
  only,
  compact,
  currency,
}: {
  counts: ActivityCounts;
  onOpen: (metric: MetricDef) => void;
  only?: MetricKey[];
  compact?: boolean;
  /** For amounts; omitted when businesses with different currencies are added up. */
  currency?: string | null;
}) {
  let index = 0;
  const tile = (m: MetricDef) => {
    const raw = m.sortValue(counts);
    const alert = m.alert && raw > 0 ? m.alert : undefined;
    const Icon = m.icon;
    const sub = m.sub?.(counts, currency);
    const i = index++;
    return (
      <motion.button
        key={m.key}
        type="button"
        className={clsx(styles.kpi, alert && styles[`kpi_${alert}`])}
        onClick={() => onOpen(m)}
        title={m.meaning}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, delay: Math.min(i, 12) * 0.025, ease: [0.16, 1, 0.3, 1] }}
      >
        <span className={styles.kpiTop}>
          <span className={styles.kpiIcon} aria-hidden>
            <Icon />
          </span>
          <span className={styles.kpiLabel}>{m.label}</span>
        </span>
        <span className={styles.kpiValue}>{m.key === 'pipelineValue' && !currency ? '—' : m.value(counts, currency)}</span>
        <span className={styles.kpiSub}>{(m.key === 'pipelineValue' && !currency ? 'several currencies' : sub) ?? ' '}</span>
      </motion.button>
    );
  };

  if (only) {
    return <div className={clsx(styles.kpis, compact && styles.kpisCompact)}>{METRICS.filter((m) => only.includes(m.key)).map(tile)}</div>;
  }
  return (
    <div className={styles.kpiGroups}>
      {GROUPS.map((group) => (
        <section key={group} className={styles.kpiGroup} aria-label={GROUP_LABELS[group]}>
          <h3 className={styles.kpiGroupTitle}>{GROUP_LABELS[group]}</h3>
          <div className={clsx(styles.kpis, styles[`kpis_${group}`], compact && styles.kpisCompact)}>{METRICS.filter((m) => m.group === group).map(tile)}</div>
        </section>
      ))}
    </div>
  );
}

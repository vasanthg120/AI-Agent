import type { ReactNode } from 'react';
import clsx from 'clsx';
import { FiDatabase, FiSlash } from 'react-icons/fi';
import { useDataSources } from '@/hooks/useDataSources';
import styles from './MetricGate.module.css';

// Wraps a dashboard widget that shows one metric. Renders the widget only
// when the selected data source can really provide that metric; otherwise a
// clear "Not supported by <CRM>" panel in its place — never a borrowed number
// from another source, never a misleading zero. Widgets the person hid on
// their own dashboard render nothing.
export function MetricGate({
  metric: metricId,
  children,
  compact,
  className,
}: {
  metric: string;
  children: ReactNode;
  // A smaller placeholder for stat tiles.
  compact?: boolean;
  className?: string;
}) {
  const { metric, isHidden, data } = useDataSources();
  // Until the source picture loads, show the widget as before (it has its own loading state).
  if (!data) return <>{children}</>;
  if (isHidden(metricId)) return null;
  const availability = metric(metricId);
  if (!availability || availability.status === 'supported') return <>{children}</>;

  return (
    <div className={clsx(styles.unavailable, compact && styles.compact, className)} role="note">
      <span className={styles.icon} aria-hidden>
        {availability.status === 'no_source' ? <FiDatabase /> : <FiSlash />}
      </span>
      <div className={styles.text}>
        <strong>{availability.label}</strong>
        <span>
          {availability.status === 'no_source' ? 'No data — ' : 'Not available — '}
          {availability.reason}
        </span>
      </div>
    </div>
  );
}

// "Data from Customized Haive CRM · Emails from Outlook" — under a section
// title, so every figure's origin is visible.
export function SourceLine({ metrics, className }: { metrics: string[]; className?: string }) {
  const { metric, data } = useDataSources();
  if (!data) return null;
  const origins = [...new Set(metrics.flatMap((id) => metric(id)?.sources ?? []))];
  if (origins.length === 0) return null;
  return (
    <span className={clsx(styles.sourceLine, className)}>
      <FiDatabase aria-hidden /> Source: {origins.join(' + ')}
      {data.selection.mode === 'unified' && ' (unified — duplicates counted once)'}
    </span>
  );
}

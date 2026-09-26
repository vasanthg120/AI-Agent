import { useState } from 'react';
import clsx from 'clsx';
import { FiPieChart } from 'react-icons/fi';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { AnimatedNumber, EmptyState } from '@/components/ui';
import styles from './DealSplitDonut.module.css';

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

// Donut + legend that act as one control: hovering a slice or its legend row
// highlights both, the centre shows the hovered slice (or the total), and
// clicking either drills into that slice's records when onSelectSegment is set.
export function DealSplitDonut({
  segments,
  totalLabel,
  onSelectSegment,
}: {
  segments: DonutSegment[];
  totalLabel: string;
  onSelectSegment?: (key: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  if (total === 0) {
    return <EmptyState compact icon={FiPieChart} title="No data for this period yet" description="Try a wider date range." />;
  }

  const focus = segments.find((s) => s.key === hovered);
  const pct = (v: number) => Math.round((v / total) * 100);

  return (
    <div className={styles.wrapper}>
      <div className={styles.chart}>
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie
              data={segments}
              dataKey="value"
              nameKey="label"
              innerRadius={62}
              outerRadius={92}
              paddingAngle={2}
              cornerRadius={4}
              stroke="none"
              animationDuration={800}
              cursor={onSelectSegment ? 'pointer' : undefined}
              onMouseEnter={(entry: DonutSegment) => setHovered(entry.key)}
              onMouseLeave={() => setHovered(null)}
              onClick={onSelectSegment ? (entry: DonutSegment) => onSelectSegment(entry.key) : undefined}
            >
              {segments.map((s) => (
                <Cell
                  key={s.key}
                  fill={s.color}
                  fillOpacity={hovered && hovered !== s.key ? 0.3 : 1}
                  style={{ transition: 'fill-opacity 200ms ease', outline: 'none' }}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-text-primary)',
              }}
              labelStyle={{ color: 'var(--color-text-primary)' }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className={styles.center} aria-hidden>
          <span className={styles.centerValue}>
            <AnimatedNumber value={focus ? focus.value : total} duration={0.4} />
          </span>
          <span className={styles.centerLabel}>{focus ? `${focus.label} · ${pct(focus.value)}%` : totalLabel}</span>
        </div>
      </div>

      <div className={styles.legend}>
        {segments.map((s) => {
          const Tag = onSelectSegment ? 'button' : 'div';
          return (
            <Tag
              key={s.key}
              {...(onSelectSegment ? { type: 'button' as const, onClick: () => onSelectSegment(s.key) } : {})}
              className={clsx(styles.legendItem, onSelectSegment && styles.legendItemClickable, hovered === s.key && styles.legendItemActive)}
              onMouseEnter={() => setHovered(s.key)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(s.key)}
              onBlur={() => setHovered(null)}
            >
              <span className={styles.swatch} style={{ background: s.color }} />
              <span className={styles.legendLabel}>{s.label}</span>
              <span className={styles.legendValue}>{s.value.toLocaleString()}</span>
              <span className={styles.legendPct}>{pct(s.value)}%</span>
            </Tag>
          );
        })}
      </div>
    </div>
  );
}

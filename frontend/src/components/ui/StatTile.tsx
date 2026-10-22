import clsx from 'clsx';
import type { IconType } from 'react-icons';
import { FiArrowDown, FiArrowUp } from 'react-icons/fi';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { AnimatedNumber } from './AnimatedNumber';
import { Card } from './Card';
import styles from './StatTile.module.css';

export interface StatTileTrend {
  direction: 'up' | 'down';
  label: string;
}

export function StatTile({
  value,
  label,
  active,
  onClick,
  icon: Icon,
  trend,
  glass,
  sparkline,
  sparklineColor,
}: {
  value: string | number;
  label: string;
  active?: boolean;
  onClick?: () => void;
  // All optional and additive — most existing call sites pass none of
  // these, so this is zero behavior/visual change for them.
  icon?: IconType;
  trend?: StatTileTrend;
  glass?: boolean;
  // A real per-day series for this exact stat (e.g. the same data already
  // driving that metric's own "Over Time" chart elsewhere on the page) —
  // never a placeholder/invented trend. Needs 2+ points to draw a line;
  // omitted (or too short) renders exactly like before.
  sparkline?: number[];
  sparklineColor?: string;
}) {
  const showSparkline = sparkline && sparkline.length > 1;
  return (
    <Card
      interactive={!!onClick}
      glass={glass}
      className={clsx(styles.tile, active && styles.tileActive, showSparkline && styles.tileWithSparkline)}
      onClick={onClick}
    >
      <div className={styles.body}>
        {Icon && (
          <span className={styles.iconBadge}>
            <Icon size={14} />
          </span>
        )}
        {/* Plain integers count up; pre-formatted strings (currency, %) render as given. */}
        <div className={styles.value}>{typeof value === 'number' && Number.isInteger(value) ? <AnimatedNumber value={value} /> : value}</div>
        <div className={styles.label}>{label}</div>
        {trend && (
          <span className={clsx(styles.trend, trend.direction === 'up' ? styles.trendUp : styles.trendDown)}>
            {trend.direction === 'up' ? <FiArrowUp size={11} /> : <FiArrowDown size={11} />}
            {trend.label}
          </span>
        )}
      </div>
      {showSparkline && (
        <div className={styles.sparkline}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkline.map((v) => ({ v }))}>
              <defs>
                <linearGradient id={`spark-${label.replace(/\s+/g, '-')}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={sparklineColor ?? 'var(--color-accent)'} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={sparklineColor ?? 'var(--color-accent)'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={sparklineColor ?? 'var(--color-accent)'}
                strokeWidth={1.5}
                fill={`url(#spark-${label.replace(/\s+/g, '-')})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

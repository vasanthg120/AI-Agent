import clsx from 'clsx';
import type { IconType } from 'react-icons';
import { FiArrowDown, FiArrowUp } from 'react-icons/fi';
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
}) {
  return (
    <Card
      interactive={!!onClick}
      glass={glass}
      className={clsx(styles.tile, active && styles.tileActive)}
      onClick={onClick}
    >
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
    </Card>
  );
}

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Card } from '@/components/ui';
import styles from './CustomerMixCard.module.css';

export interface CustomerMixCardProps {
  newCount: number;
  existingCount: number;
  lostCount: number;
  totalConsidered: number;
  // Additive — clicking a segment (donut slice or legend row) opens a popup
  // listing the businesses behind that number. Omitted keeps the card
  // purely visual, as every existing call site expects.
  onSegmentClick?: (key: 'new' | 'existing' | 'lost') => void;
}

const SEGMENTS = [
  { key: 'new', label: 'New', color: 'var(--brand-accent-primary)' },
  { key: 'existing', label: 'Existing', color: 'color-mix(in srgb, var(--color-text-muted) 25%, white)' },
  { key: 'lost', label: 'Lost', color: 'color-mix(in srgb, var(--color-text-muted) 60%, white)' },
] as const;

export function CustomerMixCard({ newCount, existingCount, lostCount, totalConsidered, onSegmentClick }: CustomerMixCardProps) {
  const values: Record<string, number> = { new: newCount, existing: existingCount, lost: lostCount };
  const data = SEGMENTS.map((s) => ({ ...s, value: values[s.key] }));

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.label}>Relationship Health</div>
          <div className={styles.title}>Customer mix</div>
        </div>
        <span className={styles.periodTotal}>{totalConsidered.toLocaleString()} customers</span>
      </div>

      {totalConsidered === 0 ? (
        <div className={styles.empty}>No customer activity for this period yet.</div>
      ) : (
        <div className={styles.body}>
          <div className={styles.donutWrap}>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={data} dataKey="value" nameKey="label" innerRadius={62} outerRadius={92} paddingAngle={2} startAngle={90} endAngle={-270}>
                  {data.map((s) => (
                    <Cell
                      key={s.key}
                      fill={s.color}
                      stroke="none"
                      cursor={onSegmentClick ? 'pointer' : undefined}
                      onClick={onSegmentClick ? () => onSegmentClick(s.key) : undefined}
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
            <div className={styles.centerLabel}>
              <div className={styles.centerValue}>{totalConsidered.toLocaleString()}</div>
              <div className={styles.centerCaption}>customers</div>
            </div>
          </div>

          <div className={styles.legend}>
            {data.map((s) =>
              onSegmentClick ? (
                <button
                  key={s.key}
                  type="button"
                  className={`${styles.legendItem} ${styles.legendItemClickable}`}
                  onClick={() => onSegmentClick(s.key)}
                >
                  <i className={styles.dot} style={{ background: s.color }} />
                  <span className={styles.legendValue}>{s.value.toLocaleString()}</span>
                  <span className={styles.legendLabel}>{s.label}</span>
                </button>
              ) : (
                <div key={s.key} className={styles.legendItem}>
                  <i className={styles.dot} style={{ background: s.color }} />
                  <span className={styles.legendValue}>{s.value.toLocaleString()}</span>
                  <span className={styles.legendLabel}>{s.label}</span>
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

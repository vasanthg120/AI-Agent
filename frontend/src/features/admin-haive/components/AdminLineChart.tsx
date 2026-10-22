import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsSeriesPoint } from '@/services/billingAdminService';

// Bar chart (not the previous area/gradient style) — same recessive-axis,
// minimal-gridline treatment as the AI Usage page's charts (AdminAiUsagePage.tsx),
// requested to match the same clean bar look there. Same real single-series
// `data`/`color` contract as before; only how it's drawn changed.
export function AdminLineChart({ data, color = '#5b8def', valueFormatter }: { data: AnalyticsSeriesPoint[]; color?: string; valueFormatter?: (v: number) => string }) {
  if (data.length === 0) {
    return (
      <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
        No data in this range yet.
      </div>
    );
  }

  // ~6 evenly spaced x-axis labels regardless of range length, instead of
  // recharts' default auto-skip (which on a wide range only ever showed the
  // first and last date).
  const tickInterval = Math.max(0, Math.ceil(data.length / 6) - 1);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={11} axisLine={false} tickLine={false} interval={tickInterval} />
        <YAxis
          stroke="var(--color-text-muted)"
          fontSize={11}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => (valueFormatter ? valueFormatter(v) : v.toLocaleString())}
        />
        <Tooltip
          formatter={(value: number) => (valueFormatter ? valueFormatter(value) : value.toLocaleString())}
          contentStyle={{
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text-primary)',
          }}
          labelStyle={{ color: 'var(--color-text-primary)' }}
          cursor={{ fill: 'var(--color-bg-hover)' }}
        />
        <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

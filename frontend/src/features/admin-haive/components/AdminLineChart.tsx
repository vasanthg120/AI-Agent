import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsSeriesPoint } from '@/services/billingAdminService';

export function AdminLineChart({ data, color = '#5b8def', valueFormatter }: { data: AnalyticsSeriesPoint[]; color?: string; valueFormatter?: (v: number) => string }) {
  if (data.length === 0) {
    return (
      <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
        No data in this range yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id={`fill-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.35} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={11} />
        <YAxis stroke="var(--color-text-muted)" fontSize={11} tickFormatter={(v: number) => (valueFormatter ? valueFormatter(v) : v.toLocaleString())} />
        <Tooltip
          formatter={(value: number) => (valueFormatter ? valueFormatter(value) : value.toLocaleString())}
          contentStyle={{
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text-primary)',
          }}
          labelStyle={{ color: 'var(--color-text-primary)' }}
        />
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#fill-${color})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

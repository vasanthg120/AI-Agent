import { useState } from 'react';
import { Tabs } from '@/components/ui';

const PRESETS = [
  { id: '1', label: 'Today', days: 1 },
  { id: '7', label: '7 Days', days: 7 },
  { id: '30', label: '30 Days', days: 30 },
  { id: '90', label: '90 Days', days: 90 },
  { id: 'custom', label: 'Custom' },
];

// Every dashboard/analytics endpoint here takes a single `days` window
// ending now (see billing-admin.service.ts's getDashboard/
// getAnalyticsTimeSeries) — "Custom" just lets the admin dial that window in
// directly rather than picking a canned preset, still expressed as days.
export function AdminRangeControl({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const matchingPreset = PRESETS.find((p) => p.days === days);
  const [activeId, setActiveId] = useState<string>(matchingPreset?.id ?? 'custom');

  const handlePreset = (id: string) => {
    setActiveId(id);
    const preset = PRESETS.find((p) => p.id === id);
    if (preset?.days !== undefined) onChange(preset.days);
  };
                                                             
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
      <Tabs items={PRESETS.map((p) => ({ id: p.id, label: p.label }))} activeId={activeId} onChange={handlePreset} />
      {activeId === 'custom' && (
        <input
          type="number"
          min={1}
          max={730}
          value={days}
          onChange={(event) => onChange(Math.max(1, Number.parseInt(event.target.value, 10) || 1))}
          style={{
            width: 72,
            padding: '6px 8px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg-input)',
            color: 'var(--color-text-primary)',
          }}
          aria-label="Custom number of days"
        />
      )}
    </div>
  );
}

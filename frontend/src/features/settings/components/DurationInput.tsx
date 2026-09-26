import { useEffect, useState } from 'react';
import clsx from 'clsx';
import styles from './DurationInput.module.css';

type Unit = 'min' | 'hour' | 'day';
const UNIT_MINUTES: Record<Unit, number> = { min: 1, hour: 60, day: 1440 };
const UNIT_LABEL: Record<Unit, string> = { min: 'minutes', hour: 'hours', day: 'days' };

// The largest unit that represents the value exactly — 1440 shows as "1 day",
// 90 as "90 minutes" (not "1.5 hours").
function bestUnit(minutes: number): Unit {
  if (minutes > 0 && minutes % 1440 === 0) return 'day';
  if (minutes > 0 && minutes % 60 === 0) return 'hour';
  return 'min';
}

export interface DurationPreset {
  label: string;
  minutes: number;
}

// A duration picker that stores minutes (what the backend wants) but lets
// people think in "4 hours" / "1 day" instead of doing the arithmetic.
export function DurationInput({
  value,
  onChange,
  min = 0,
  presets,
  disabled,
  ariaLabel,
}: {
  value: number;
  onChange: (minutes: number) => void;
  min?: number;
  presets?: DurationPreset[];
  disabled?: boolean;
  ariaLabel: string;
}) {
  const [unit, setUnit] = useState<Unit>(() => bestUnit(value));
  const [text, setText] = useState(() => String(value / UNIT_MINUTES[bestUnit(value)]));

  // External changes (a preset, a reset/discard) re-derive the display.
  useEffect(() => {
    const current = Number(text) * UNIT_MINUTES[unit];
    if (current !== value) {
      const u = bestUnit(value);
      setUnit(u);
      setText(String(value / UNIT_MINUTES[u]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (nextText: string, nextUnit: Unit) => {
    setText(nextText);
    setUnit(nextUnit);
    const n = Number(nextText);
    if (nextText.trim() !== '' && Number.isFinite(n)) onChange(Math.max(min, Math.round(n * UNIT_MINUTES[nextUnit])));
  };

  return (
    <div className={styles.wrap}>
      <div className={clsx(styles.field, disabled && styles.disabled)}>
        <input
          type="number"
          min={0}
          step="any"
          className={styles.number}
          value={text}
          disabled={disabled}
          aria-label={ariaLabel}
          onChange={(e) => commit(e.target.value, unit)}
        />
        <select className={styles.unit} value={unit} disabled={disabled} aria-label={`${ariaLabel} unit`} onChange={(e) => commit(text, e.target.value as Unit)}>
          {(Object.keys(UNIT_LABEL) as Unit[]).map((u) => (
            <option key={u} value={u}>
              {UNIT_LABEL[u]}
            </option>
          ))}
        </select>
      </div>
      {presets && (
        <div className={styles.presets}>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={disabled}
              className={clsx(styles.preset, value === p.minutes && styles.presetActive)}
              onClick={() => onChange(p.minutes)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// "Immediately" / "45 min" / "4 hours" / "1 day" / "1h 30m" — for summaries.
export function formatDuration(totalMinutes: number): string {
  if (totalMinutes <= 0) return 'Immediately';
  if (totalMinutes < 60) return `${totalMinutes} min`;
  if (totalMinutes % 1440 === 0) {
    const days = totalMinutes / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (totalMinutes % 60 === 0) {
    const hours = totalMinutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

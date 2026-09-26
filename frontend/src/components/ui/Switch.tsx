import clsx from 'clsx';
import styles from './Switch.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  // Names the switch for assistive tech when there is no visible `label` — e.g. a
  // bare toggle in a table cell, where the row's other cells already say what it is.
  ariaLabel?: string;
}

export function Switch({ checked, onChange, label, description, disabled, ariaLabel }: SwitchProps) {
  const track = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? ariaLabel}
      disabled={disabled}
      className={clsx(styles.track, checked && styles.checked)}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.thumb} />
    </button>
  );

  if (!label) return track;

  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {description && <span className={styles.rowDescription}>{description}</span>}
      </div>
      {track}
    </div>
  );
}

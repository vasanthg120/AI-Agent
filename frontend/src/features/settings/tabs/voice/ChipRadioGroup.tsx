import { useId } from 'react';
import clsx from 'clsx';
import styles from './ChipRadioGroup.module.css';

export interface ChipOption {
  value: string;
  label: string;
  title?: string;
}

// A single-choice pill group built on native radio inputs, so arrow-key
// navigation, focus and screen-reader semantics come from the browser rather
// than from hand-rolled key handling. Used for the accent and gender filters
// and the speaking-style picker.
export function ChipRadioGroup({
  label,
  options,
  value,
  onChange,
  disabled,
  small,
}: {
  label: string;
  options: ChipOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  small?: boolean;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={styles.group}>
      {options.map((option) => (
        <label key={option.value} className={clsx(styles.chip, disabled && styles.disabled)} title={option.title}>
          <input
            type="radio"
            className={styles.input}
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          <span className={clsx(styles.face, small && styles.small)}>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

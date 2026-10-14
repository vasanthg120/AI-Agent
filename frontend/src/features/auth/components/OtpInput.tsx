import { useRef } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import clsx from 'clsx';
import styles from './OtpInput.module.css';

// A 6-digit code as six boxes: typing moves to the next box, Backspace goes
// back, and pasting (or a phone's one-time-code autofill) fills them all.
export function OtpInput({
  value,
  onChange,
  length = 6,
  error,
  autoFocus,
  disabled,
  label = 'Verification code',
}: {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  error?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');

  const focus = (i: number) => refs.current[Math.max(0, Math.min(length - 1, i))]?.focus();

  const setAt = (i: number, digit: string) => {
    const next = digits.slice();
    next[i] = digit;
    onChange(next.join('').replace(/\s/g, ''));
  };

  const handleInput = (i: number, raw: string) => {
    const clean = raw.replace(/\D/g, '');
    if (!clean) {
      setAt(i, '');
      return;
    }
    // More than one digit arrives when the phone autofills the whole code.
    if (clean.length > 1) {
      const filled = (digits.slice(0, i).join('') + clean).slice(0, length);
      onChange(filled);
      focus(filled.length);
      return;
    }
    setAt(i, clean);
    focus(i + 1);
  };

  const handleKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      e.preventDefault();
      setAt(i - 1, '');
      focus(i - 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focus(i + 1);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!pasted) return;
    e.preventDefault();
    onChange(pasted);
    focus(pasted.length);
  };

  return (
    <div className={styles.field}>
      <span className={styles.label} id="otp-label">
        {label}
      </span>
      <div className={styles.boxes} role="group" aria-labelledby="otp-label">
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className={clsx(styles.box, digit && styles.boxFilled, error && styles.boxError)}
            type="text"
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            maxLength={i === 0 ? length : 1}
            value={digit}
            disabled={disabled}
            autoFocus={autoFocus && i === 0}
            aria-label={`Digit ${i + 1} of ${length}`}
            onChange={(e) => handleInput(i, e.target.value)}
            onKeyDown={(e) => handleKey(i, e)}
            onPaste={handlePaste}
            onFocus={(e) => e.target.select()}
          />
        ))}
      </div>
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

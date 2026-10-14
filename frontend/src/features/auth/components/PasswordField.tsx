import { forwardRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { FiAlertTriangle, FiEye, FiEyeOff, FiLock } from 'react-icons/fi';
import { Input, type InputProps } from '@/components/ui';
import styles from '../AuthForm.module.css';

// A password input with show/hide and a Caps Lock warning — the two things
// that cause most "wrong password" moments.
export const PasswordField = forwardRef<HTMLInputElement, Omit<InputProps, 'type' | 'leftIcon' | 'rightIcon'>>(
  (props, ref) => {
    const [visible, setVisible] = useState(false);
    const [capsLock, setCapsLock] = useState(false);
    const detectCaps = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.('CapsLock') ?? false);

    return (
      <>
        <Input
          {...props}
          ref={ref}
          type={visible ? 'text' : 'password'}
          leftIcon={<FiLock />}
          onKeyUp={(e) => {
            detectCaps(e);
            props.onKeyUp?.(e);
          }}
          onKeyDown={(e) => {
            detectCaps(e);
            props.onKeyDown?.(e);
          }}
          onBlur={(e) => {
            setCapsLock(false);
            props.onBlur?.(e);
          }}
          rightIcon={
            <button
              type="button"
              className={styles.passwordToggle}
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? 'Hide password' : 'Show password'}
              aria-pressed={visible}
            >
              {visible ? <FiEyeOff /> : <FiEye />}
            </button>
          }
        />
        {capsLock && (
          <span className={styles.capsLock} role="status">
            <FiAlertTriangle aria-hidden /> Caps Lock is on
          </span>
        )}
      </>
    );
  },
);

PasswordField.displayName = 'PasswordField';

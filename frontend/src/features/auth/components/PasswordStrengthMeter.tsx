import clsx from 'clsx';
import { FiCheck, FiCircle } from 'react-icons/fi';
import styles from '../AuthForm.module.css';

const LEVELS = [
  { label: 'Too weak', color: 'var(--color-danger)' },
  { label: 'Weak', color: 'var(--color-danger)' },
  { label: 'Fair', color: 'var(--color-warning)' },
  { label: 'Good', color: 'var(--color-info)' },
  { label: 'Strong', color: 'var(--color-success)' },
];

const RULES = [
  { id: 'length', label: 'At least 8 characters', test: (p: string) => p.length >= 8 },
  { id: 'case', label: 'Upper and lower case', test: (p: string) => /[A-Z]/.test(p) && /[a-z]/.test(p) },
  { id: 'number', label: 'A number', test: (p: string) => /\d/.test(p) },
  { id: 'symbol', label: 'A symbol (!@#…)', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

function scorePassword(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  return Math.min(score, 4);
}

// Strength bar plus a live checklist, so people see what makes a good
// password while they type instead of after a failed submit.
export function PasswordStrengthMeter({ password }: { password: string }) {
  const score = scorePassword(password);
  const level = LEVELS[score];

  return (
    <div>
      <div className={styles.strengthMeter} aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={styles.strengthBar}
            style={{
              background: i <= score - 1 || (score === 0 && i === 0 && password.length > 0) ? level.color : undefined,
            }}
          />
        ))}
      </div>
      {password.length > 0 && (
        <div className={styles.strengthLabel} role="status">
          Password strength: {level.label}
        </div>
      )}
      <ul className={styles.checklist}>
        {RULES.map((rule) => {
          const met = rule.test(password);
          return (
            <li key={rule.id} className={clsx(met && styles.checkMet)}>
              {met ? <FiCheck aria-hidden /> : <FiCircle aria-hidden />} {rule.label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiCheck } from 'react-icons/fi';
import styles from './AuthStepper.module.css';

export interface AuthStep {
  id: string;
  label: string;
}

// The step indicator for multi-step signed-out flows (sign-up, password
// reset): numbered dots joined by a filling line, the current step's name
// underneath. Earlier steps can be revisited by clicking them.
export function AuthStepper({
  steps,
  current,
  onStepClick,
}: {
  steps: AuthStep[];
  current: number;
  onStepClick?: (index: number) => void;
}) {
  const progress = steps.length > 1 ? current / (steps.length - 1) : 1;
  return (
    <nav className={styles.stepper} aria-label="Progress" style={{ '--steps': steps.length } as React.CSSProperties}>
      <div className={styles.track} aria-hidden>
        <motion.span
          className={styles.fill}
          initial={false}
          animate={{ scaleX: progress }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
      <ol className={styles.steps}>
        {steps.map((step, i) => {
          const done = i < current;
          const active = i === current;
          const clickable = done && !!onStepClick;
          return (
            <li key={step.id} className={clsx(styles.step, done && styles.done, active && styles.active)}>
              <button
                type="button"
                className={styles.dot}
                disabled={!clickable}
                onClick={clickable ? () => onStepClick(i) : undefined}
                aria-current={active ? 'step' : undefined}
                aria-label={`Step ${i + 1}: ${step.label}${done ? ' (done)' : ''}`}
              >
                {done ? <FiCheck /> : i + 1}
              </button>
              <span className={styles.label}>{step.label}</span>
            </li>
          );
        })}
      </ol>
      <p className={styles.mobileLabel} aria-hidden>
        Step {current + 1} of {steps.length} · <strong>{steps[current]?.label}</strong>
      </p>
    </nav>
  );
}

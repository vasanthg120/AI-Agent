import { FiCheck } from 'react-icons/fi';
import clsx from 'clsx';
import styles from './Stepper.module.css';

export interface StepperItem {
  id: string;
  label: string;
}

export interface StepperProps {
  steps: StepperItem[];
  currentId: string;
  completedIds: string[];
  // Lets a caller allow jumping back to an already-completed step by
  // clicking its circle/label — omitted (the default) makes the stepper
  // purely a progress indicator, matching most wizards' "only Back/Next
  // move you" convention.
  onStepClick?: (id: string) => void;
}

// This app's first true multi-step wizard (Agent Builder) — no prior
// Stepper/progress-indicator component existed to reuse (confirmed via
// audit of components/ui). Deliberately minimal: numbered circles + labels
// + a connecting line, current/completed/upcoming states, collapsing to a
// plain "Step N of M" line below a phone-width breakpoint so a 9-step
// sequence never forces horizontal scrolling.
export function Stepper({ steps, currentId, completedIds, onStepClick }: StepperProps) {
  const currentIndex = Math.max(0, steps.findIndex((s) => s.id === currentId));
  const currentStep = steps[currentIndex];

  return (
    <nav className={styles.wrapper} aria-label="Progress">
      <div className={styles.compact}>
        Step {currentIndex + 1} of {steps.length}
        {currentStep && <span className={styles.compactLabel}> — {currentStep.label}</span>}
      </div>
      <ol className={styles.list}>
        {steps.map((step, index) => {
          const completed = completedIds.includes(step.id);
          const active = step.id === currentId;
          const clickable = !!onStepClick && (completed || active);
          return (
            <li key={step.id} className={styles.item}>
              <button
                type="button"
                className={clsx(styles.node, active && styles.nodeActive, completed && !active && styles.nodeCompleted)}
                onClick={clickable ? () => onStepClick?.(step.id) : undefined}
                disabled={!clickable}
                aria-current={active ? 'step' : undefined}
              >
                <span className={styles.circle}>{completed && !active ? <FiCheck size={13} /> : index + 1}</span>
                <span className={styles.label}>{step.label}</span>
              </button>
              {index < steps.length - 1 && <span className={clsx(styles.connector, completed && styles.connectorDone)} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

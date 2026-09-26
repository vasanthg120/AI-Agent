import type { FormState } from '../formState';
import styles from './steps.module.css';

const PLACEHOLDER = `Tell your agent exactly what it's responsible for and how to behave. For example:

You are acting specifically as the Sales Consultant. Your focus is helping the consultant manage their pipeline and close more deals. When asked about a customer or deal, use real CRM data — never guess at numbers. Keep recommendations specific and actionable.`;

export function StepInstructions({ form, update }: { form: FormState; update: (patch: Partial<FormState>) => void }) {
  const length = form.systemPrompt.trim().length;

  return (
    <div className={styles.stepBody}>
      <p className={styles.stepIntro}>
        This is what actually shapes how your agent behaves and responds — write it like you're briefing a new employee on
        their job.
      </p>
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="system-prompt">
          Instructions <span className={styles.optionalTag}>Required</span>
        </label>
        <textarea
          id="system-prompt"
          className={styles.textarea}
          value={form.systemPrompt}
          onChange={(e) => update({ systemPrompt: e.target.value })}
          placeholder={PLACEHOLDER}
        />
        {length > 0 && length < 40 && (
          <p className={styles.helperText}>This looks a bit short — the more specific you are, the better your agent performs.</p>
        )}
      </div>
    </div>
  );
}

import { Input } from '@/components/ui';
import { ROLE_CATEGORIES, ROLE_CATEGORY_LABEL, type RoleCategory } from '@/services/agentRolesService';
import type { FormState } from '../formState';
import styles from './steps.module.css';

export function StepBasics({ form, update }: { form: FormState; update: (patch: Partial<FormState>) => void }) {
  return (
    <div className={styles.stepBody}>
      <Input
        label="Agent Name"
        value={form.name}
        onChange={(e) => update({ name: e.target.value })}
        placeholder="e.g. Sales Consultant"
        required
      />

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="role-category">
          Role Category
        </label>
        <select
          id="role-category"
          className={styles.select}
          value={form.department}
          onChange={(e) => update({ department: e.target.value as RoleCategory })}
        >
          {ROLE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {ROLE_CATEGORY_LABEL[category]}
            </option>
          ))}
        </select>
        <p className={styles.helperText}>
          Used to suggest relevant knowledge and capabilities later in this wizard — you can always add more yourself.
        </p>
      </div>

      <Input
        label="Purpose"
        value={form.description}
        onChange={(e) => update({ description: e.target.value })}
        placeholder="A short summary of what this agent is for"
        hint="Shown to your team when they @mention this agent in chat."
      />
    </div>
  );
}

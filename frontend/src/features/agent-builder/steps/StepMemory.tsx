import { SectionCard, Switch } from '@/components/ui';
import { MEMORY_TOOL } from '../toolCatalog';
import type { FormState } from '../formState';
import styles from './steps.module.css';

export function StepMemory({ form, update }: { form: FormState; update: (patch: Partial<FormState>) => void }) {
  const enabled = form.allowedTools.includes(MEMORY_TOOL);

  return (
    <div className={styles.stepBody}>
      <SectionCard title="Memory">
        <Switch
          checked={enabled}
          onChange={(v) =>
            update({
              allowedTools: v ? [...new Set([...form.allowedTools, MEMORY_TOOL])] : form.allowedTools.filter((t) => t !== MEMORY_TOOL),
            })
          }
          label="Remember important details across conversations"
          description="Lets this agent recall things a user has told it before, like preferences or past decisions."
        />
        <p className={styles.helperText}>
          Memory is per-person today, not per-agent — anything remembered is shared across every agent that person talks
          to, not kept separate for this one.
        </p>
      </SectionCard>
    </div>
  );
}

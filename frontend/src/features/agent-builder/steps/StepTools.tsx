import { SectionCard } from '@/components/ui';
import { isSystemEnabled, TOOL_SYSTEMS } from '../toolCatalog';
import type { FormState } from '../formState';
import styles from './steps.module.css';

export function StepTools({ form, update }: { form: FormState; update: (patch: Partial<FormState>) => void }) {
  const enabledSystems = TOOL_SYSTEMS.filter((system) => isSystemEnabled(system, form.allowedTools));

  const toggleTool = (name: string, checked: boolean) => {
    update({
      allowedTools: checked ? [...new Set([...form.allowedTools, name])] : form.allowedTools.filter((t) => t !== name),
    });
  };

  if (enabledSystems.length === 0) {
    return (
      <div className={styles.stepBody}>
        <p className={styles.stepIntro}>
          No systems are enabled yet — go back to Access & Permissions and turn on at least one system to choose specific
          capabilities here.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.stepBody}>
      <p className={styles.stepIntro}>
        Choose exactly what this agent can do within the systems you enabled. Sensitive actions are off by default.
      </p>
      {enabledSystems.map((system) => (
        <SectionCard key={system.id} title={system.label}>
          <div className={styles.toolGrid}>
            {system.tools.map((tool) => (
              <label key={tool.name} className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={form.allowedTools.includes(tool.name)}
                  onChange={(e) => toggleTool(tool.name, e.target.checked)}
                />
                {tool.label}
                {tool.sensitive && <span className={styles.sensitiveTag}>Sensitive</span>}
              </label>
            ))}
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

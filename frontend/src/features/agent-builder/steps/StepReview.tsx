import { Badge, SectionCard } from '@/components/ui';
import { ROLE_CATEGORY_LABEL } from '@/services/agentRolesService';
import type { AdminUser } from '@/services/usersService';
import { isSensitiveTool, MEMORY_TOOL, toolLabel } from '../toolCatalog';
import type { FormState } from '../formState';
import styles from './steps.module.css';

export function StepReview({ form, users }: { form: FormState; users: AdminUser[] }) {
  const nonMemoryTools = form.allowedTools.filter((t) => t !== MEMORY_TOOL);
  const memoryEnabled = form.allowedTools.includes(MEMORY_TOOL);
  const sensitive = form.allowedTools.filter(isSensitiveTool);
  const visibleUserNames = users.filter((u) => form.assignedUserIds.includes(u.id)).map((u) => u.name);

  return (
    <div className={styles.stepBody}>
      <p className={styles.stepIntro}>Review everything below, then create your agent.</p>

      <SectionCard title="Agent">
        <div className={styles.reviewRow}>
          <span className={styles.reviewLabel}>Name</span>
          <span className={styles.reviewValue}>{form.name || '—'}</span>
        </div>
        <div className={styles.reviewRow}>
          <span className={styles.reviewLabel}>Role Category</span>
          <span className={styles.reviewValue}>{ROLE_CATEGORY_LABEL[form.department]}</span>
        </div>
        <div className={styles.reviewRow}>
          <span className={styles.reviewLabel}>Purpose</span>
          <span className={styles.reviewValue}>{form.description || '—'}</span>
        </div>
      </SectionCard>

      <SectionCard title="Knowledge">
        <div className={styles.reviewRow}>
          <span className={styles.reviewLabel}>Sources</span>
          <span className={styles.reviewValue}>
            {form.sourceDocumentName ? `Generated from ${form.sourceDocumentName}, plus ` : ''}
            organization-wide shared knowledge base
          </span>
        </div>
      </SectionCard>

      <SectionCard title="Access">
        <div className={styles.reviewRow}>
          <span className={styles.reviewLabel}>Visible to</span>
          <span className={styles.reviewValue}>
            {form.assignedDepartments.length === 0 && visibleUserNames.length === 0
              ? 'Everyone in your organization'
              : [...form.assignedDepartments, ...visibleUserNames].join(', ')}
          </span>
        </div>
      </SectionCard>

      <SectionCard title="Capabilities">
        {nonMemoryTools.length === 0 ? (
          <span className={styles.reviewValue}>No tools enabled — this agent can only converse using its instructions.</span>
        ) : (
          <div className={styles.chipRow} style={{ justifyContent: 'flex-start' }}>
            {nonMemoryTools.map((t) => (
              <Badge key={t} variant="accent">
                {toolLabel(t)}
              </Badge>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Memory">
        <span className={styles.reviewValue}>{memoryEnabled ? 'Enabled' : 'Disabled'}</span>
      </SectionCard>

      <SectionCard title="Security">
        <div className={styles.reviewRow}>
          <span className={styles.reviewLabel}>Sensitive actions enabled</span>
          <span className={styles.reviewValue}>{sensitive.length === 0 ? 'None' : sensitive.map(toolLabel).join(', ')}</span>
        </div>
        <div className={styles.reviewRow}>
          <span className={styles.reviewLabel}>Starting status</span>
          <span className={styles.reviewValue}>Draft (activate below to go live)</span>
        </div>
      </SectionCard>
    </div>
  );
}

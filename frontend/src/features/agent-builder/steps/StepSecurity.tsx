import { FiInfo, FiShield } from 'react-icons/fi';
import { Badge, SectionCard } from '@/components/ui';
import { isSensitiveTool, toolLabel } from '../toolCatalog';
import type { FormState } from '../formState';
import styles from './steps.module.css';

export function StepSecurity({ form }: { form: FormState }) {
  const sensitive = form.allowedTools.filter(isSensitiveTool);

  return (
    <div className={styles.stepBody}>
      <SectionCard title="Sensitive actions" icon={FiShield}>
        <p className={styles.stepIntro}>
          These are the actions this agent can take that reach outside your organization (sending something to a real
          person). Go back to Tools & Capabilities to change them.
        </p>
        {sensitive.length === 0 ? (
          <Badge variant="success">None enabled — this agent can only look things up, not send or write anything.</Badge>
        ) : (
          <div className={styles.chipRow} style={{ justifyContent: 'flex-start' }}>
            {sensitive.map((name) => (
              <Badge key={name} variant="warning">
                {toolLabel(name)}
              </Badge>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Draft-first, always" icon={FiShield}>
        <p className={styles.stepIntro}>
          Every new agent starts as a <strong>Draft</strong>. It can't be used in chat, and none of the tools above can
          run, until you explicitly Activate it — from this wizard, or later from the agents list.
        </p>
      </SectionCard>

      <SectionCard title="Coming later" icon={FiInfo}>
        <p className={styles.stepIntro}>
          Pausing mid-conversation for a person to approve a specific action before it happens isn't available yet — for
          now, the way to require a human step is to leave that action's tool off above and have the agent draft it for a
          person to send instead.
        </p>
      </SectionCard>
    </div>
  );
}

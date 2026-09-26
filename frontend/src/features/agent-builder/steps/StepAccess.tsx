import { useEffect, useState } from 'react';
import { FiUsers } from 'react-icons/fi';
import { Badge, MultiSelectDropdown, SectionCard, StringListEditor, Switch } from '@/components/ui';
import { integrationsService } from '@/services/integrationsService';
import type { AdminUser } from '@/services/usersService';
import { defaultToolsForSystem, isSystemEnabled, TOOL_SYSTEMS } from '../toolCatalog';
import type { FormState } from '../formState';
import styles from './steps.module.css';

type ProviderStatus = { connected: boolean; label: string };

export function StepAccess({
  form,
  update,
  users,
}: {
  form: FormState;
  update: (patch: Partial<FormState>) => void;
  users: AdminUser[];
}) {
  const [providerStatus, setProviderStatus] = useState<Record<'outlook' | 'gmail' | 'crm', ProviderStatus | null>>({
    outlook: null,
    gmail: null,
    crm: null,
  });

  useEffect(() => {
    let cancelled = false;
    void integrationsService.getOutlookStatus().then((s) => {
      if (!cancelled) setProviderStatus((prev) => ({ ...prev, outlook: { connected: s.connected, label: s.email ?? '' } }));
    }).catch(() => undefined);
    void integrationsService.getGmailStatus().then((s) => {
      if (!cancelled) setProviderStatus((prev) => ({ ...prev, gmail: { connected: s.connected, label: s.email ?? '' } }));
    }).catch(() => undefined);
    void integrationsService.getCredentialStatus('crm').then((s) => {
      if (!cancelled) setProviderStatus((prev) => ({ ...prev, crm: { connected: s.connected, label: '' } }));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const providersUsed = (systemId: string): ('outlook' | 'gmail' | 'crm')[] => {
    const system = TOOL_SYSTEMS.find((s) => s.id === systemId);
    const set = new Set<'outlook' | 'gmail' | 'crm'>();
    system?.tools.forEach((t) => t.provider && set.add(t.provider));
    return [...set];
  };

  const toggleSystem = (systemId: string, enabled: boolean) => {
    const system = TOOL_SYSTEMS.find((s) => s.id === systemId);
    if (!system) return;
    const toolNames = system.tools.map((t) => t.name);
    if (enabled) {
      const toAdd = defaultToolsForSystem(system);
      update({ allowedTools: [...new Set([...form.allowedTools, ...toAdd])] });
    } else {
      update({ allowedTools: form.allowedTools.filter((t) => !toolNames.includes(t)) });
    }
  };

  return (
    <div className={styles.stepBody}>
      <p className={styles.stepIntro}>
        Choose which systems this agent can reach. Fine-tune exactly which actions within each one in the next step.
      </p>

      {TOOL_SYSTEMS.map((system) => {
        const enabled = isSystemEnabled(system, form.allowedTools);
        const providers = providersUsed(system.id);
        return (
          <SectionCard key={system.id} title={system.label}>
            <div className={styles.systemHeader}>
              <div className={styles.systemHeaderLeft}>
                <span className={styles.systemDescription}>{system.description}</span>
                {providers.length > 0 && (
                  <div className={styles.chipRow}>
                    {providers.map((p) => {
                      const status = providerStatus[p];
                      const label = p === 'crm' ? 'CRM' : p === 'outlook' ? 'Outlook' : 'Gmail';
                      if (!status) return null;
                      return (
                        <Badge key={p} variant={status.connected ? 'success' : 'neutral'}>
                          {label}: {status.connected ? 'Connected' : 'Not connected'}
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </div>
              <Switch checked={enabled} onChange={(v) => toggleSystem(system.id, v)} />
            </div>
          </SectionCard>
        );
      })}
      <p className={styles.helperText}>
        A system with no connection shown works without a separate account (it uses your organization's internal data).
        Connect Outlook, Gmail, or CRM in Settings → Integrations if a badge above says "Not connected."
      </p>

      <SectionCard title="Who can use this agent" icon={FiUsers}>
        <p className={styles.stepIntro}>Leave both empty to make this agent visible to everyone in your organization.</p>
        <StringListEditor
          label="Visible to departments"
          items={form.assignedDepartments}
          onChange={(items) => update({ assignedDepartments: items })}
          addLabel="Add department"
        />
        <MultiSelectDropdown
          label="Visible to specific people"
          options={users.map((u) => ({ value: u.id, label: u.name }))}
          selected={form.assignedUserIds}
          onChange={(values) => update({ assignedUserIds: values })}
        />
      </SectionCard>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { FiGrid, FiUsers } from 'react-icons/fi';
import { Badge, MultiSelectDropdown, SectionCard, StringListEditor, Switch } from '@/components/ui';
import { integrationsService } from '@/services/integrationsService';
import type { AdminUser } from '@/services/usersService';
import { defaultToolsForSystem, isSystemEnabled, TOOL_SYSTEMS } from '../toolCatalog';
import type { FormState } from '../formState';
import { APP_FEATURES, BASIC_FEATURES_TEXT } from '@/utils/access';
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
  const [providerStatus, setProviderStatus] = useState<
    Record<'outlook' | 'gmail' | 'crm' | 'gorilladash' | 'zapier', ProviderStatus | null>
  >({
    outlook: null,
    gmail: null,
    crm: null,
    gorilladash: null,
    zapier: null,
  });

  useEffect(() => {
    let cancelled = false;
    void integrationsService
      .getOutlookStatus()
      .then((s) => {
        if (!cancelled)
          setProviderStatus((prev) => ({ ...prev, outlook: { connected: s.connected, label: s.email ?? '' } }));
      })
      .catch(() => undefined);
    void integrationsService
      .getGmailStatus()
      .then((s) => {
        if (!cancelled)
          setProviderStatus((prev) => ({ ...prev, gmail: { connected: s.connected, label: s.email ?? '' } }));
      })
      .catch(() => undefined);
    void integrationsService
      .getCredentialStatus('crm')
      .then((s) => {
        if (!cancelled) setProviderStatus((prev) => ({ ...prev, crm: { connected: s.connected, label: '' } }));
      })
      .catch(() => undefined);
    void integrationsService
      .getCredentialStatus('gorilladash')
      .then((s) => {
        if (!cancelled) setProviderStatus((prev) => ({ ...prev, gorilladash: { connected: s.connected, label: '' } }));
      })
      .catch(() => undefined);
    void integrationsService
      .getCredentialStatus('zapier')
      .then((s) => {
        if (!cancelled) setProviderStatus((prev) => ({ ...prev, zapier: { connected: s.connected, label: '' } }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const providersUsed = (systemId: string): ('outlook' | 'gmail' | 'crm' | 'gorilladash' | 'zapier')[] => {
    const system = TOOL_SYSTEMS.find((s) => s.id === systemId);
    const set = new Set<'outlook' | 'gmail' | 'crm' | 'gorilladash' | 'zapier'>();
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
                      const label =
                        p === 'crm'
                          ? 'Pantheras CRM'
                          : p === 'outlook'
                            ? 'Outlook'
                            : p === 'gorilladash'
                              ? 'Gorilla Dash'
                              : p === 'zapier'
                                ? 'Zapier'
                                : 'Gmail';
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

      <SectionCard title="What people with this role can use" icon={FiGrid}>
        <p className={styles.stepIntro}>
          When you create a user and give them this AI role, they sign in with their own account and get:{' '}
          {BASIC_FEATURES_TEXT}. Switch on anything else they should have.
        </p>
        {APP_FEATURES.map((feature) => (
          <div key={feature.id} className={styles.systemHeader}>
            <div className={styles.systemHeaderLeft}>
              <strong>{feature.label}</strong>
              <span className={styles.systemDescription}>{feature.description}</span>
            </div>
            <Switch
              checked={form.features.includes(feature.id)}
              ariaLabel={feature.label}
              onChange={(on) =>
                update({
                  features: on
                    ? [...new Set([...form.features, feature.id])]
                    : form.features.filter((f) => f !== feature.id),
                })
              }
            />
          </div>
        ))}
      </SectionCard>

      <SectionCard title="Who can use this agent" icon={FiUsers}>
        <p className={styles.stepIntro}>
          Leave both empty to make this agent visible to everyone in your organization.
        </p>
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

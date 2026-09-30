import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Modal, Switch } from '@/components/ui';
import { useDataSources } from '@/hooks/useDataSources';
import { dataSourcesService } from '@/services/dataSourcesService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './CustomizeDashboardModal.module.css';

// Each person chooses which metrics their dashboard shows. Metrics the
// selected CRM can't provide are listed too (with why), so it's clear the gap
// is the CRM's, not a setting.
export function CustomizeDashboardModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data } = useDataSources();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setHidden(new Set(data?.hiddenMetrics ?? []));
  }, [open, data?.hiddenMetrics]);

  const toggle = (id: string, visible: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      await dataSourcesService.setHiddenMetrics([...hidden]);
      await queryClient.invalidateQueries({ queryKey: ['data-sources'] });
      toast.success('Dashboard updated');
      onClose();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const groups: Array<{ title: string; kind: 'crm' | 'email' }> = [
    { title: 'Sales & CRM', kind: 'crm' },
    { title: 'Email', kind: 'email' },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Customize your dashboard"
      description="Choose the metrics you want to see. Only you see this change."
      maxWidth={560}
    >
      <div className={styles.body}>
        {groups.map((group) => {
          const metrics = (data?.metrics ?? []).filter((m) => m.kind === group.kind);
          if (metrics.length === 0) return null;
          return (
            <section key={group.kind} className={styles.group}>
              <h3 className={styles.groupTitle}>{group.title}</h3>
              <ul className={styles.list}>
                {metrics.map((m) => (
                  <li key={m.id} className={styles.row}>
                    <div className={styles.rowText}>
                      <span className={styles.rowLabel}>{m.label}</span>
                      <span className={styles.rowMeta}>
                        {m.status === 'supported' ? `From ${m.sources.join(' + ')}` : m.reason}
                      </span>
                    </div>
                    <Switch
                      checked={!hidden.has(m.id)}
                      onChange={(v) => toggle(m.id, v)}
                      ariaLabel={`Show ${m.label}`}
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={() => setHidden(new Set())}>
          Show everything
        </Button>
        <Button type="button" loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Modal>
  );
}

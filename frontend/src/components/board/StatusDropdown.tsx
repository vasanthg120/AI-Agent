import { useState } from 'react';
import { FiEdit2 } from 'react-icons/fi';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/stores/authStore';
import { statusDefinitionsService, type StatusDefinition } from '@/services/statusDefinitionsService';
import { extractErrorMessage } from '@/utils/errors';
import { ConfirmDialog } from './ConfirmDialog';
import styles from './StatusDropdown.module.css';

export interface StatusDropdownProps {
  field: string;
  value?: string;
  options: StatusDefinition[];
  disabled?: boolean;
  onChange: (key: string) => void;
  'aria-label': string;
}

// A status <select> colored from the org's own StatusDefinition rows, with
// an inline "Edit statuses" affordance for owner/admin — the same
// "Edit Statuses" link every status dropdown carries in the Hoops
// reference. Relabeling only changes label/color (see
// backend/src/status-definitions): it can never invent a status this
// dropdown's `options` doesn't already list.
export function StatusDropdown({ field, value, options, disabled, onChange, ...rest }: StatusDropdownProps) {
  const canManage = useAuthStore((s) => !!s.user?.roles.some((r) => r === 'owner' || r === 'admin'));
  const [editing, setEditing] = useState(false);
  const current = options.find((o) => o.key === value);

  return (
    <div className={styles.wrap}>
      <select
        aria-label={rest['aria-label']}
        className={styles.select}
        style={current?.color ? ({ '--status-color': current.color } as React.CSSProperties) : undefined}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {!value && <option value="">—</option>}
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      {canManage && (
        <button
          type="button"
          className={styles.editButton}
          title="Edit statuses"
          aria-label="Edit statuses"
          onClick={() => setEditing(true)}
        >
          <FiEdit2 aria-hidden />
        </button>
      )}
      {editing && <EditStatusesDialog field={field} options={options} onClose={() => setEditing(false)} />}
    </div>
  );
}

function EditStatusesDialog({
  field,
  options,
  onClose,
}: {
  field: string;
  options: StatusDefinition[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [labels, setLabels] = useState<Record<string, string>>(() =>
    Object.fromEntries(options.map((o) => [o.key, o.label])),
  );
  const [colors, setColors] = useState<Record<string, string>>(() =>
    Object.fromEntries(options.map((o) => [o.key, o.color ?? '#6b7280'])),
  );

  const save = useMutation({
    mutationFn: async () => {
      for (const o of options) {
        if (labels[o.key] !== o.label || colors[o.key] !== o.color) {
          await statusDefinitionsService.relabel(field, o.key, { label: labels[o.key], color: colors[o.key] });
        }
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['status-definitions', field] });
      toast.success('Statuses updated');
      onClose();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  return (
    <ConfirmDialog
      open
      title="Edit statuses"
      description="Change how each existing status is labeled and colored."
      confirmLabel="Save"
      confirmLoading={save.isPending}
      onConfirm={() => save.mutate()}
      onCancel={onClose}
    >
      <div className={styles.editList}>
        {options.map((o) => (
          <div key={o.key} className={styles.editRow}>
            <input
              type="color"
              aria-label={`Color for ${o.label}`}
              className={styles.colorInput}
              value={colors[o.key]}
              onChange={(e) => setColors((c) => ({ ...c, [o.key]: e.target.value }))}
            />
            <input
              type="text"
              aria-label={`Label for ${o.key}`}
              className={styles.labelInput}
              value={labels[o.key]}
              maxLength={60}
              onChange={(e) => setLabels((l) => ({ ...l, [o.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
    </ConfirmDialog>
  );
}

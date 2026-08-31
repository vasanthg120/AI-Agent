import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiPlus } from 'react-icons/fi';
import { Badge, Button, Input, Modal, Skeleton, Switch } from '@/components/ui';
import { billingCatalogAdminService, type AdminEntitlement } from '@/services/billingCatalogAdminService';
import { extractErrorMessage } from '@/utils/errors';
import shared from '../adminShared.module.css';

const emptyForm = { key: '', name: '', type: 'boolean' as 'boolean' | 'numeric', description: '', active: true };

// Phase 0 of the ChatGPT-style entitlements migration — the catalog editor
// for "what can an org access", distinct from Features (a plain display
// label). Mirrors AdminFeaturesPage.tsx's exact create/edit shape; the sole
// difference is the immutable `type` picker at create time (see
// entitlement.schema.ts's comment on why type can't change after creation).
export function AdminEntitlementsPage() {
  const [entitlements, setEntitlements] = useState<AdminEntitlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AdminEntitlement | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    billingCatalogAdminService
      .listEntitlements()
      .then(setEntitlements)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setModalOpen(true);
  };

  const openEdit = (entitlement: AdminEntitlement) => {
    setEditing(entitlement);
    setForm({ key: entitlement.key, name: entitlement.name, type: entitlement.type, description: entitlement.description ?? '', active: entitlement.active });
    setModalOpen(true);
  };

  const submit = async () => {
    if (!form.key.trim() || !form.name.trim()) {
      toast.error('Key and name are required.');
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await billingCatalogAdminService.updateEntitlement(editing._id, {
          name: form.name,
          description: form.description || undefined,
          active: form.active,
        });
        toast.success('Entitlement updated.');
      } else {
        await billingCatalogAdminService.createEntitlement({
          key: form.key.trim(),
          name: form.name,
          type: form.type,
          description: form.description || undefined,
          active: form.active,
        });
        toast.success('Entitlement created.');
      }
      setModalOpen(false);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Entitlements</h1>
          <p className={shared.pageSubtitle}>
            The catalog of "can this org access feature X" capabilities a plan's Entitlements tab grants — boolean on/off, or numeric with a usage cap.
          </p>
        </div>
        <Button leftIcon={<FiPlus />} onClick={openCreate}>
          New Entitlement
        </Button>
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5}>
                  <Skeleton height={20} />
                </td>
              </tr>
            )}
            {!loading && entitlements.length === 0 && (
              <tr>
                <td colSpan={5} className={shared.emptyState}>
                  No entitlements yet — create one to start assigning it to plans.
                </td>
              </tr>
            )}
            {!loading &&
              entitlements.map((e) => (
                <tr key={e._id}>
                  <td className={shared.mono}>{e.key}</td>
                  <td>{e.name}</td>
                  <td>{e.type}</td>
                  <td>
                    <Badge variant={e.active ? 'success' : 'neutral'}>{e.active ? 'active' : 'inactive'}</Badge>
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => openEdit(e)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Entitlement' : 'New Entitlement'}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Input
            label="Key"
            value={form.key}
            disabled={!!editing}
            onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
            placeholder="monthly_usage_limit"
          />
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Monthly Usage Limit" />
          <div>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, display: 'block', marginBottom: 'var(--space-1)' }}>Type</span>
            <select
              value={form.type}
              disabled={!!editing}
              onChange={(e) => setForm({ ...form, type: e.target.value as 'boolean' | 'numeric' })}
              style={{ height: 44, padding: '0 8px', width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-bg-input)', color: 'var(--color-text-primary)' }}
            >
              <option value="boolean">Boolean (on/off)</option>
              <option value="numeric">Numeric (usage cap)</option>
            </select>
            {editing && <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', margin: 'var(--space-1) 0 0' }}>Type can&apos;t change after creation.</p>}
          </div>
          <Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Switch checked={form.active} onChange={(active) => setForm({ ...form, active })} label="Active" />
          <Button fullWidth loading={submitting} onClick={submit}>
            {editing ? 'Save Changes' : 'Create Entitlement'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

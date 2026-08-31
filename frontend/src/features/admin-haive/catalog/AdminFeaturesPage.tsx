import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiPlus } from 'react-icons/fi';
import { Badge, Button, Input, Modal, Skeleton, Switch } from '@/components/ui';
import { billingCatalogAdminService, type AdminFeature } from '@/services/billingCatalogAdminService';
import { extractErrorMessage } from '@/utils/errors';
import shared from '../adminShared.module.css';

const emptyForm = { key: '', name: '', description: '', category: '', active: true };

export function AdminFeaturesPage() {
  const [features, setFeatures] = useState<AdminFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AdminFeature | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    billingCatalogAdminService
      .listFeatures()
      .then(setFeatures)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setModalOpen(true);
  };

  const openEdit = (feature: AdminFeature) => {
    setEditing(feature);
    setForm({ key: feature.key, name: feature.name, description: feature.description ?? '', category: feature.category ?? '', active: feature.active });
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
        await billingCatalogAdminService.updateFeature(editing._id, {
          name: form.name,
          description: form.description || undefined,
          category: form.category || undefined,
          active: form.active,
        });
        toast.success('Feature updated.');
      } else {
        await billingCatalogAdminService.createFeature({
          key: form.key.trim(),
          name: form.name,
          description: form.description || undefined,
          category: form.category || undefined,
          active: form.active,
        });
        toast.success('Feature created.');
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
          <h1 className={shared.pageTitle}>Features</h1>
          <p className={shared.pageSubtitle}>The catalog of feature labels a plan's feature grants reference by key.</p>
        </div>
        <Button leftIcon={<FiPlus />} onClick={openCreate}>
          New Feature
        </Button>
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Category</th>
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
            {!loading && features.length === 0 && (
              <tr>
                <td colSpan={5} className={shared.emptyState}>
                  No features yet — create one to start assigning it to plans.
                </td>
              </tr>
            )}
            {!loading &&
              features.map((f) => (
                <tr key={f._id}>
                  <td className={shared.mono}>{f.key}</td>
                  <td>{f.name}</td>
                  <td>{f.category ?? '—'}</td>
                  <td>
                    <Badge variant={f.active ? 'success' : 'neutral'}>{f.active ? 'active' : 'inactive'}</Badge>
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => openEdit(f)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Feature' : 'New Feature'}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Input label="Key" value={form.key} disabled={!!editing} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase().replace(/\s+/g, '_') })} placeholder="AI_CHAT" />
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="AI Chat" />
          <Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Input label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Core" />
          <Switch checked={form.active} onChange={(active) => setForm({ ...form, active })} label="Active" />
          <Button fullWidth loading={submitting} onClick={submit}>
            {editing ? 'Save Changes' : 'Create Feature'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

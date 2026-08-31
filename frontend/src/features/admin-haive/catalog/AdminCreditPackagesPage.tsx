import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiPlus } from 'react-icons/fi';
import { Badge, Button, Input, Modal, Skeleton, Switch } from '@/components/ui';
import { billingCatalogAdminService, type AdminCreditPackage } from '@/services/billingCatalogAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatCurrency } from '@/utils/currency';
import shared from '../adminShared.module.css';

const emptyForm = { key: '', name: '', credits: '', bonusCredits: '', price: '', currency: 'INR', active: true };

// This catalog is the ONLY source for the customer Billing page's "Add
// Credits" modal (GET /billing/packages) — there is no static/hardcoded
// fallback anymore. Nothing shows there until a package is created here.
export function AdminCreditPackagesPage() {
  const [packages, setPackages] = useState<AdminCreditPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AdminCreditPackage | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    billingCatalogAdminService
      .listPackages()
      .then(setPackages)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setModalOpen(true);
  };

  const openEdit = (pkg: AdminCreditPackage) => {
    setEditing(pkg);
    setForm({
      key: pkg.key,
      name: pkg.name,
      credits: String(pkg.credits),
      bonusCredits: String(pkg.bonusCredits),
      price: String(pkg.price),
      currency: pkg.currency,
      active: pkg.active,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    if (!form.key.trim() || !form.name.trim() || !form.credits || !form.price || !form.currency.trim()) {
      toast.error('Key, name, credits, price, and currency are required.');
      return;
    }
    setSubmitting(true);
    const payload = {
      name: form.name,
      credits: Number.parseInt(form.credits, 10),
      bonusCredits: form.bonusCredits ? Number.parseInt(form.bonusCredits, 10) : 0,
      price: Number.parseFloat(form.price),
      currency: form.currency.toUpperCase(),
      active: form.active,
    };
    try {
      if (editing) {
        await billingCatalogAdminService.updatePackage(editing._id, payload);
        toast.success('Credit package updated.');
      } else {
        await billingCatalogAdminService.createPackage({ ...payload, key: form.key.trim() });
        toast.success('Credit package created — it will now appear in Add Credits.');
      }
      setModalOpen(false);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (pkg: AdminCreditPackage) => {
    try {
      if (pkg.active) await billingCatalogAdminService.deactivatePackage(pkg._id);
      else await billingCatalogAdminService.activatePackage(pkg._id);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Credit Packages</h1>
          <p className={shared.pageSubtitle}>What customers see in "Add Credits" — nothing here is hardcoded; empty until you create one.</p>
        </div>
        <Button leftIcon={<FiPlus />} onClick={openCreate}>
          New Package
        </Button>
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Package</th>
              <th>Credits</th>
              <th>Bonus</th>
              <th>Price</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6}>
                  <Skeleton height={20} />
                </td>
              </tr>
            )}
            {!loading && packages.length === 0 && (
              <tr>
                <td colSpan={6} className={shared.emptyState}>
                  No credit packages yet — customers see an empty "Add Credits" list until you create one.
                </td>
              </tr>
            )}
            {!loading &&
              packages.map((pkg) => (
                <tr key={pkg._id}>
                  <td>
                    <div>{pkg.name}</div>
                    <div className={shared.mono}>{pkg.key}</div>
                  </td>
                  <td>{pkg.credits.toLocaleString()}</td>
                  <td>{pkg.bonusCredits > 0 ? `+${pkg.bonusCredits.toLocaleString()}` : '—'}</td>
                  <td>{formatCurrency(pkg.price, pkg.currency)}</td>
                  <td>
                    <Badge variant={pkg.active ? 'success' : 'neutral'}>{pkg.active ? 'active' : 'inactive'}</Badge>
                  </td>
                  <td style={{ display: 'flex', gap: 8 }}>
                    <Button size="sm" variant="secondary" onClick={() => openEdit(pkg)}>
                      Edit
                    </Button>
                    <Button size="sm" variant={pkg.active ? 'danger' : 'secondary'} onClick={() => toggleActive(pkg)}>
                      {pkg.active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Credit Package' : 'New Credit Package'}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Input label="Key" value={form.key} disabled={!!editing} onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase().replace(/\s+/g, '_') })} placeholder="starter" />
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Starter" />
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Input label="Credits" type="number" min={1} value={form.credits} onChange={(e) => setForm({ ...form, credits: e.target.value })} />
            <Input label="Bonus credits (optional)" type="number" min={0} value={form.bonusCredits} onChange={(e) => setForm({ ...form, bonusCredits: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Input label="Price" type="number" min={0} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            <Input label="Currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} placeholder="INR" />
          </div>
          <Switch checked={form.active} onChange={(active) => setForm({ ...form, active })} label="Active" />
          <Button fullWidth loading={submitting} onClick={submit}>
            {editing ? 'Save Changes' : 'Create Package'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

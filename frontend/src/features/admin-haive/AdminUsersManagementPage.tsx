import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiPlus } from 'react-icons/fi';
import { Badge, Button, Input, Modal, Skeleton } from '@/components/ui';
import { adminAccountsService } from '@/services/adminAccountsService';
import type { AdminAccount } from '@/services/adminAuthService';
import { extractErrorMessage } from '@/utils/errors';
import { useAdminAuthStore } from '@/stores/adminAuthStore';
import shared from './adminShared.module.css';

const emptyForm = { email: '', password: '', name: '' };

// Admin accounts are now their own credential (see AdminAccount schema) —
// there's no "promote an existing customer" step anymore. This page creates
// and manages those accounts directly.
export function AdminUsersManagementPage() {
  const currentAdminId = useAdminAuthStore((state) => state.admin?.id);
  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    adminAccountsService
      .list()
      .then(setAdmins)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openCreate = () => {
    setForm(emptyForm);
    setModalOpen(true);
  };

  const create = async () => {
    if (!form.email.trim() || !form.password || !form.name.trim()) {
      toast.error('Email, password, and name are required.');
      return;
    }
    setSubmitting(true);
    try {
      await adminAccountsService.create(form);
      toast.success('Admin account created.');
      setModalOpen(false);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (account: AdminAccount) => {
    setBusyId(account.id);
    try {
      await adminAccountsService.setActive(account.id, !account.active);
      toast.success(account.active ? `Deactivated ${account.name}.` : `Reactivated ${account.name}.`);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Admin Users</h1>
          <p className={shared.pageSubtitle}>Every account that can sign in to this panel — a separate credential from any customer login.</p>
        </div>
        <Button leftIcon={<FiPlus />} onClick={openCreate}>
          Create Admin
        </Button>
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4}>
                  <Skeleton height={20} />
                </td>
              </tr>
            )}
            {!loading &&
              admins.map((account) => (
                <tr key={account.id}>
                  <td>{account.name}</td>
                  <td>{account.email}</td>
                  <td>
                    <Badge variant={account.active ? 'success' : 'neutral'}>{account.active ? 'active' : 'inactive'}</Badge>
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant={account.active ? 'danger' : 'secondary'}
                      disabled={account.id === currentAdminId}
                      loading={busyId === account.id}
                      onClick={() => toggleActive(account)}
                    >
                      {account.id === currentAdminId ? 'That’s you' : account.active ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Create admin account" description="A separate login, not tied to any customer account.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" autoFocus />
          <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@haive.ai" />
          <Input
            label="Password"
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            hint="At least 8 characters."
          />
          <Button fullWidth loading={submitting} onClick={create}>
            Create Admin
          </Button>
        </div>
      </Modal>
    </div>
  );
}

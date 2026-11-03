import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiAlertTriangle } from 'react-icons/fi';
import { ConfirmDialog } from '@/components/board';
import { Badge, Input } from '@/components/ui';
import { customersService, type Customer, type CreateCustomerPayload } from '@/services/customersService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './add-customer-modal.module.css';

export interface AddCustomerModalProps {
  onClose: () => void;
  onCreated: (customer: Customer) => void;
}

// Phase 3 — "Add Customer". Creates a real crm_contacts record (see
// customer-directory.service.ts's createCustomer) — the same collection a
// CRM sync writes to, so this new customer behaves exactly like a synced
// one everywhere else. When the email/phone/company looks like an existing
// customer, the backend hands back that match instead of creating one;
// this shows it and lets the admin open it or confirm a second, separate
// customer anyway.
export function AddCustomerModal({ onClose, onCreated }: AddCustomerModalProps) {
  const [form, setForm] = useState<CreateCustomerPayload>({ name: '', company: '', email: '', phone: '', repUserId: '' });
  const [duplicate, setDuplicate] = useState<Customer | null>(null);

  const repsQuery = useQuery({ queryKey: ['customers', 'reps'], queryFn: () => customersService.listReps() });

  const create = useMutation({
    mutationFn: (confirmDuplicate: boolean) =>
      customersService.create({
        name: form.name.trim(),
        company: form.company?.trim() || undefined,
        email: form.email?.trim() || undefined,
        phone: form.phone?.trim() || undefined,
        repUserId: form.repUserId || undefined,
        confirmDuplicate,
      }),
    onSuccess: (result) => {
      if (result.duplicate) {
        setDuplicate(result.duplicate);
        return;
      }
      toast.success(`${result.created!.name} added`);
      onCreated(result.created!);
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  return (
    <ConfirmDialog
      open
      title="Add customer"
      confirmLabel={duplicate ? 'Create anyway' : 'Add customer'}
      confirmLoading={create.isPending}
      onConfirm={() => create.mutate(!!duplicate)}
      onCancel={onClose}
    >
      <div className={styles.form}>
        <Input
          label="Name"
          value={form.name}
          maxLength={200}
          autoFocus
          onChange={(e) => {
            setDuplicate(null);
            setForm((f) => ({ ...f, name: e.target.value }));
          }}
        />
        <Input
          label="Company"
          value={form.company ?? ''}
          maxLength={200}
          onChange={(e) => {
            setDuplicate(null);
            setForm((f) => ({ ...f, company: e.target.value }));
          }}
        />
        <div className={styles.row}>
          <Input
            label="Email"
            type="email"
            value={form.email ?? ''}
            onChange={(e) => {
              setDuplicate(null);
              setForm((f) => ({ ...f, email: e.target.value }));
            }}
          />
          <Input
            label="Phone"
            value={form.phone ?? ''}
            maxLength={40}
            onChange={(e) => {
              setDuplicate(null);
              setForm((f) => ({ ...f, phone: e.target.value }));
            }}
          />
        </div>
        <label className={styles.selectField}>
          <span>Customer rep</span>
          <select value={form.repUserId ?? ''} onChange={(e) => setForm((f) => ({ ...f, repUserId: e.target.value }))}>
            <option value="">Unassigned</option>
            {repsQuery.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>

        {duplicate && (
          <div className={styles.duplicate}>
            <FiAlertTriangle aria-hidden />
            <div>
              <strong>This looks like an existing customer</strong>
              <p>
                <Badge variant="warning">{duplicate.name}</Badge>
                {duplicate.company && ` · ${duplicate.company}`}
                {duplicate.email && ` · ${duplicate.email}`}
                {duplicate.phone && ` · ${duplicate.phone}`}
              </p>
              <p className={styles.hint}>Open the existing customer instead, or press "Create anyway" to add a separate one.</p>
              <button type="button" className={styles.openExisting} onClick={() => onCreated(duplicate)}>
                Open {duplicate.name}
              </button>
            </div>
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

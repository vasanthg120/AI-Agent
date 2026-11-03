import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/board';
import { Input } from '@/components/ui';
import { customersService, type Customer, type UpdateCustomerPayload } from '@/services/customersService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './add-customer-modal.module.css';

export interface EditCustomerModalProps {
  customer: Customer;
  onClose: () => void;
  onUpdated: () => void;
}

// Phase 3 — "Edit customer". Corrects name/email/phone/company and the
// assigned rep (customer-directory.service.ts's updateCustomer) — never
// touches which records belong to this customer, only how it displays.
export function EditCustomerModal({ customer, onClose, onUpdated }: EditCustomerModalProps) {
  const [form, setForm] = useState<UpdateCustomerPayload>({
    name: customer.name,
    company: customer.company ?? '',
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    repUserId: customer.repUserId ?? '',
  });

  const repsQuery = useQuery({ queryKey: ['customers', 'reps'], queryFn: () => customersService.listReps() });

  const update = useMutation({
    mutationFn: () =>
      customersService.update(customer.id, {
        name: form.name?.trim() || undefined,
        company: form.company?.trim() ?? '',
        // The backend validates email as a real address when present (never
        // an empty string) — a blank box here means "leave it as is", not
        // "clear it", since there's no supported way to unset it.
        email: form.email?.trim() || undefined,
        phone: form.phone?.trim() ?? '',
        repUserId: form.repUserId ?? '',
      }),
    onSuccess: () => {
      toast.success('Customer updated');
      onUpdated();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  return (
    <ConfirmDialog
      open
      title="Edit customer"
      confirmLabel="Save"
      confirmLoading={update.isPending}
      onConfirm={() => update.mutate()}
      onCancel={onClose}
    >
      <div className={styles.form}>
        <Input label="Name" value={form.name ?? ''} maxLength={200} autoFocus onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <Input
          label="Company"
          value={form.company ?? ''}
          maxLength={200}
          onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
        />
        <div className={styles.row}>
          <Input label="Email" type="email" value={form.email ?? ''} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          <Input
            label="Phone"
            value={form.phone ?? ''}
            maxLength={40}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
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
      </div>
    </ConfirmDialog>
  );
}

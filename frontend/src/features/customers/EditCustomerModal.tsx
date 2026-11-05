import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2 } from 'react-icons/fi';
import { Button, IconButton, Input, Modal } from '@/components/ui';
import {
  customersService,
  type AddCustomerContactPayload,
  type CreateCustomerAddressPayload,
  type CustomerDetail,
  type CustomerRecordType,
  type UpdateCustomerPayload,
} from '@/services/customersService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './add-customer-modal.module.css';

export interface EditCustomerModalProps {
  customer: CustomerDetail;
  onClose: () => void;
  onUpdated: () => void;
}

const emptyContact: AddCustomerContactPayload = { name: '', email: '', phone: '', role: '' };
const emptyAddress: CreateCustomerAddressPayload = { type: 'billing', address: '', addressLine2: '', city: '', state: '' };

// Phase 3 (Hoops-parity extended) — "Edit customer". Corrects name/email/
// phone/company/customerType/website/industryType/markup/discount/profile
// note and the assigned rep in one PATCH (customer-directory.service.ts's
// updateCustomer) — never touches which records belong to this customer,
// only how it displays. Contacts and addresses save immediately through
// their own real endpoints (same ones addContact/addAddress already use
// elsewhere), not batched into this form's Save.
export function EditCustomerModal({ customer, onClose, onUpdated }: EditCustomerModalProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<UpdateCustomerPayload>({
    name: customer.name,
    company: customer.company ?? '',
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    repUserId: customer.repUserId ?? '',
    customerType: customer.customerType,
    website: customer.website ?? '',
    industryType: customer.industryType ?? '',
    minimumMarkupPct: customer.minimumMarkupPct,
    salesDiscountPct: customer.salesDiscountPct,
    profileNote: customer.profileNote ?? '',
  });
  const [newContact, setNewContact] = useState<AddCustomerContactPayload>({ ...emptyContact });
  const [newAddress, setNewAddress] = useState<CreateCustomerAddressPayload>({ ...emptyAddress });

  const repsQuery = useQuery({ queryKey: ['customers', 'reps'], queryFn: () => customersService.listReps() });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['customers'], exact: false, refetchType: 'active' });

  const isBusiness = form.customerType === 'business';

  const update = useMutation({
    mutationFn: () => {
      const num = (v: number | undefined) => v;
      return customersService.update(customer.id, {
        name: form.name?.trim() || undefined,
        company: form.company?.trim() ?? '',
        // The backend validates email as a real address when present (never
        // an empty string) — a blank box here means "leave it as is", not
        // "clear it", since there's no supported way to unset it.
        email: form.email?.trim() || undefined,
        phone: form.phone?.trim() ?? '',
        repUserId: form.repUserId ?? '',
        customerType: form.customerType,
        website: form.website ?? '',
        industryType: form.industryType ?? '',
        minimumMarkupPct: num(form.minimumMarkupPct),
        salesDiscountPct: num(form.salesDiscountPct),
        profileNote: form.profileNote ?? '',
      });
    },
    onSuccess: () => {
      toast.success('Customer updated');
      onUpdated();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const addContact = useMutation({
    mutationFn: () => customersService.addContact(customer.id, newContact),
    onSuccess: () => {
      toast.success('Contact added');
      setNewContact({ ...emptyContact });
      refresh();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });
  const removeContact = useMutation({
    mutationFn: (contactId: string) => customersService.removeContact(customer.id, contactId),
    onSuccess: () => {
      toast.success('Contact removed');
      refresh();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const addAddress = useMutation({
    mutationFn: () => customersService.addAddress(customer.id, newAddress),
    onSuccess: () => {
      toast.success('Address added');
      setNewAddress({ ...emptyAddress });
      refresh();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });
  const removeAddress = useMutation({
    mutationFn: (addressId: string) => customersService.removeAddress(customer.id, addressId),
    onSuccess: () => {
      toast.success('Address removed');
      refresh();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const manualContacts = customer.people.filter((p) => p.manual && p.id);

  return (
    <Modal open onClose={onClose} title="Edit customer" maxWidth={640}>
      <div className={styles.form}>
        <div className={styles.typeToggle} role="group" aria-label="Customer type">
          {(['business', 'individual'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={t === form.customerType ? `${styles.typeButton} ${styles.typeButtonActive}` : styles.typeButton}
              onClick={() => setForm((f) => ({ ...f, customerType: t as CustomerRecordType, ...(t === 'business' ? { company: f.name } : {}) }))}
            >
              {t === 'business' ? 'Business / Company' : 'Individual'}
            </button>
          ))}
        </div>

        <Input
          label={isBusiness ? 'Company Name' : 'Name'}
          value={form.name ?? ''}
          maxLength={200}
          autoFocus
          onChange={(e) =>
            setForm((f) => ({ ...f, name: e.target.value, ...(isBusiness ? { company: e.target.value } : {}) }))
          }
        />
        {/* A Business customer's name and company are the same value (see
            customer-directory.service.ts's row() — it clears `company` from
            the row entirely once it matches `name`, so Company Name above
            is the one field to edit, not two that silently drift apart). */}
        {!isBusiness && (
          <Input label="Company" value={form.company ?? ''} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} />
        )}
        <div className={styles.row}>
          <Input label="Email" type="email" value={form.email ?? ''} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          <Input label="Phone" value={form.phone ?? ''} maxLength={40} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
        </div>

        {isBusiness && (
          <>
            <div className={styles.row}>
              <Input label="Company Website" value={form.website ?? ''} maxLength={300} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} />
              <Input
                label="Industry Type"
                value={form.industryType ?? ''}
                maxLength={120}
                onChange={(e) => setForm((f) => ({ ...f, industryType: e.target.value }))}
              />
            </div>
            <div className={styles.row}>
              <Input
                label="Minimum Markup (%)"
                type="number"
                min={0}
                max={100}
                value={form.minimumMarkupPct ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, minimumMarkupPct: e.target.value === '' ? undefined : Number(e.target.value) }))}
              />
              <Input
                label="Sales Discount (%)"
                type="number"
                min={0}
                max={100}
                value={form.salesDiscountPct ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, salesDiscountPct: e.target.value === '' ? undefined : Number(e.target.value) }))}
              />
            </div>
            <label className={styles.textarea}>
              <span>Profile</span>
              <textarea value={form.profileNote ?? ''} maxLength={2000} onChange={(e) => setForm((f) => ({ ...f, profileNote: e.target.value }))} />
            </label>
          </>
        )}

        <label className={styles.selectField}>
          <span>Customer Rep</span>
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

      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onClose} disabled={update.isPending}>
          Cancel
        </Button>
        <Button type="button" loading={update.isPending} onClick={() => update.mutate()}>
          Save
        </Button>
      </div>

      <div className={styles.form} style={{ marginTop: 'var(--space-5)' }}>
        <div className={styles.sectionHead}>
          <strong>Contacts</strong>
        </div>
        {manualContacts.map((contact) => (
          <div key={contact.id} className={styles.repeaterRow}>
            <span>{contact.name}</span>
            <span>{contact.email ?? '—'}</span>
            <span>{contact.phone ?? '—'}</span>
            <span>{contact.role ?? '—'}</span>
            <IconButton
              icon={<FiTrash2 />}
              label={`Remove ${contact.name}`}
              disabled={removeContact.isPending}
              onClick={() => contact.id && removeContact.mutate(contact.id)}
            />
          </div>
        ))}
        <div className={styles.repeaterRow}>
          <Input label="First Name" value={newContact.name} onChange={(e) => setNewContact((c) => ({ ...c, name: e.target.value }))} />
          <Input label="Email" type="email" value={newContact.email ?? ''} onChange={(e) => setNewContact((c) => ({ ...c, email: e.target.value }))} />
          <Input label="Phone" value={newContact.phone ?? ''} onChange={(e) => setNewContact((c) => ({ ...c, phone: e.target.value }))} />
          <Input label="Role" value={newContact.role ?? ''} onChange={(e) => setNewContact((c) => ({ ...c, role: e.target.value }))} />
          <IconButton
            icon={<FiPlus />}
            label="Add contact"
            disabled={!newContact.name.trim() || addContact.isPending}
            onClick={() => addContact.mutate()}
          />
        </div>

        <div className={styles.sectionHead}>
          <strong>Address</strong>
        </div>
        {customer.addresses.map((addr) => (
          <div key={addr.id} className={styles.repeaterRow}>
            <span>{addr.type}</span>
            <span>{addr.address}</span>
            <span>{addr.city ?? '—'}</span>
            <span>{addr.state ?? '—'}</span>
            <IconButton
              icon={<FiTrash2 />}
              label="Remove address"
              disabled={removeAddress.isPending}
              onClick={() => removeAddress.mutate(addr.id)}
            />
          </div>
        ))}
        <div className={styles.repeaterRow}>
          <label className={styles.selectField}>
            <span>Address Type</span>
            <select
              value={newAddress.type}
              onChange={(e) => setNewAddress((a) => ({ ...a, type: e.target.value as CreateCustomerAddressPayload['type'] }))}
            >
              <option value="billing">Billing</option>
              <option value="shipping">Shipping</option>
              <option value="other">Other</option>
            </select>
          </label>
          <Input label="Address" value={newAddress.address} onChange={(e) => setNewAddress((a) => ({ ...a, address: e.target.value }))} />
          <Input label="City" value={newAddress.city ?? ''} onChange={(e) => setNewAddress((a) => ({ ...a, city: e.target.value }))} />
          <Input label="State" value={newAddress.state ?? ''} onChange={(e) => setNewAddress((a) => ({ ...a, state: e.target.value }))} />
          <IconButton
            icon={<FiPlus />}
            label="Add address"
            disabled={!newAddress.address.trim() || addAddress.isPending}
            onClick={() => addAddress.mutate()}
          />
        </div>
      </div>
    </Modal>
  );
}

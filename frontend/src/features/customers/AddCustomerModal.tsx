import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiAlertTriangle, FiPlus, FiTrash2 } from 'react-icons/fi';
import { Badge, Button, IconButton, Input, Modal } from '@/components/ui';
import {
  customersService,
  type AddCustomerContactPayload,
  type CreateCustomerAddressPayload,
  type Customer,
  type CustomerRecordType,
} from '@/services/customersService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './add-customer-modal.module.css';

export interface AddCustomerModalProps {
  onClose: () => void;
  onCreated: (customer: Customer) => void;
}

const emptyContact: AddCustomerContactPayload = { name: '', email: '', phone: '', role: '' };
const emptyAddress: CreateCustomerAddressPayload = { type: 'billing', address: '', addressLine2: '', city: '', state: '' };

interface FormState {
  customerType: CustomerRecordType;
  // Individual only.
  firstName: string;
  lastName: string;
  // Business: company name. Individual: unused (name = first + last).
  companyName: string;
  email: string;
  phone: string;
  website: string;
  industryType: string;
  minimumMarkupPct: string;
  salesDiscountPct: string;
  profileNote: string;
  repUserId: string;
  contacts: AddCustomerContactPayload[];
  addresses: CreateCustomerAddressPayload[];
}

const initialForm: FormState = {
  customerType: 'business',
  firstName: '',
  lastName: '',
  companyName: '',
  email: '',
  phone: '',
  website: '',
  industryType: '',
  minimumMarkupPct: '',
  salesDiscountPct: '',
  profileNote: '',
  repUserId: '',
  contacts: [],
  addresses: [],
};

// Phase 3 (Hoops-parity extended) — "Add Customer". Creates a real
// crm_contacts record (see customer-directory.service.ts's createCustomer)
// plus, inline, any contacts/addresses given — the same collection a CRM
// sync writes to, so this new customer behaves exactly like a synced one
// everywhere else. When the email/phone/company looks like an existing
// customer, the backend hands back that match instead of creating one;
// this shows it and lets the admin open it or confirm a second, separate
// customer anyway.
export function AddCustomerModal({ onClose, onCreated }: AddCustomerModalProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [duplicate, setDuplicate] = useState<Customer | null>(null);
  const repsQuery = useQuery({ queryKey: ['customers', 'reps'], queryFn: () => customersService.listReps() });

  const isBusiness = form.customerType === 'business';
  const nameValid = isBusiness ? form.companyName.trim().length > 0 : form.firstName.trim().length > 0;
  const emailValid = isBusiness || form.email.trim().length > 0;
  const canSave = nameValid && emailValid;

  const clearDup = () => setDuplicate(null);

  const create = useMutation({
    mutationFn: (confirmDuplicate: boolean) => {
      const name = isBusiness ? form.companyName.trim() : [form.firstName.trim(), form.lastName.trim()].filter(Boolean).join(' ');
      const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
      return customersService.create({
        name,
        company: isBusiness ? form.companyName.trim() : undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        repUserId: form.repUserId || undefined,
        confirmDuplicate,
        customerType: form.customerType,
        website: isBusiness ? form.website.trim() || undefined : undefined,
        industryType: isBusiness ? form.industryType.trim() || undefined : undefined,
        minimumMarkupPct: isBusiness ? num(form.minimumMarkupPct) : undefined,
        salesDiscountPct: isBusiness ? num(form.salesDiscountPct) : undefined,
        profileNote: isBusiness ? form.profileNote.trim() || undefined : undefined,
        addresses: form.addresses.filter((a) => a.address.trim()).length ? form.addresses.filter((a) => a.address.trim()) : undefined,
        contacts: isBusiness && form.contacts.filter((c) => c.name.trim()).length ? form.contacts.filter((c) => c.name.trim()) : undefined,
      });
    },
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
    <Modal open onClose={onClose} title="Add customer" maxWidth={640}>
      <div className={styles.form}>
        <div className={styles.typeToggle} role="group" aria-label="Customer type">
          {(['business', 'individual'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={t === form.customerType ? `${styles.typeButton} ${styles.typeButtonActive}` : styles.typeButton}
              onClick={() => setForm((f) => ({ ...f, customerType: t }))}
            >
              {t === 'business' ? 'Business / Company' : 'Individual'}
            </button>
          ))}
        </div>

        {isBusiness ? (
          <>
            <Input
              label="Company Name"
              required
              value={form.companyName}
              maxLength={200}
              error={!nameValid ? 'Required' : undefined}
              onChange={(e) => {
                clearDup();
                setForm((f) => ({ ...f, companyName: e.target.value }));
              }}
            />
            <div className={styles.row}>
              <Input label="Company Email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              <Input label="Company Phone" value={form.phone} maxLength={40} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className={styles.row}>
              <Input label="Company Website" value={form.website} maxLength={300} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} />
              <Input label="Industry Type" value={form.industryType} maxLength={120} onChange={(e) => setForm((f) => ({ ...f, industryType: e.target.value }))} />
            </div>
            <div className={styles.row}>
              <label className={styles.selectField}>
                <span>Customer Rep</span>
                <select value={form.repUserId} onChange={(e) => setForm((f) => ({ ...f, repUserId: e.target.value }))}>
                  <option value="">Unassigned</option>
                  {repsQuery.data?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                label="Minimum Markup (%)"
                type="number"
                min={0}
                max={100}
                value={form.minimumMarkupPct}
                onChange={(e) => setForm((f) => ({ ...f, minimumMarkupPct: e.target.value }))}
              />
              <Input
                label="Sales Discount (%)"
                type="number"
                min={0}
                max={100}
                value={form.salesDiscountPct}
                onChange={(e) => setForm((f) => ({ ...f, salesDiscountPct: e.target.value }))}
              />
            </div>
            <label className={styles.textarea}>
              <span>Profile</span>
              <textarea value={form.profileNote} maxLength={2000} onChange={(e) => setForm((f) => ({ ...f, profileNote: e.target.value }))} />
            </label>

            <div className={styles.sectionHead}>
              <strong>Contacts</strong>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                leftIcon={<FiPlus />}
                onClick={() => setForm((f) => ({ ...f, contacts: [...f.contacts, { ...emptyContact }] }))}
              >
                Add another contact
              </Button>
            </div>
            {form.contacts.map((contact, index) => (
              <div key={index} className={styles.repeaterRow}>
                <Input
                  label="First Name"
                  value={contact.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, contacts: f.contacts.map((c, i) => (i === index ? { ...c, name: e.target.value } : c)) }))
                  }
                />
                <Input
                  label="Email"
                  type="email"
                  value={contact.email ?? ''}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, contacts: f.contacts.map((c, i) => (i === index ? { ...c, email: e.target.value } : c)) }))
                  }
                />
                <Input
                  label="Phone"
                  value={contact.phone ?? ''}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, contacts: f.contacts.map((c, i) => (i === index ? { ...c, phone: e.target.value } : c)) }))
                  }
                />
                <Input
                  label="Role"
                  value={contact.role ?? ''}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, contacts: f.contacts.map((c, i) => (i === index ? { ...c, role: e.target.value } : c)) }))
                  }
                />
                <IconButton
                  icon={<FiTrash2 />}
                  label="Remove contact"
                  onClick={() => setForm((f) => ({ ...f, contacts: f.contacts.filter((_, i) => i !== index) }))}
                />
              </div>
            ))}
          </>
        ) : (
          <>
            <div className={styles.row}>
              <Input
                label="First Name"
                required
                value={form.firstName}
                maxLength={100}
                error={!nameValid ? 'Required' : undefined}
                onChange={(e) => {
                  clearDup();
                  setForm((f) => ({ ...f, firstName: e.target.value }));
                }}
              />
              <Input label="Last Name" value={form.lastName} maxLength={100} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
            <div className={styles.row}>
              <Input
                label="Email"
                required
                type="email"
                value={form.email}
                error={!emailValid ? 'Required' : undefined}
                onChange={(e) => {
                  clearDup();
                  setForm((f) => ({ ...f, email: e.target.value }));
                }}
              />
              <Input label="Phone" value={form.phone} maxLength={40} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <label className={styles.selectField}>
              <span>Customer Rep</span>
              <select value={form.repUserId} onChange={(e) => setForm((f) => ({ ...f, repUserId: e.target.value }))}>
                <option value="">Unassigned</option>
                {repsQuery.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <div className={styles.sectionHead}>
          <strong>Address</strong>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            leftIcon={<FiPlus />}
            onClick={() => setForm((f) => ({ ...f, addresses: [...f.addresses, { ...emptyAddress }] }))}
          >
            Add address
          </Button>
        </div>
        {form.addresses.map((addr, index) => (
          <div key={index} className={styles.repeaterRow}>
            <label className={styles.selectField}>
              <span>Address Type</span>
              <select
                value={addr.type}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    addresses: f.addresses.map((a, i) => (i === index ? { ...a, type: e.target.value as CreateCustomerAddressPayload['type'] } : a)),
                  }))
                }
              >
                <option value="billing">Billing</option>
                <option value="shipping">Shipping</option>
                <option value="other">Other</option>
              </select>
            </label>
            <Input
              label="Address"
              value={addr.address}
              onChange={(e) => setForm((f) => ({ ...f, addresses: f.addresses.map((a, i) => (i === index ? { ...a, address: e.target.value } : a)) }))}
            />
            <Input
              label="Address Line 2"
              value={addr.addressLine2 ?? ''}
              onChange={(e) =>
                setForm((f) => ({ ...f, addresses: f.addresses.map((a, i) => (i === index ? { ...a, addressLine2: e.target.value } : a)) }))
              }
            />
            <Input
              label="City"
              value={addr.city ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, addresses: f.addresses.map((a, i) => (i === index ? { ...a, city: e.target.value } : a)) }))}
            />
            <IconButton
              icon={<FiTrash2 />}
              label="Remove address"
              onClick={() => setForm((f) => ({ ...f, addresses: f.addresses.filter((_, i) => i !== index) }))}
            />
          </div>
        ))}

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

      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="button" loading={create.isPending} disabled={!canSave} onClick={() => create.mutate(!!duplicate)}>
          {duplicate ? 'Create anyway' : 'Add customer'}
        </Button>
      </div>
    </Modal>
  );
}

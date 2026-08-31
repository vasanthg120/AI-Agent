import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiPlus } from 'react-icons/fi';
import { Badge, Button, Input, Modal, Skeleton } from '@/components/ui';
import { billingCatalogAdminService, type AdminCoupon } from '@/services/billingCatalogAdminService';
import { extractErrorMessage } from '@/utils/errors';
import shared from '../adminShared.module.css';

const TYPES = ['percentage', 'fixed_amount', 'free_credits'] as const;
const APPLIES_TO = ['all', 'plans', 'packages'] as const;

const emptyForm = {
  code: '',
  type: 'percentage' as (typeof TYPES)[number],
  value: '',
  currencyCode: '',
  description: '',
  appliesTo: 'all' as (typeof APPLIES_TO)[number],
  validTo: '',
  maxRedemptions: '',
  maxRedemptionsPerOrg: '1',
};

// Discount/eligibility math is never recomputed here — this page only sends
// what CouponsService.validate needs to configure a coupon; the amount a
// customer actually sees is always server-computed at checkout time.
export function AdminCouponsPage() {
  const [coupons, setCoupons] = useState<AdminCoupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    billingCatalogAdminService
      .listCoupons()
      .then(setCoupons)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const submit = async () => {
    if (!form.code.trim() || !form.value) {
      toast.error('Code and value are required.');
      return;
    }
    if (form.type === 'fixed_amount' && !form.currencyCode.trim()) {
      toast.error('A fixed-amount coupon needs a currency code.');
      return;
    }
    setSubmitting(true);
    try {
      await billingCatalogAdminService.createCoupon({
        code: form.code.trim().toUpperCase(),
        type: form.type,
        value: Number.parseFloat(form.value),
        currencyCode: form.type === 'fixed_amount' ? form.currencyCode.toUpperCase() : undefined,
        description: form.description || undefined,
        appliesTo: form.appliesTo,
        validTo: form.validTo || undefined,
        maxRedemptions: form.maxRedemptions ? Number.parseInt(form.maxRedemptions, 10) : undefined,
        maxRedemptionsPerOrg: Number.parseInt(form.maxRedemptionsPerOrg, 10) || 1,
      });
      toast.success('Coupon created.');
      setModalOpen(false);
      setForm(emptyForm);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (coupon: AdminCoupon) => {
    try {
      if (coupon.active) await billingCatalogAdminService.deactivateCoupon(coupon._id);
      else await billingCatalogAdminService.activateCoupon(coupon._id);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Coupons</h1>
          <p className={shared.pageSubtitle}>Discount and bonus-credit codes — validated and applied server-side at checkout, never in the browser.</p>
        </div>
        <Button leftIcon={<FiPlus />} onClick={() => setModalOpen(true)}>
          New Coupon
        </Button>
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Type</th>
              <th>Value</th>
              <th>Applies To</th>
              <th>Redemption Limit</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7}>
                  <Skeleton height={20} />
                </td>
              </tr>
            )}
            {!loading && coupons.length === 0 && (
              <tr>
                <td colSpan={7} className={shared.emptyState}>
                  No coupons yet.
                </td>
              </tr>
            )}
            {!loading &&
              coupons.map((c) => (
                <tr key={c._id}>
                  <td className={shared.mono}>{c.code}</td>
                  <td>{c.type}</td>
                  <td>
                    {c.type === 'percentage' ? `${c.value}%` : c.type === 'fixed_amount' ? `${c.value} ${c.currencyCode}` : `+${c.value} credits`}
                  </td>
                  <td>{c.appliesTo}</td>
                  <td>{c.maxRedemptions ?? 'Unlimited'} total · {c.maxRedemptionsPerOrg}/org</td>
                  <td>
                    <Badge variant={c.active ? 'success' : 'neutral'}>{c.active ? 'active' : 'inactive'}</Badge>
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => toggleActive(c)}>
                      {c.active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Coupon">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Input label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="WELCOME20" />
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'var(--text-sm)', display: 'block', marginBottom: 6 }}>Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as (typeof TYPES)[number] })}
                style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-bg-input)', color: 'var(--color-text-primary)' }}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <Input
              label={form.type === 'percentage' ? 'Percentage' : form.type === 'fixed_amount' ? 'Amount' : 'Bonus credits'}
              type="number"
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
            />
          </div>
          {form.type === 'fixed_amount' && (
            <Input label="Currency" value={form.currencyCode} onChange={(e) => setForm({ ...form, currencyCode: e.target.value.toUpperCase() })} placeholder="INR" />
          )}
          <div>
            <label style={{ fontSize: 'var(--text-sm)', display: 'block', marginBottom: 6 }}>Applies to</label>
            <select
              value={form.appliesTo}
              onChange={(e) => setForm({ ...form, appliesTo: e.target.value as (typeof APPLIES_TO)[number] })}
              style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-bg-input)', color: 'var(--color-text-primary)' }}
            >
              {APPLIES_TO.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <Input label="Expires (optional)" type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Input label="Max total redemptions" type="number" value={form.maxRedemptions} onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} placeholder="Unlimited" />
            <Input label="Max per organization" type="number" value={form.maxRedemptionsPerOrg} onChange={(e) => setForm({ ...form, maxRedemptionsPerOrg: e.target.value })} />
          </div>
          <Button fullWidth loading={submitting} onClick={submit}>
            Create Coupon
          </Button>
        </div>
      </Modal>
    </div>
  );
}

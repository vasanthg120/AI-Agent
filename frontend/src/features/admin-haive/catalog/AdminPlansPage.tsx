import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiArchive, FiCheckCircle, FiChevronDown, FiChevronUp, FiPlus, FiTrash2 } from 'react-icons/fi';
import { Badge, Button, Input, Modal, Skeleton, Switch, Tabs } from '@/components/ui';
import {
  billingCatalogAdminService,
  type AdminEntitlement,
  type AdminEntitlementGrant,
  type AdminFeature,
  type AdminFeatureGrant,
  type AdminLimitGrant,
  type AdminPlan,
  type AdminPlanPrice,
} from '@/services/billingCatalogAdminService';
import { extractErrorMessage } from '@/utils/errors';
import shared from '../adminShared.module.css';

const BILLING_CYCLES = ['monthly', 'yearly', 'weekly', 'quarterly', 'one_time'];

const emptyForm = {
  key: '',
  name: '',
  shortDescription: '',
  description: '',
  trialDays: '',
  active: true,
  isPublic: true,
  recommended: false,
};

export function AdminPlansPage() {
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [features, setFeatures] = useState<AdminFeature[]>([]);
  const [entitlementCatalog, setEntitlementCatalog] = useState<AdminEntitlement[]>([]);
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AdminPlan | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminPlan | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [featureGrants, setFeatureGrants] = useState<AdminFeatureGrant[]>([]);
  const [limitGrants, setLimitGrants] = useState<AdminLimitGrant[]>([]);
  const [entitlementGrants, setEntitlementGrants] = useState<AdminEntitlementGrant[]>([]);
  const [prices, setPrices] = useState<AdminPlanPrice[]>([]);
  const [newPrice, setNewPrice] = useState({ currencyCode: 'INR', billingCycle: 'monthly', amount: '', creditsGranted: '' });
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'features' | 'entitlements' | 'prices'>('details');
  // 'simple' is the default create experience — one screen (price, currency,
  // cycle, credits, feature checkboxes, active) instead of the 3-tab
  // Details/Features & Limits/Prices editor. Nothing is removed: 'advanced'
  // still exposes the exact same full editor for multi-currency pricing,
  // trial days, and usage limits.
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');

  const load = () => {
    setLoading(true);
    Promise.all([billingCatalogAdminService.listPlans(), billingCatalogAdminService.listFeatures(), billingCatalogAdminService.listEntitlements()])
      .then(([p, f, e]) => {
        setPlans(p);
        setFeatures(f);
        setEntitlementCatalog(e);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setFeatureGrants([]);
    setLimitGrants([]);
    setEntitlementGrants([]);
    setPrices([]);
    setNewPrice({ currencyCode: 'INR', billingCycle: 'monthly', amount: '', creditsGranted: '' });
    setActiveTab('details');
    setMode('simple');
    setModalOpen(true);
  };

  const openEdit = async (plan: AdminPlan) => {
    setEditing(plan);
    setActiveTab('details');
    // Editing jumps straight to the full editor — an existing plan may
    // already have multiple prices or limits worth seeing, unlike a brand
    // new plan where the simple one-screen form is the common case.
    setMode('advanced');
    setForm({
      key: plan.key,
      name: plan.name,
      shortDescription: plan.shortDescription ?? '',
      description: plan.description ?? '',
      trialDays: plan.trialDays?.toString() ?? '',
      active: plan.active,
      isPublic: plan.isPublic,
      recommended: plan.recommended,
    });
    setFeatureGrants(plan.features);
    setLimitGrants(plan.limits);
    setEntitlementGrants(plan.entitlements ?? []);
    setModalOpen(true);
    try {
      setPrices(await billingCatalogAdminService.listPrices(plan._id));
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const toggleFeature = (featureKey: string, enabled: boolean) => {
    setFeatureGrants((prev) => {
      const existing = prev.find((g) => g.featureKey === featureKey);
      if (existing) return prev.map((g) => (g.featureKey === featureKey ? { ...g, enabled } : g));
      return [...prev, { featureKey, enabled }];
    });
  };

  const addLimit = () => setLimitGrants((prev) => [...prev, { limitKey: '', unlimited: false, value: 0 }]);
  const updateLimit = (index: number, patch: Partial<AdminLimitGrant>) =>
    setLimitGrants((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const removeLimit = (index: number) => setLimitGrants((prev) => prev.filter((_, i) => i !== index));

  // Boolean entitlement: enabled toggles the grant on/off, no value.
  // Numeric entitlement: enabled gates the grant; value is the plan's cap
  // for that period (omitted means unlimited) — see billing-plan.schema.ts's
  // BillingPlanEntitlementGrant comment.
  const toggleEntitlement = (key: string, enabled: boolean) => {
    setEntitlementGrants((prev) => {
      const existing = prev.find((g) => g.key === key);
      if (existing) return prev.map((g) => (g.key === key ? { ...g, enabled } : g));
      return [...prev, { key, enabled }];
    });
  };
  const setEntitlementValue = (key: string, value: number | undefined) => {
    setEntitlementGrants((prev) => {
      const existing = prev.find((g) => g.key === key);
      if (existing) return prev.map((g) => (g.key === key ? { ...g, value } : g));
      return [...prev, { key, enabled: true, value }];
    });
  };

  const submit = async () => {
    if (!form.key.trim() || !form.name.trim()) {
      toast.error('Key and name are required.');
      return;
    }
    setSubmitting(true);
    // key is immutable after creation — UpdateBillingPlanDto deliberately
    // excludes it (see that file's comment), and the app's global
    // ValidationPipe rejects unknown properties, so it must never be sent
    // on an update.
    const commonFields = {
      name: form.name,
      shortDescription: form.shortDescription || undefined,
      description: form.description || undefined,
      trialDays: form.trialDays ? Number.parseInt(form.trialDays, 10) : undefined,
      active: form.active,
      isPublic: form.isPublic,
      recommended: form.recommended,
      features: featureGrants,
      limits: limitGrants.filter((l) => l.limitKey.trim()),
      entitlements: entitlementGrants,
    };
    try {
      if (editing) {
        await billingCatalogAdminService.updatePlan(editing._id, commonFields);
        toast.success('Plan updated.');
      } else {
        const created = await billingCatalogAdminService.createPlan({ key: form.key.trim(), ...commonFields });
        // Simple mode collapses "create plan" + "add its first price" into
        // one button click — addPrice still requires a saved plan id, so
        // this chains the exact same two existing calls the Advanced Prices
        // tab makes separately, right after createPlan resolves.
        if (mode === 'simple' && newPrice.amount && newPrice.creditsGranted) {
          await billingCatalogAdminService.addPrice(created._id, {
            currencyCode: newPrice.currencyCode,
            billingCycle: newPrice.billingCycle,
            amount: Number.parseFloat(newPrice.amount),
            creditsGranted: Number.parseInt(newPrice.creditsGranted, 10),
          });
        }
        toast.success('Plan created.');
      }
      setModalOpen(false);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const addPrice = async () => {
    if (!editing || !newPrice.amount || !newPrice.creditsGranted) {
      toast.error('Amount and credits granted are required.');
      return;
    }
    try {
      const created = await billingCatalogAdminService.addPrice(editing._id, {
        currencyCode: newPrice.currencyCode,
        billingCycle: newPrice.billingCycle,
        amount: Number.parseFloat(newPrice.amount),
        creditsGranted: Number.parseInt(newPrice.creditsGranted, 10),
      });
      setPrices((prev) => [...prev.filter((p) => !(p.currencyCode === created.currencyCode && p.billingCycle === created.billingCycle)), created]);
      setNewPrice({ currencyCode: newPrice.currencyCode, billingCycle: newPrice.billingCycle, amount: '', creditsGranted: '' });
      toast.success('Price added.');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const removePrice = async (priceId: string) => {
    try {
      await billingCatalogAdminService.removePrice(priceId);
      setPrices((prev) => prev.filter((p) => p._id !== priceId));
      toast.success('Price removed.');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const archiveOrActivate = async (plan: AdminPlan) => {
    try {
      if (plan.active) {
        await billingCatalogAdminService.archivePlan(plan._id);
        toast.success('Plan archived.');
      } else {
        await billingCatalogAdminService.activatePlan(plan._id);
        toast.success('Plan activated.');
      }
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await billingCatalogAdminService.deletePlan(deleteTarget._id);
      toast.success('Plan deleted.');
      setDeleteTarget(null);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Plans</h1>
          <p className={shared.pageSubtitle}>Nothing here is hardcoded in the frontend — every field is served from GET /billing/plans.</p>
        </div>
        <Button leftIcon={<FiPlus />} onClick={openCreate}>
          New Plan
        </Button>
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Trial</th>
              <th>Public</th>
              <th>Recommended</th>
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
            {!loading && plans.length === 0 && (
              <tr>
                <td colSpan={6} className={shared.emptyState}>
                  No plans yet — create one to publish it on the pricing page.
                </td>
              </tr>
            )}
            {!loading &&
              plans.map((plan) => (
                <tr key={plan._id}>
                  <td>
                    <div>{plan.name}</div>
                    <div className={shared.mono}>{plan.key}</div>
                  </td>
                  <td>{plan.trialDays ? `${plan.trialDays} days` : '—'}</td>
                  <td>{plan.isPublic ? 'Yes' : 'No'}</td>
                  <td>{plan.recommended ? 'Yes' : 'No'}</td>
                  <td>
                    <Badge variant={plan.active ? 'success' : 'neutral'}>{plan.active ? 'active' : 'archived'}</Badge>
                  </td>
                  <td style={{ display: 'flex', gap: 8 }}>
                    <Button size="sm" variant="secondary" onClick={() => openEdit(plan)}>
                      Manage
                    </Button>
                    <Button
                      size="sm"
                      variant={plan.active ? 'danger' : 'secondary'}
                      leftIcon={plan.active ? <FiArchive size={12} /> : <FiCheckCircle size={12} />}
                      onClick={() => archiveOrActivate(plan)}
                    >
                      {plan.active ? 'Archive' : 'Activate'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(plan)}>
                      <FiTrash2 size={12} />
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? `Manage ${editing.name}` : 'New Plan'} maxWidth={640}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <button
            type="button"
            className={shared.mono}
            style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-end', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}
            onClick={() => setMode((m) => (m === 'simple' ? 'advanced' : 'simple'))}
          >
            {mode === 'simple' ? <FiChevronDown size={14} /> : <FiChevronUp size={14} />}
            {mode === 'simple' ? 'Advanced options' : 'Back to simple view'}
          </button>

          {mode === 'simple' && (
            <div style={{ minHeight: 320, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                <Input label="Key" value={form.key} disabled={!!editing} onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase().replace(/\s+/g, '_') })} placeholder="pro" />
                <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Pro" />
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <Input label="Price" type="number" style={{ width: 110 }} value={newPrice.amount} onChange={(e) => setNewPrice({ ...newPrice, amount: e.target.value })} />
                <Input label="Currency" style={{ width: 90 }} value={newPrice.currencyCode} onChange={(e) => setNewPrice({ ...newPrice, currencyCode: e.target.value.toUpperCase() })} />
                <div>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, display: 'block', marginBottom: 'var(--space-1)' }}>Billing</span>
                  <select
                    value={newPrice.billingCycle}
                    onChange={(e) => setNewPrice({ ...newPrice, billingCycle: e.target.value })}
                    style={{ height: 44, padding: '0 8px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-bg-input)', color: 'var(--color-text-primary)' }}
                  >
                    {BILLING_CYCLES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <Input label="Credits" type="number" style={{ width: 110 }} value={newPrice.creditsGranted} onChange={(e) => setNewPrice({ ...newPrice, creditsGranted: e.target.value })} />
              </div>
              {editing && <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', margin: 0 }}>Editing an existing price isn&apos;t available in the simple view — switch to Advanced options.</p>}

              <div>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, display: 'block', marginBottom: 'var(--space-2)' }}>Features</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  {features.length === 0 && <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>No features in the catalog yet.</p>}
                  {features.map((f) => {
                    const grant = featureGrants.find((g) => g.featureKey === f.key);
                    return <Switch key={f._id} checked={grant?.enabled ?? false} onChange={(enabled) => toggleFeature(f.key, enabled)} label={f.name} />;
                  })}
                </div>
              </div>

              <Switch checked={form.active} onChange={(active) => setForm({ ...form, active })} label="Active" />
            </div>
          )}

          {mode === 'advanced' && (
            <>
              <Tabs
                items={[
                  { id: 'details', label: 'Details' },
                  { id: 'features', label: 'Features & Limits' },
                  { id: 'entitlements', label: 'Entitlements' },
                  { id: 'prices', label: 'Prices' },
                ]}
                activeId={activeTab}
                onChange={(id) => setActiveTab(id as typeof activeTab)}
              />

              <div style={{ minHeight: 320, maxHeight: '60vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                {activeTab === 'details' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                  <Input label="Key" value={form.key} disabled={!!editing} onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase().replace(/\s+/g, '_') })} placeholder="pro" />
                  <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Pro" />
                </div>
                <Input label="Short description" value={form.shortDescription} onChange={(e) => setForm({ ...form, shortDescription: e.target.value })} />
                <Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                <Input label="Trial days" type="number" min={0} value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} />
                <Switch checked={form.active} onChange={(active) => setForm({ ...form, active })} label="Active" />
                <Switch checked={form.isPublic} onChange={(isPublic) => setForm({ ...form, isPublic })} label="Public (shown on pricing page)" />
                <Switch checked={form.recommended} onChange={(recommended) => setForm({ ...form, recommended })} label="Recommended badge" />
              </div>
            )}

            {activeTab === 'features' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
                <div>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, display: 'block', marginBottom: 'var(--space-2)' }}>Features</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                    {features.length === 0 && <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>No features in the catalog yet.</p>}
                    {features.map((f) => {
                      const grant = featureGrants.find((g) => g.featureKey === f.key);
                      return <Switch key={f._id} checked={grant?.enabled ?? false} onChange={(enabled) => toggleFeature(f.key, enabled)} label={f.name} />;
                    })}
                  </div>
                </div>

                <div>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, display: 'block', marginBottom: 'var(--space-2)' }}>Limits</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                    {limitGrants.map((limit, index) => (
                      <div key={index} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                        <Input placeholder="limit key" value={limit.limitKey} onChange={(e) => updateLimit(index, { limitKey: e.target.value })} />
                        <Input
                          type="number"
                          placeholder="value"
                          disabled={limit.unlimited}
                          value={limit.value ?? ''}
                          onChange={(e) => updateLimit(index, { value: Number.parseInt(e.target.value, 10) || 0 })}
                        />
                        <Switch checked={limit.unlimited} onChange={(unlimited) => updateLimit(index, { unlimited })} label="Unlimited" />
                        <Button size="sm" variant="ghost" onClick={() => removeLimit(index)}>
                          <FiTrash2 size={14} />
                        </Button>
                      </div>
                    ))}
                    <Button size="sm" variant="secondary" leftIcon={<FiPlus size={12} />} onClick={addLimit}>
                      Add Limit
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'entitlements' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {entitlementCatalog.length === 0 && (
                  <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>
                    No entitlements in the catalog yet — create one under Entitlements first.
                  </p>
                )}
                {entitlementCatalog.map((e) => {
                  const grant = entitlementGrants.find((g) => g.key === e.key);
                  return (
                    <div key={e._id} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
                      <Switch checked={grant?.enabled ?? false} onChange={(enabled) => toggleEntitlement(e.key, enabled)} label={e.name} />
                      {e.type === 'numeric' && (
                        <Input
                          type="number"
                          placeholder="Unlimited"
                          style={{ width: 120 }}
                          disabled={!grant?.enabled}
                          value={grant?.value ?? ''}
                          onChange={(ev) => setEntitlementValue(e.key, ev.target.value ? Number.parseInt(ev.target.value, 10) : undefined)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {activeTab === 'prices' &&
              (editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  {prices.length === 0 && <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>No prices yet.</p>}
                  {prices.map((p) => (
                    <div key={p._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--text-sm)' }}>
                      <span>
                        {p.amount} {p.currencyCode} / {p.billingCycle} — {p.creditsGranted.toLocaleString()} credits
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => removePrice(p._id)}>
                        <FiTrash2 size={14} />
                      </Button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <Input placeholder="Currency" style={{ width: 90 }} value={newPrice.currencyCode} onChange={(e) => setNewPrice({ ...newPrice, currencyCode: e.target.value.toUpperCase() })} />
                    <select
                      value={newPrice.billingCycle}
                      onChange={(e) => setNewPrice({ ...newPrice, billingCycle: e.target.value })}
                      style={{ padding: '8px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-bg-input)', color: 'var(--color-text-primary)' }}
                    >
                      {BILLING_CYCLES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <Input placeholder="Amount" type="number" style={{ width: 100 }} value={newPrice.amount} onChange={(e) => setNewPrice({ ...newPrice, amount: e.target.value })} />
                    <Input placeholder="Credits" type="number" style={{ width: 100 }} value={newPrice.creditsGranted} onChange={(e) => setNewPrice({ ...newPrice, creditsGranted: e.target.value })} />
                    <Button size="sm" onClick={addPrice}>
                      Add
                    </Button>
                  </div>
                </div>
              ) : (
                <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>Save the plan first, then come back here to add prices.</p>
              ))}
              </div>
            </>
          )}

          <Button fullWidth loading={submitting} onClick={submit}>
            {editing ? 'Save Changes' : 'Create Plan'}
          </Button>
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name ?? 'plan'}?`}
        description="This permanently removes the plan and its prices. If it has ever had a subscriber, the delete is blocked — archive it instead."
      >
        <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button variant="danger" loading={deleting} onClick={confirmDelete}>
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
}

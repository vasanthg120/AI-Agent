import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiKey, FiPlus } from 'react-icons/fi';
import { Badge, Button, Card, Input, Modal, SectionCard, Skeleton, Switch, Tabs } from '@/components/ui';
import { billingSettingsAdminService, type BillingSettings } from '@/services/billingSettingsAdminService';
import { billingCatalogAdminService, type AdminTaxRate } from '@/services/billingCatalogAdminService';
import { billingMigrationAdminService, type MigrationRunResult } from '@/services/billingMigrationAdminService';
import { adminIntegrationsService } from '@/services/adminIntegrationsService';
import { extractErrorMessage } from '@/utils/errors';
// Same card visual the Anthropic integration used on /settings/integrations
// before it moved here — reused verbatim (not copied) so the design stays
// pixel-identical and never drifts from Gmail/Outlook's still-current cards
// on that page, which use this exact same module.
import integrationsStyles from '../integrations/IntegrationsPage.module.css';
import shared from './adminShared.module.css';

type TabId = 'company' | 'taxes' | 'migration' | 'aiProvider';
const TABS: { id: TabId; label: string }[] = [
  { id: 'company', label: 'Company & Invoicing' },
  { id: 'taxes', label: 'Tax Rates' },
  { id: 'migration', label: 'Wallet Migration' },
  { id: 'aiProvider', label: 'AI Provider' },
];

function CompanySettingsTab() {
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    billingSettingsAdminService
      .get()
      .then(setSettings)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await billingSettingsAdminService.update(settings);
      toast.success('Settings saved.');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) return <Skeleton height={200} />;

  return (
    <SectionCard title="Company & Invoicing">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', maxWidth: 480 }}>
        <Input label="Company name" value={settings.companyName} onChange={(e) => setSettings({ ...settings, companyName: e.target.value })} />
        <Input label="Address" value={settings.companyAddress ?? ''} onChange={(e) => setSettings({ ...settings, companyAddress: e.target.value })} />
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <Input label="Email" value={settings.companyEmail ?? ''} onChange={(e) => setSettings({ ...settings, companyEmail: e.target.value })} />
          <Input label="Phone" value={settings.companyPhone ?? ''} onChange={(e) => setSettings({ ...settings, companyPhone: e.target.value })} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <Input label="Website" value={settings.companyWebsite ?? ''} onChange={(e) => setSettings({ ...settings, companyWebsite: e.target.value })} />
          <Input label="Tax ID (GST/VAT)" value={settings.companyTaxId ?? ''} onChange={(e) => setSettings({ ...settings, companyTaxId: e.target.value })} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <Input label="Invoice number prefix" value={settings.invoiceNumberPrefix} onChange={(e) => setSettings({ ...settings, invoiceNumberPrefix: e.target.value })} />
          <Input
            label="Invoice number start"
            type="number"
            value={settings.invoiceNumberStart}
            onChange={(e) => setSettings({ ...settings, invoiceNumberStart: Number.parseInt(e.target.value, 10) || 0 })}
          />
        </div>
        <Input label="Invoice footer text" value={settings.invoiceFooterText ?? ''} onChange={(e) => setSettings({ ...settings, invoiceFooterText: e.target.value })} />
        <Button loading={saving} onClick={save} style={{ alignSelf: 'flex-start' }}>
          Save
        </Button>
      </div>
    </SectionCard>
  );
}

const emptyTaxForm = { key: '', name: '', percentage: '', countryCode: '', inclusive: false };

function TaxRatesTab() {
  const [rates, setRates] = useState<AdminTaxRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyTaxForm);
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    billingCatalogAdminService
      .listTaxRates()
      .then(setRates)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const submit = async () => {
    if (!form.key.trim() || !form.name.trim() || !form.percentage) {
      toast.error('Key, name, and percentage are required.');
      return;
    }
    setSubmitting(true);
    try {
      await billingCatalogAdminService.createTaxRate({
        key: form.key.trim(),
        name: form.name,
        percentage: Number.parseFloat(form.percentage),
        countryCode: form.countryCode || undefined,
        inclusive: form.inclusive,
      });
      toast.success('Tax rate created.');
      setModalOpen(false);
      setForm(emptyTaxForm);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (rate: AdminTaxRate) => {
    try {
      if (rate.active) await billingCatalogAdminService.deactivateTaxRate(rate._id);
      else await billingCatalogAdminService.activateTaxRate(rate._id);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  return (
    <SectionCard title="Tax Rates" action={<Button size="sm" leftIcon={<FiPlus size={12} />} onClick={() => setModalOpen(true)}>New Rate</Button>}>
      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Percentage</th>
              <th>Country</th>
              <th>Inclusive</th>
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
            {!loading && rates.length === 0 && (
              <tr>
                <td colSpan={7} className={shared.emptyState}>
                  No tax rates configured.
                </td>
              </tr>
            )}
            {!loading &&
              rates.map((r) => (
                <tr key={r._id}>
                  <td className={shared.mono}>{r.key}</td>
                  <td>{r.name}</td>
                  <td>{r.percentage}%</td>
                  <td>{r.countryCode ?? 'All'}</td>
                  <td>{r.inclusive ? 'Yes' : 'No'}</td>
                  <td>
                    <Badge variant={r.active ? 'success' : 'neutral'}>{r.active ? 'active' : 'inactive'}</Badge>
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => toggleActive(r)}>
                      {r.active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Tax Rate">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Input label="Key" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="in_gst" />
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="India GST" />
          <Input label="Percentage" type="number" value={form.percentage} onChange={(e) => setForm({ ...form, percentage: e.target.value })} placeholder="18" />
          <Input label="Country code (optional)" value={form.countryCode} onChange={(e) => setForm({ ...form, countryCode: e.target.value.toUpperCase() })} placeholder="IN" />
          <Switch checked={form.inclusive} onChange={(inclusive) => setForm({ ...form, inclusive })} label="Price is tax-inclusive" />
          <Button fullWidth loading={submitting} onClick={submit}>
            Create Tax Rate
          </Button>
        </div>
      </Modal>
    </SectionCard>
  );
}

function WalletMigrationTab() {
  const [organizationId, setOrganizationId] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MigrationRunResult | null>(null);

  const runDryRun = async () => {
    setRunning(true);
    try {
      const res = await billingMigrationAdminService.run(true, organizationId || undefined);
      setResult(res);
      toast.success(`Dry run complete — ${res.organizations.length} organization(s) evaluated.`);
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setRunning(false);
    }
  };

  const runReal = async () => {
    if (!window.confirm('This performs REAL wallet writes across organizations. Review the dry-run plan first. Continue?')) return;
    setRunning(true);
    try {
      const res = await billingMigrationAdminService.run(false, organizationId || undefined);
      setResult(res);
      toast.success('Migration run complete.');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setRunning(false);
    }
  };

  const actionableCount = result?.organizations.filter((o) => o.action !== 'none').length ?? 0;

  return (
    <SectionCard title="Organization Wallet Migration">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', margin: 0 }}>
          Renames or merges per-user wallets onto the real organization id — the one-time step behind flipping{' '}
          <code className={shared.mono}>BILLING_ORG_SCOPED_WALLETS</code>. Always dry-run first and review the plan before a real run.
        </p>
        <Input
          label="Organization id (optional — omit to plan/run every organization)"
          value={organizationId}
          onChange={(e) => setOrganizationId(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <Button variant="secondary" loading={running} onClick={runDryRun}>
            Dry Run
          </Button>
          <Button variant="danger" loading={running} onClick={runReal}>
            Run For Real
          </Button>
        </div>

        {result && (
          <div style={{ fontSize: 'var(--text-sm)' }}>
            <Badge variant={result.dryRun ? 'warning' : 'success'}>{result.dryRun ? 'Dry run' : 'Executed'}</Badge>{' '}
            {result.organizations.length} organization(s) evaluated, {actionableCount} with an action.
            <div className={shared.tableWrap} style={{ marginTop: 'var(--space-3)' }}>
              <table className={shared.table}>
                <thead>
                  <tr>
                    <th>Organization</th>
                    <th>Action</th>
                    <th>Source Wallets</th>
                    <th>Merged Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {result.organizations
                    .filter((o) => o.action !== 'none')
                    .map((o) => (
                      <tr key={o.organizationId}>
                        <td className={shared.mono}>{o.organizationId}</td>
                        <td>
                          <Badge variant={o.action === 'merge' ? 'warning' : 'accent'}>{o.action}</Badge>
                        </td>
                        <td>{o.sourceWallets.length}</td>
                        <td>{o.mergedBalanceCredits?.toLocaleString() ?? '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

type AnthropicStatus = { status: 'loading' | 'connected' | 'disconnected' | 'error'; detail?: string };

// Moved from the customer-facing /settings/integrations page — Anthropic's
// credential has always been read platform-wide at the point it actually
// matters (python-agent's anthropic_client.py._resolve_api_key reads it
// with no organizationId filter), so this belongs here rather than under
// any one organization. Reuses the exact same backend IntegrationsService
// methods (connect/status/disconnect) the old customer card called — see
// adminIntegrationsService.ts and backend/src/integrations/
// admin-integrations.controller.ts — just through the admin session's own
// auth instead. Same copy, same validation, same masked-key display; only
// the visual shell changed to match this page's own SectionCard-based tabs.
function AnthropicSettingsTab() {
  const [status, setStatus] = useState<AnthropicStatus>({ status: 'loading' });
  const [modalOpen, setModalOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [connecting, setConnecting] = useState(false);

  const load = () => {
    adminIntegrationsService
      .getAnthropicStatus()
      .then((s) => setStatus({ status: s.connected ? 'connected' : 'disconnected', detail: s.maskedKey }))
      .catch((error) => setStatus({ status: 'error', detail: extractErrorMessage(error) }));
  };

  useEffect(load, []);

  const badge = () => {
    if (status.status === 'loading') return <Badge variant="neutral">Checking...</Badge>;
    if (status.status === 'connected') return <Badge variant="success" dot>Connected</Badge>;
    if (status.status === 'error') return <Badge variant="danger" dot>Connection error</Badge>;
    return <Badge variant="neutral" dot>Not connected</Badge>;
  };

  const openModal = () => {
    setApiKeyInput('');
    setModalOpen(true);
  };

  const save = async () => {
    if (apiKeyInput.trim().length < 10) {
      toast.error('That doesn’t look like a valid Anthropic API key.');
      return;
    }
    setConnecting(true);
    try {
      const result = await adminIntegrationsService.connectAnthropic(apiKeyInput.trim());
      setStatus({ status: 'connected', detail: result.maskedKey });
      toast.success('Anthropic connected — Claude will now be used for chat and Outlook mail analysis.');
      setModalOpen(false);
      setApiKeyInput('');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      await adminIntegrationsService.disconnectAnthropic();
      setStatus({ status: 'disconnected' });
      toast.success('Anthropic disconnected');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  return (
    <div style={{ maxWidth: 360 }}>
      <Card className={integrationsStyles.card}>
        <div className={integrationsStyles.cardHeader}>
          <span className={integrationsStyles.logoTile}>
            <img src="/integrations/anthropic.svg" alt="" />
          </span>
          <div className={integrationsStyles.cardTitleRow}>
            <div className={integrationsStyles.cardName}>Anthropic</div>
            <div className={integrationsStyles.cardCategory}>AI Model</div>
          </div>
          {badge()}
        </div>
        <p className={integrationsStyles.cardDescription}>Claude models for chat, reasoning, and Outlook mail analysis.</p>
        {(status.status === 'connected' || status.status === 'error') && status.detail && (
          <div className={integrationsStyles.keyPreview}>{status.detail}</div>
        )}
        <div className={integrationsStyles.cardFooter}>
          {status.status === 'connected' ? (
            <Button size="sm" variant="secondary" onClick={disconnect}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" leftIcon={<FiKey />} onClick={openModal}>
              Connect
            </Button>
          )}
        </div>
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Connect Anthropic"
        description="Paste your Anthropic API key. It's stored server-side and used by the chat agent — never exposed to the browser."
      >
        <Input
          label="API key"
          type="password"
          placeholder="sk-ant-api03-..."
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
          autoFocus
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-5)' }}>
          <Button variant="ghost" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>
          <Button loading={connecting} onClick={save}>
            Save Key
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function AdminSettingsPage() {
  const [tab, setTab] = useState<TabId>('company');

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Settings</h1>
          <p className={shared.pageSubtitle}>
            Company/invoice identity, tax configuration, the org-scoped wallet migration tool, and the platform's AI provider.
          </p>
        </div>
      </div>

      <div className={shared.tabsBar}>
        <Tabs items={TABS} activeId={tab} onChange={(id) => setTab(id as TabId)} />
      </div>

      {tab === 'company' && <CompanySettingsTab />}
      {tab === 'taxes' && <TaxRatesTab />}
      {tab === 'migration' && <WalletMigrationTab />}
      {tab === 'aiProvider' && <AnthropicSettingsTab />}
    </div>
  );
}

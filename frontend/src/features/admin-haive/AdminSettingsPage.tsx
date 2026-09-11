import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiKey, FiPlus } from 'react-icons/fi';
import { Badge, Button, Card, Input, Modal, SectionCard, Skeleton, Switch, Tabs } from '@/components/ui';
import { billingSettingsAdminService, type BillingSettings } from '@/services/billingSettingsAdminService';
import { billingCatalogAdminService, type AdminTaxRate } from '@/services/billingCatalogAdminService';
import { billingMigrationAdminService, type MigrationRunResult } from '@/services/billingMigrationAdminService';
import { adminIntegrationsService, type AiProvider } from '@/services/adminIntegrationsService';
import {
  billingProviderPricingAdminService,
  type CreateProviderPricingPayload,
  type ProviderPricingRow,
} from '@/services/billingProviderPricingAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
// Same card visual the Anthropic integration used on /settings/integrations
// before it moved here — reused verbatim (not copied) so the design stays
// pixel-identical and never drifts from Gmail/Outlook's still-current cards
// on that page, which use this exact same module.
import integrationsStyles from '../integrations/IntegrationsPage.module.css';
import shared from './adminShared.module.css';

type TabId = 'company' | 'taxes' | 'migration' | 'aiProvider' | 'providerPricing';
const TABS: { id: TabId; label: string }[] = [
  { id: 'company', label: 'Company & Invoicing' },
  { id: 'taxes', label: 'Tax Rates' },
  { id: 'migration', label: 'Wallet Migration' },
  { id: 'aiProvider', label: 'AI Provider' },
  { id: 'providerPricing', label: 'Provider Pricing' },
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

type ProviderCardStatus = { status: 'loading' | 'connected' | 'disconnected' | 'error'; detail?: string };

interface AiProviderCardConfig {
  provider: AiProvider;
  name: string;
  category: string;
  description: string;
  logoSrc?: string;
  logoGlyph?: string;
  modalTitle: string;
  modalDescription: string;
  placeholder: string;
  connectedToastMessage: string;
  minKeyLength: number;
  invalidKeyMessage: string;
}

// Platform-wide AI provider credentials (Anthropic, Sarvam) — both resolved
// server-side to organizationId="platform" explicitly (never an arbitrary
// organization's own credential, never a static .env fallback — see
// python-agent's anthropic_client.py._resolve_api_key/sarvam_client.py.
// _require_api_key). One shared card component since both providers use the
// identical connect/status/disconnect shape — see adminIntegrationsService.ts
// and backend/src/integrations/admin-integrations.controller.ts. Anthropic's
// card was originally on the customer-facing /settings/integrations page;
// this reuses that same visual design (IntegrationsPage.module.css) rather
// than redesigning, per this page's own established pattern.
function AiProviderCard({ config }: { config: AiProviderCardConfig }) {
  const [status, setStatus] = useState<ProviderCardStatus>({ status: 'loading' });
  const [modalOpen, setModalOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  // Transient, never persisted — a fresh "is it reachable right now" result,
  // distinct from the Connected/Not connected badge above (a DB-existence
  // check). Resets whenever the credential changes (reconnect/disconnect).
  const [verified, setVerified] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);

  const load = () => {
    adminIntegrationsService
      .getStatus(config.provider)
      .then((s) => setStatus({ status: s.connected ? 'connected' : 'disconnected', detail: s.maskedKey }))
      .catch((error) => setStatus({ status: 'error', detail: extractErrorMessage(error) }));
  };

  const verify = async () => {
    setVerifying(true);
    try {
      const result = await adminIntegrationsService.verify(config.provider);
      setVerified(result.ok);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch (error) {
      setVerified(false);
      toast.error(extractErrorMessage(error));
    } finally {
      setVerifying(false);
    }
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
    if (apiKeyInput.trim().length < config.minKeyLength) {
      toast.error(config.invalidKeyMessage);
      return;
    }
    setConnecting(true);
    try {
      const result = await adminIntegrationsService.connect(config.provider, apiKeyInput.trim());
      setStatus({ status: 'connected', detail: result.maskedKey });
      setVerified(null);
      toast.success(config.connectedToastMessage);
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
      await adminIntegrationsService.disconnect(config.provider);
      setStatus({ status: 'disconnected' });
      setVerified(null);
      toast.success(`${config.name} disconnected`);
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  return (
    <div style={{ maxWidth: 360 }}>
      <Card className={integrationsStyles.card}>
        <div className={integrationsStyles.cardHeader}>
          <span className={integrationsStyles.logoTile}>
            {config.logoSrc ? (
              <img src={config.logoSrc} alt="" />
            ) : (
              <span aria-hidden style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--color-accent)' }}>
                {config.logoGlyph}
              </span>
            )}
          </span>
          <div className={integrationsStyles.cardTitleRow}>
            <div className={integrationsStyles.cardName}>{config.name}</div>
            <div className={integrationsStyles.cardCategory}>{config.category}</div>
          </div>
          {badge()}
          {status.status === 'connected' && verified !== null && (
            <Badge variant={verified ? 'success' : 'danger'}>{verified ? 'Verified' : 'Not verified'}</Badge>
          )}
        </div>
        <p className={integrationsStyles.cardDescription}>{config.description}</p>
        {(status.status === 'connected' || status.status === 'error') && status.detail && (
          <div className={integrationsStyles.keyPreview}>{status.detail}</div>
        )}
        <div className={integrationsStyles.cardFooter}>
          {status.status === 'connected' ? (
            <>
              <Button size="sm" variant="outline" loading={verifying} onClick={verify}>
                Test Connection
              </Button>
              <Button size="sm" variant="secondary" onClick={disconnect}>
                Disconnect
              </Button>
            </>
          ) : (
            <Button size="sm" leftIcon={<FiKey />} onClick={openModal}>
              Connect
            </Button>
          )}
        </div>
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={config.modalTitle} description={config.modalDescription}>
        <Input
          label="API key"
          type="password"
          placeholder={config.placeholder}
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

const ANTHROPIC_CARD_CONFIG: AiProviderCardConfig = {
  provider: 'anthropic',
  name: 'Anthropic',
  category: 'AI Model',
  description: 'Claude models for chat, reasoning, and Outlook mail analysis.',
  logoSrc: '/integrations/anthropic.svg',
  modalTitle: 'Connect Anthropic',
  modalDescription: "Paste your Anthropic API key. It's stored server-side and used by the chat agent — never exposed to the browser.",
  placeholder: 'sk-ant-api03-...',
  connectedToastMessage: 'Anthropic connected — Claude will now be used for chat and Outlook mail analysis.',
  minKeyLength: 10,
  invalidKeyMessage: 'That doesn’t look like a valid Anthropic API key.',
};

const SARVAM_CARD_CONFIG: AiProviderCardConfig = {
  provider: 'sarvam',
  name: 'Sarvam AI',
  category: 'Voice AI',
  description: 'Speech-to-text and text-to-speech for the Indian-language voice assistant.',
  logoGlyph: 'S',
  modalTitle: 'Connect Sarvam AI',
  modalDescription: "Paste your Sarvam AI API key. It's stored server-side and used for voice input/output — never exposed to the browser.",
  placeholder: 'Sarvam API key',
  connectedToastMessage: 'Sarvam AI connected — voice input/output will now use it.',
  minKeyLength: 10,
  invalidKeyMessage: 'That doesn’t look like a valid Sarvam AI API key.',
};

const GROQ_CARD_CONFIG: AiProviderCardConfig = {
  provider: 'groq',
  name: 'Groq',
  category: 'AI Model',
  description: 'Optional fast lane for simple, tool-free chat questions. Chat keeps working on Claude alone if this is left disconnected.',
  logoGlyph: 'G',
  modalTitle: 'Connect Groq',
  modalDescription: "Paste your Groq API key. It's stored server-side and used only for quick general-knowledge replies — never exposed to the browser.",
  placeholder: 'gsk_...',
  connectedToastMessage: 'Groq connected — simple chat questions will now get faster replies.',
  minKeyLength: 10,
  invalidKeyMessage: 'That doesn’t look like a valid Groq API key.',
};

function AiProviderTab() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
      <AiProviderCard config={ANTHROPIC_CARD_CONFIG} />
      <AiProviderCard config={SARVAM_CARD_CONFIG} />
      <AiProviderCard config={GROQ_CARD_CONFIG} />
    </div>
  );
}

const emptyProviderPricingForm: CreateProviderPricingPayload & { marginMode: 'global' | 'override' } = {
  provider: '',
  model: '',
  inputCostPerMTokUsd: 0,
  outputCostPerMTokUsd: 0,
  marginOverridePct: undefined,
  marginMode: 'global',
};

// Admin control over the ProviderPricing registry (section 9/15B) —
// ReservationService.settle() reads this per (provider, model) at every
// settlement; "Add Rate" always creates a NEW versioned row (never edits an
// existing one), so a rate/margin change only ever affects usage settled
// AFTER it, never rewriting how a past transaction was already priced. See
// billing-admin-provider-pricing.service.ts's own doc comment.
function ProviderPricingTab() {
  const [rows, setRows] = useState<ProviderPricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyProviderPricingForm);
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    billingProviderPricingAdminService
      .list()
      .then(setRows)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const activeRows = rows.filter((r) => !r.effectiveTo);
  const historyRows = rows.filter((r) => r.effectiveTo);

  const submit = async () => {
    if (!form.provider.trim() || !(form.inputCostPerMTokUsd >= 0) || !(form.outputCostPerMTokUsd >= 0)) {
      toast.error('Provider, input cost, and output cost are required.');
      return;
    }
    setSubmitting(true);
    try {
      await billingProviderPricingAdminService.create({
        provider: form.provider.trim(),
        model: form.model?.trim() || undefined,
        inputCostPerMTokUsd: form.inputCostPerMTokUsd,
        outputCostPerMTokUsd: form.outputCostPerMTokUsd,
        marginOverridePct: form.marginMode === 'override' ? form.marginOverridePct : undefined,
      });
      toast.success('Rate saved — takes effect for usage settled from now on.');
      setModalOpen(false);
      setForm(emptyProviderPricingForm);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SectionCard
      title="Provider / Model Pricing"
      action={
        <Button size="sm" leftIcon={<FiPlus size={12} />} onClick={() => setModalOpen(true)}>
          Add Rate
        </Button>
      }
    >
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', margin: '0 0 var(--space-4)' }}>
        The source of truth ReservationService.settle() reads at every AI usage settlement. Adding a rate never edits or deletes
        an existing one — it creates a new version effective from now, so past settled transactions are never recalculated.
        Leave the margin as "Use Global" to follow the Target Gross Margin set on the AI Provider tab.
      </p>
      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model</th>
              <th>Input $/MTok</th>
              <th>Output $/MTok</th>
              <th>Margin</th>
              <th>Effective From</th>
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
            {!loading && activeRows.length === 0 && (
              <tr>
                <td colSpan={6} className={shared.emptyState}>
                  No provider pricing configured yet.
                </td>
              </tr>
            )}
            {!loading &&
              activeRows.map((r) => (
                <tr key={r._id}>
                  <td className={shared.mono}>{r.provider}</td>
                  <td className={shared.mono}>{r.model}</td>
                  <td>${r.inputCostPerMTokUsd}</td>
                  <td>${r.outputCostPerMTokUsd}</td>
                  <td>{r.marginOverridePct !== undefined ? <Badge variant="accent">{r.marginOverridePct}%</Badge> : <Badge variant="neutral">Use Global</Badge>}</td>
                  <td>{formatFullDate(r.effectiveFrom)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {historyRows.length > 0 && (
        <details style={{ marginTop: 'var(--space-4)' }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
            {historyRows.length} historical rate{historyRows.length === 1 ? '' : 's'} (superseded, kept for past-transaction accuracy)
          </summary>
          <div className={shared.tableWrap} style={{ marginTop: 'var(--space-3)' }}>
            <table className={shared.table}>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Input $/MTok</th>
                  <th>Output $/MTok</th>
                  <th>Margin</th>
                  <th>Effective From</th>
                  <th>Effective To</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map((r) => (
                  <tr key={r._id}>
                    <td className={shared.mono}>{r.provider}</td>
                    <td className={shared.mono}>{r.model}</td>
                    <td>${r.inputCostPerMTokUsd}</td>
                    <td>${r.outputCostPerMTokUsd}</td>
                    <td>{r.marginOverridePct !== undefined ? `${r.marginOverridePct}%` : 'Use Global'}</td>
                    <td>{formatFullDate(r.effectiveFrom)}</td>
                    <td>{r.effectiveTo ? formatFullDate(r.effectiveTo) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Add Provider Pricing Rate">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Input label="Provider" placeholder="anthropic" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} />
          <Input
            label="Model (optional — blank means provider-wide default, '*')"
            placeholder="claude-sonnet-4-6"
            value={form.model ?? ''}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Input
              label="Input cost ($ per million tokens)"
              type="number"
              min={0}
              step="0.01"
              value={form.inputCostPerMTokUsd}
              onChange={(e) => setForm({ ...form, inputCostPerMTokUsd: Number.parseFloat(e.target.value) || 0 })}
            />
            <Input
              label="Output cost ($ per million tokens)"
              type="number"
              min={0}
              step="0.01"
              value={form.outputCostPerMTokUsd}
              onChange={(e) => setForm({ ...form, outputCostPerMTokUsd: Number.parseFloat(e.target.value) || 0 })}
            />
          </div>
          <label className={shared.mono} style={{ fontSize: 'var(--text-sm)', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: 4 }}>
            Margin
            <select
              value={form.marginMode}
              onChange={(e) => setForm({ ...form, marginMode: e.target.value as 'global' | 'override' })}
              style={{ padding: 'var(--space-2)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}
            >
              <option value="global">Use Global</option>
              <option value="override">Override</option>
            </select>
          </label>
          {form.marginMode === 'override' && (
            <Input
              label="Margin override (%)"
              type="number"
              min={0}
              max={99.99}
              step="0.01"
              value={form.marginOverridePct ?? ''}
              onChange={(e) => setForm({ ...form, marginOverridePct: e.target.value ? Number.parseFloat(e.target.value) : undefined })}
            />
          )}
          <Button fullWidth loading={submitting} onClick={submit}>
            Save Rate
          </Button>
        </div>
      </Modal>
    </SectionCard>
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
      {tab === 'aiProvider' && <AiProviderTab />}
      {tab === 'providerPricing' && <ProviderPricingTab />}
    </div>
  );
}

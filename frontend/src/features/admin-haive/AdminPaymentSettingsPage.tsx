import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiCheck, FiShield } from 'react-icons/fi';
import { Badge, Button, Input, SectionCard, Skeleton, Switch, Tabs } from '@/components/ui';
import { billingCatalogAdminService, type AdminCurrency } from '@/services/billingCatalogAdminService';
import { billingGatewaysAdminService, type GatewayConfigStatus, type GatewayMode, type GatewayProvider } from '@/services/billingGatewaysAdminService';
import { billingSettingsAdminService, type BillingSettings } from '@/services/billingSettingsAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import shared from './adminShared.module.css';
import styles from './AdminPaymentSettingsPage.module.css';

const PROVIDERS: GatewayProvider[] = ['razorpay', 'stripe', 'cashfree'];
const MODES: GatewayMode[] = ['test', 'live'];

const CREDENTIAL_FIELDS: Record<GatewayProvider, { key: string; label: string }[]> = {
  razorpay: [
    { key: 'keyId', label: 'Key ID' },
    { key: 'keySecret', label: 'Key Secret' },
    { key: 'webhookSecret', label: 'Webhook Secret' },
  ],
  stripe: [
    { key: 'secretKey', label: 'Secret Key' },
    { key: 'publishableKey', label: 'Publishable Key' },
    { key: 'webhookSecret', label: 'Webhook Secret' },
  ],
  cashfree: [
    { key: 'clientId', label: 'Client ID' },
    { key: 'clientSecret', label: 'Client Secret' },
    { key: 'webhookSecret', label: 'Webhook Secret' },
  ],
};

// Purely cosmetic — a distinct initial + color per gateway so the list scans
// at a glance. Doesn't touch which providers actually exist (PROVIDERS,
// sourced from GatewayProvider, still drives everything functional).
const GATEWAY_META: Record<GatewayProvider, { label: string; initial: string; color: string }> = {
  razorpay: { label: 'Razorpay', initial: 'R', color: '#3350a3' },
  stripe: { label: 'Stripe', initial: 'S', color: '#635bff' },
  cashfree: { label: 'Cashfree', initial: 'C', color: '#00b8d9' },
};

// Never stores or displays a decrypted secret — matches the backend's own
// guarantee (billing-admin-gateways.service.ts's toStatus never returns one
// either). Credential inputs are write-only: type a new value to overwrite,
// leave blank to keep whatever's already on file.
export function AdminPaymentSettingsPage() {
  const [gateways, setGateways] = useState<GatewayConfigStatus[]>([]);
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [currencies, setCurrencies] = useState<AdminCurrency[]>([]);
  const [loading, setLoading] = useState(true);
  const [credentialForms, setCredentialForms] = useState<Record<string, Record<string, string>>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  // Display-only: which mode tab is showing per gateway card. Doesn't affect
  // which credentials get saved — saveCredentials still takes an explicit
  // (provider, mode) pair the way it always did.
  const [activeMode, setActiveMode] = useState<Record<GatewayProvider, GatewayMode>>({ razorpay: 'test', stripe: 'test', cashfree: 'test' });

  const load = () => {
    setLoading(true);
    Promise.all([billingGatewaysAdminService.list(), billingSettingsAdminService.get(), billingCatalogAdminService.listCurrencies()])
      .then(([g, s, c]) => {
        setGateways(g);
        setSettings(s);
        setCurrencies(c);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const statusFor = (provider: GatewayProvider, mode: GatewayMode) => gateways.find((g) => g.provider === provider && g.mode === mode);

  const saveCredentials = async (provider: GatewayProvider, mode: GatewayMode) => {
    const formKey = `${provider}:${mode}`;
    const values = credentialForms[formKey] ?? {};
    const nonEmpty = Object.fromEntries(Object.entries(values).filter(([, v]) => v));
    if (Object.keys(nonEmpty).length === 0) {
      toast.error('Enter at least one credential value to save.');
      return;
    }
    setSavingKey(formKey);
    try {
      await billingGatewaysAdminService.upsert(provider, mode, nonEmpty);
      toast.success(`${provider} (${mode}) credentials saved — takes effect on next backend restart.`);
      setCredentialForms((prev) => ({ ...prev, [formKey]: {} }));
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSavingKey(null);
    }
  };

  const toggleActive = async (status: GatewayConfigStatus) => {
    try {
      await billingGatewaysAdminService.setActive(status.provider, status.mode, !status.isActive);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  // A lightweight status re-check, not a live API call to the gateway itself
  // — re-fetches this provider/mode's configured/active status and reports
  // it. A real connectivity ping (e.g. Razorpay's orders.all/Stripe's
  // balance.retrieve) would mean new per-gateway backend methods; scoped out
  // of this pass as a separate follow-up.
  const testConnection = async (provider: GatewayProvider, mode: GatewayMode) => {
    const formKey = `${provider}:${mode}`;
    setTestingKey(formKey);
    try {
      const list = await billingGatewaysAdminService.list();
      setGateways(list);
      const status = list.find((g) => g.provider === provider && g.mode === mode);
      if (status?.configured) {
        toast.success(`${GATEWAY_META[provider].label} (${mode}) is configured${status.isActive ? ' and active' : ''}.`);
      } else {
        toast.error(`${GATEWAY_META[provider].label} (${mode}) has no credentials saved yet.`);
      }
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setTestingKey(null);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      await billingSettingsAdminService.update({
        defaultPaymentProvider: settings.defaultPaymentProvider,
        defaultPaymentMode: settings.defaultPaymentMode,
        defaultCurrencyCode: settings.defaultCurrencyCode,
        enabledGateways: settings.enabledGateways,
        autoRechargeMinCredits: settings.autoRechargeMinCredits,
        autoRechargeMaxCredits: settings.autoRechargeMaxCredits,
      });
      toast.success('Payment settings saved.');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSavingSettings(false);
    }
  };

  const toggleEnabledGateway = (provider: GatewayProvider) => {
    if (!settings) return;
    const current = settings.enabledGateways ?? PROVIDERS;
    const next = current.includes(provider) ? current.filter((p) => p !== provider) : [...current, provider];
    setSettings({ ...settings, enabledGateways: next });
  };

  if (loading || !settings) {
    return (
      <div className={shared.page}>
        <Skeleton height={32} width={280} />
        <Skeleton height={160} />
        <Skeleton height={220} />
        <Skeleton height={220} />
      </div>
    );
  }

  const enabledGateways = settings.enabledGateways ?? PROVIDERS;

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Payment Settings</h1>
          <p className={styles.intro}>
            <FiShield size={14} />
            Gateway credentials are AES-encrypted at rest and never returned in plaintext.
          </p>
        </div>
      </div>

      <SectionCard title="Platform Defaults">
        <div className={styles.defaultsGrid}>
          <div>
            <label className={styles.fieldLabel} htmlFor="default-mode">
              Payment Mode
            </label>
            <select
              id="default-mode"
              className={styles.select}
              value={settings.defaultPaymentMode ?? ''}
              onChange={(e) => setSettings({ ...settings, defaultPaymentMode: (e.target.value || undefined) as 'live' | 'test' | undefined })}
            >
              <option value="">Use PAYMENT_MODE env var</option>
              <option value="test">Test</option>
              <option value="live">Live</option>
            </select>
            <p className={styles.fieldHint}>Test or live keys, per gateway. Takes effect on the next backend restart.</p>
          </div>

          <div>
            <label className={styles.fieldLabel} htmlFor="default-currency">
              Currency
            </label>
            <select
              id="default-currency"
              className={styles.select}
              value={settings.defaultCurrencyCode ?? ''}
              onChange={(e) => setSettings({ ...settings, defaultCurrencyCode: e.target.value || undefined })}
            >
              <option value="">Use the Currency catalog&apos;s default</option>
              {currencies.map((c) => (
                <option key={c._id} value={c.code}>
                  {c.code} ({c.symbol})
                </option>
              ))}
            </select>
            <p className={styles.fieldHint}>Pre-fills the currency field for new plans/packages/coupons. Doesn&apos;t change what an existing price actually charges.</p>
          </div>

          <div>
            <span className={styles.fieldLabel}>Payment Provider</span>
            <div className={styles.gatewayChips}>
              {PROVIDERS.map((p) => {
                const on = (settings.defaultPaymentProvider ?? 'razorpay') === p;
                return (
                  <button
                    key={p}
                    type="button"
                    className={on ? `${styles.gatewayChip} ${styles.gatewayChipActive}` : styles.gatewayChip}
                    onClick={() => setSettings({ ...settings, defaultPaymentProvider: p })}
                    aria-pressed={on}
                  >
                    <span className={styles.gatewayAvatar} style={{ background: GATEWAY_META[p].color, width: 18, height: 18, fontSize: 10 }}>
                      {GATEWAY_META[p].initial}
                    </span>
                    {GATEWAY_META[p].label}
                    {on && <FiCheck size={13} />}
                  </button>
                );
              })}
            </div>
            <p className={styles.fieldHint}>Which gateway new checkouts route through. Only this provider&apos;s credentials are shown below.</p>
          </div>

          <div>
            <span className={styles.fieldLabel}>Enabled gateways</span>
            <div className={styles.gatewayChips}>
              {PROVIDERS.map((p) => {
                const on = enabledGateways.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    className={on ? `${styles.gatewayChip} ${styles.gatewayChipActive}` : styles.gatewayChip}
                    onClick={() => toggleEnabledGateway(p)}
                    aria-pressed={on}
                  >
                    <span className={styles.gatewayChipDot} />
                    {GATEWAY_META[p].label}
                    {on && <FiCheck size={13} />}
                  </button>
                );
              })}
            </div>
            <p className={styles.fieldHint}>Gateways customers can pay through.</p>
          </div>
        </div>

        <div style={{ marginTop: 'var(--space-6)' }}>
          <Switch
            checked={settings.autoRechargeDefaultOn ?? true}
            onChange={(autoRechargeDefaultOn) => setSettings({ ...settings, autoRechargeDefaultOn })}
            label="Default Auto Recharge"
            description="When a customer's plan purchase saves a payment method, Auto Recharge turns on automatically. Turn this off to require customers to enable it manually instead."
          />
        </div>

        <div className={styles.numberRow} style={{ marginTop: 'var(--space-6)' }}>
          <Input
            label="Minimum Auto Recharge Amount"
            type="number"
            placeholder="No minimum"
            hint="The floor for every automatic recharge — never a customer-chosen value"
            value={settings.autoRechargeMinCredits ?? ''}
            onChange={(e) => setSettings({ ...settings, autoRechargeMinCredits: e.target.value ? Number.parseInt(e.target.value, 10) : undefined })}
          />
          <Input
            label="Maximum Auto Recharge Amount"
            type="number"
            placeholder="No maximum"
            value={settings.autoRechargeMaxCredits ?? ''}
            onChange={(e) => setSettings({ ...settings, autoRechargeMaxCredits: e.target.value ? Number.parseInt(e.target.value, 10) : undefined })}
          />
        </div>

        <div className={styles.cardFooter}>
          <Button loading={savingSettings} onClick={saveSettings}>
            Save Defaults
          </Button>
        </div>
      </SectionCard>

      <div className={styles.gatewayList}>
        {PROVIDERS.filter((provider) => provider === (settings.defaultPaymentProvider ?? 'razorpay')).map((provider) => {
          const meta = GATEWAY_META[provider];
          const mode = activeMode[provider];
          const status = statusFor(provider, mode);
          const formKey = `${provider}:${mode}`;

          return (
            <div key={provider} className={styles.gatewayCard}>
              <div className={styles.gatewayHeader}>
                <span className={styles.gatewayAvatar} style={{ background: meta.color }}>
                  {meta.initial}
                </span>
                <div>
                  <div className={styles.gatewayName}>{meta.label}</div>
                  <div className={styles.gatewayMeta}>{enabledGateways.includes(provider) ? 'Enabled for checkout' : 'Disabled'}</div>
                </div>
                <div className={styles.gatewayHeaderSpacer} />
                {status?.configured && (
                  <Button size="sm" variant="secondary" onClick={() => toggleActive(status)}>
                    {status.isActive ? 'Deactivate override' : 'Activate override'}
                  </Button>
                )}
              </div>

              <div className={styles.modeTabsRow}>
                <Tabs
                  items={MODES.map((m) => ({ id: m, label: m === 'test' ? 'Test Mode' : 'Live Mode' }))}
                  activeId={mode}
                  onChange={(id) => setActiveMode((prev) => ({ ...prev, [provider]: id as GatewayMode }))}
                />
              </div>

              <div className={styles.modeBody}>
                <div className={styles.statusRow}>
                  <Badge variant={status?.configured ? 'success' : 'neutral'}>{status?.configured ? 'Configured' : 'Using env vars'}</Badge>
                  {status?.configured && <Badge variant={status.isActive ? 'accent' : 'neutral'}>{status.isActive ? 'Active override' : 'Inactive'}</Badge>}
                  {status?.maskedKeyId && <span className={styles.maskedKey}>{status.maskedKeyId}</span>}
                </div>

                <div className={styles.credentialGrid}>
                  {CREDENTIAL_FIELDS[provider].map((field) => (
                    <Input
                      key={field.key}
                      label={field.label}
                      type="password"
                      placeholder={status?.configured ? '••••••••' : 'not set'}
                      value={credentialForms[formKey]?.[field.key] ?? ''}
                      onChange={(e) => setCredentialForms((prev) => ({ ...prev, [formKey]: { ...prev[formKey], [field.key]: e.target.value } }))}
                    />
                  ))}
                </div>

                <div className={styles.saveRow}>
                  <span className={styles.updatedAt}>{status?.updatedAt ? `Last updated ${formatFullDate(status.updatedAt)}` : 'Never configured — falls back to env vars'}</span>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Button size="sm" variant="secondary" loading={testingKey === formKey} onClick={() => testConnection(provider, mode)}>
                      Test Connection
                    </Button>
                    <Button size="sm" loading={savingKey === formKey} onClick={() => saveCredentials(provider, mode)}>
                      Save {mode === 'test' ? 'Test' : 'Live'} Credentials
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

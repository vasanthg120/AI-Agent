import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  FiCheckCircle,
  FiGrid,
  FiLink,
  FiPlus,
  FiSettings,
  FiShield,
  FiSliders,
  FiTrash2,
  FiUploadCloud,
  FiZap,
} from 'react-icons/fi';
import { Avatar, Card, Badge, Button, Input, Modal } from '@/components/ui';
import {
  integrationsService,
  resolveManifestAuthType,
  type AuthCredentials,
  type AuthType,
  type ConnectorManifest,
  type CustomIntegration,
  type GmailAccount,
  type ImportConnectorManifestSecrets,
  type OutlookAccount,
  type OutlookOrgAccount,
  type ProviderRule,
  type TenantAuthorizationStatus,
  type TestConnectionResult,
} from '@/services/integrationsService';
import { extractErrorMessage } from '@/utils/errors';
import { ResourceEndpointBuilder } from './ResourceEndpointBuilder';
import styles from './IntegrationsPage.module.css';

// Custom/generic CRM connections aren't one real brand, so this is a
// designed glyph (a hub of connected systems) rather than a fetched logo —
// used for the Custom Integrations section header and each row's tile.
function CustomCrmIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M12 8v6M12 14l-5.2 3M12 14l5.2 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="5.5" cy="18.5" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18.5" cy="18.5" r="2.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

type CardStatus = 'connected' | 'disconnected' | 'error' | 'loading';

interface CardState {
  status: CardStatus;
  detail?: string;
}

// OAuth-based platforms (Salesforce, Slack, HubSpot, ...) aren't offered
// here deliberately — this wizard is only for auth styles that need no
// dedicated consent flow/app registration (see backend/src/integrations/
// auth-methods.ts's comment). Each of those needs its own integration, the
// way Outlook/Gmail/the login providers already have.
const AUTH_TYPE_LABELS: Record<AuthType, string> = {
  apiKey: 'API Key',
  apiKeyBaseUrl: 'Base URL + API Key',
  bearer: 'Bearer Token',
  basic: 'Username + Password (Basic Auth)',
  customHeaders: 'Custom Headers',
};

const AUTH_TYPES: AuthType[] = ['apiKeyBaseUrl', 'apiKey', 'bearer', 'basic', 'customHeaders'];

// Gorilla Dash — a first-class card/modal over the same generic Custom
// Integration flow every other CRM/SaaS uses (customHeaders auth type,
// api.gorilladash.com's own two-header scheme), not a bespoke backend
// integration. See ResourceEndpointBuilder for configuring its People/
// Enquiries/Tribes/Forms/Send-Email endpoints once connected — the Dynamic
// Executor (dynamic-executor.service.ts) runs those, and the AI agent's
// integration_capabilities/integration_execute tools already expose
// whatever gets configured there, for any provider, with no provider-
// specific code on either side.
const GORILLA_DASH_PROVIDER = 'gorilla_dash';
const GORILLA_DASH_BASE_URL = 'https://api.gorilladash.com';
const GORILLA_DASH_API_KEY_HEADER = 'GorillaDash-Api-Key';
const GORILLA_DASH_API_SECRET_HEADER = 'GorillaDash-Api-Secret';

export function IntegrationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [outlookAccounts, setOutlookAccounts] = useState<OutlookAccount[]>([]);
  const [outlookOrgAccounts, setOutlookOrgAccounts] = useState<OutlookOrgAccount[]>([]);
  const [outlookStatus, setOutlookStatus] = useState<CardStatus>('loading');
  const [outlookError, setOutlookError] = useState<string | undefined>();
  const [outlookModalOpen, setOutlookModalOpen] = useState(false);
  const [tenantAuthStatus, setTenantAuthStatus] = useState<TenantAuthorizationStatus | null>(null);
  const [requestingAdminConsent, setRequestingAdminConsent] = useState(false);
  const [gmailAccounts, setGmailAccounts] = useState<GmailAccount[]>([]);
  const [gmailStatus, setGmailStatus] = useState<CardStatus>('loading');
  const [gmailError, setGmailError] = useState<string | undefined>();
  const [gmailModalOpen, setGmailModalOpen] = useState(false);

  // Generic "connect any CRM/SaaS" flow — see integrationsService.ts's
  // ConnectCustomIntegrationPayload / auth-methods.ts on the backend.
  const [customIntegrations, setCustomIntegrations] = useState<CustomIntegration[]>([]);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [customProvider, setCustomProvider] = useState('');
  const [customAuthType, setCustomAuthType] = useState<AuthType>('apiKeyBaseUrl');
  const [customCredentials, setCustomCredentials] = useState<AuthCredentials>({});
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customHealthCheckPath, setCustomHealthCheckPath] = useState('');
  const [customHeadersText, setCustomHeadersText] = useState('');
  const [testingCustom, setTestingCustom] = useState(false);
  const [customTestResult, setCustomTestResult] = useState<TestConnectionResult | null>(null);
  const [savingCustom, setSavingCustom] = useState(false);
  // Smart provider detection (see provider-rules.ts) — null while unknown/
  // not yet looked up, in which case every auth type is offered.
  const [customProviderRule, setCustomProviderRule] = useState<ProviderRule | null>(null);
  // API Integration Engine — which custom integration's resource/endpoint
  // builder modal is open (see ResourceEndpointBuilder.tsx), null when closed.
  const [builderProvider, setBuilderProvider] = useState<string | null>(null);

  // Gorilla Dash — its own dedicated card/modal (2 named fields, not a raw
  // "Header: value" textarea), but wired to the exact same connect/test
  // endpoints as the generic Custom Integrations flow below.
  const [gorillaDashModalOpen, setGorillaDashModalOpen] = useState(false);
  const [gorillaDashApiKey, setGorillaDashApiKey] = useState('');
  const [gorillaDashApiSecret, setGorillaDashApiSecret] = useState('');
  const [testingGorillaDash, setTestingGorillaDash] = useState(false);
  const [gorillaDashTestResult, setGorillaDashTestResult] = useState<TestConnectionResult | null>(null);
  const [savingGorillaDash, setSavingGorillaDash] = useState(false);

  // Bulk connector import — pastes a whole manifest JSON (base URL + an auth
  // template + modules[].actions[]) and creates the credential plus every
  // resource/endpoint from it in one shot (see integrationsService.ts's
  // importConnectorManifest), instead of building one integration by hand
  // via the Add Integration modal above.
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importManifestText, setImportManifestText] = useState('');
  const [importManifest, setImportManifest] = useState<ConnectorManifest | null>(null);
  const [importManifestError, setImportManifestError] = useState<string | null>(null);
  const [importSecrets, setImportSecrets] = useState<ImportConnectorManifestSecrets>({});
  const [importing, setImporting] = useState(false);

  const loadOutlookAccounts = () => {
    integrationsService
      .getOutlookAccounts()
      .then((accounts) => {
        setOutlookAccounts(accounts);
        setOutlookStatus(accounts.length > 0 ? 'connected' : 'disconnected');
      })
      .catch((error) => {
        setOutlookStatus('error');
        setOutlookError(extractErrorMessage(error));
      });
  };

  const loadOutlookOrgAccounts = () => {
    integrationsService
      .getOutlookOrgAccounts()
      .then(setOutlookOrgAccounts)
      .catch(() => {
        // Non-critical — the personal accounts list above still works even
        // if this org-wide view fails to load for some reason.
      });
  };

  const loadTenantAuthStatus = () => {
    integrationsService
      .getOutlookTenantAuthorizationStatus()
      .then(setTenantAuthStatus)
      .catch((error) => {
        // Falls back to null (same as "not yet checked") so the rest of the
        // page still renders, but a genuine load failure now surfaces
        // instead of looking identical to "nothing to show yet".
        setTenantAuthStatus(null);
        toast.error(`Couldn't load tenant authorization status: ${extractErrorMessage(error)}`);
      });
  };

  const loadCustomIntegrations = () => {
    integrationsService
      .listCustomIntegrations()
      .then(setCustomIntegrations)
      .catch((error) => {
        setCustomIntegrations([]);
        toast.error(`Couldn't load custom integrations: ${extractErrorMessage(error)}`);
      });
  };

  const loadGmailAccounts = () => {
    integrationsService
      .getGmailAccounts()
      .then((accounts) => {
        setGmailAccounts(accounts);
        setGmailStatus(accounts.length > 0 ? 'connected' : 'disconnected');
      })
      .catch((error) => {
        setGmailStatus('error');
        setGmailError(extractErrorMessage(error));
      });
  };

  useEffect(() => {
    loadOutlookAccounts();
    loadOutlookOrgAccounts();
    loadTenantAuthStatus();
    loadCustomIntegrations();
    loadGmailAccounts();
  }, []);

  // Landing back here after the full-page Microsoft OAuth round trip (see
  // backend/src/outlook/outlook.controller.ts's callback/adminConsentCallback,
  // which redirect to /integrations?outlook=<status>). Never show the raw
  // Microsoft/AADSTS error text — translate every status into a plain
  // message, and open the Outlook modal automatically so the relevant
  // section (personal accounts, or the admin-consent prompt) is right there.
  useEffect(() => {
    const outlookResult = searchParams.get('outlook');
    if (!outlookResult) return;

    switch (outlookResult) {
      case 'connected':
        toast.success('Outlook connected');
        loadOutlookAccounts();
        loadOutlookOrgAccounts();
        break;
      case 'admin_consent_required':
        toast.error("Your organization's Microsoft admin needs to approve this app first.");
        setOutlookModalOpen(true);
        break;
      case 'admin_consent_granted':
        toast.success('Your organization approved Outlook access — everyone can now connect normally.');
        loadTenantAuthStatus();
        setOutlookModalOpen(true);
        break;
      case 'admin_consent_declined':
        toast.error('Organization approval was not granted.');
        break;
      default:
        toast.error('Could not connect Outlook — please try again.');
    }

    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('outlook');
      return next;
    }, { replace: true });
  }, [searchParams]);

  // Smart provider detection — debounced so it doesn't fire on every
  // keystroke; falls back to "every auth type allowed" (null rule) for
  // anything not yet typed or not recognized, same as the backend's
  // getProviderRule default for unknown providers.
  useEffect(() => {
    if (!customModalOpen || !customProvider.trim()) {
      setCustomProviderRule(null);
      return;
    }
    const timeout = setTimeout(() => {
      integrationsService
        .getProviderRule(customProvider.trim())
        .then((rule) => {
          setCustomProviderRule(rule);
          if (rule.allowedAuthTypes.length > 0 && !rule.allowedAuthTypes.includes(customAuthType)) {
            setCustomAuthType(rule.allowedAuthTypes[0]);
          }
        })
        .catch(() => setCustomProviderRule(null));
    }, 400);
    return () => clearTimeout(timeout);
  }, [customProvider, customModalOpen]);


  // "Header: value" per line, matching how most people paste headers from
  // API docs — parsed into the Record<string,string> the backend expects.
  const parseHeadersText = (text: string): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (name) headers[name] = value;
    }
    return headers;
  };

  const openCustomModal = () => {
    setCustomProvider('');
    setCustomAuthType('apiKeyBaseUrl');
    setCustomCredentials({});
    setCustomBaseUrl('');
    setCustomHealthCheckPath('');
    setCustomHeadersText('');
    setCustomTestResult(null);
    setCustomModalOpen(true);
  };

  const buildCustomPayload = () => ({
    authType: customAuthType,
    baseUrl: customBaseUrl.trim() || undefined,
    healthCheckPath: customHealthCheckPath.trim() || undefined,
    credentials: customAuthType === 'customHeaders' ? { headers: parseHeadersText(customHeadersText) } : customCredentials,
  });

  const handleTestCustomConnection = async () => {
    setTestingCustom(true);
    setCustomTestResult(null);
    try {
      const result = await integrationsService.testCustomIntegrationConnection(
        customProvider.trim() || '_preview',
        buildCustomPayload(),
      );
      setCustomTestResult(result);
    } catch (error) {
      setCustomTestResult({ ok: false, message: extractErrorMessage(error) });
    } finally {
      setTestingCustom(false);
    }
  };

  const handleSaveCustomIntegration = async () => {
    if (!customProvider.trim()) {
      toast.error('Give this integration a name.');
      return;
    }
    setSavingCustom(true);
    try {
      await integrationsService.connectCustomIntegration(customProvider.trim().toLowerCase(), buildCustomPayload());
      toast.success(`${customProvider} connected`);
      setCustomModalOpen(false);
      loadCustomIntegrations();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSavingCustom(false);
    }
  };

  const handleDisconnectCustomIntegration = async (provider: string, label: string) => {
    try {
      await integrationsService.disconnectCredential(provider);
      toast.success(`${label} disconnected`);
      loadCustomIntegrations();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const openGorillaDashModal = () => {
    setGorillaDashApiKey('');
    setGorillaDashApiSecret('');
    setGorillaDashTestResult(null);
    setGorillaDashModalOpen(true);
  };

  const buildGorillaDashPayload = () => ({
    authType: 'customHeaders' as const,
    baseUrl: GORILLA_DASH_BASE_URL,
    credentials: {
      headers: {
        [GORILLA_DASH_API_KEY_HEADER]: gorillaDashApiKey.trim(),
        [GORILLA_DASH_API_SECRET_HEADER]: gorillaDashApiSecret.trim(),
      },
    },
  });

  const handleTestGorillaDash = async () => {
    setTestingGorillaDash(true);
    setGorillaDashTestResult(null);
    try {
      const result = await integrationsService.testCustomIntegrationConnection(GORILLA_DASH_PROVIDER, buildGorillaDashPayload());
      setGorillaDashTestResult(result);
    } catch (error) {
      setGorillaDashTestResult({ ok: false, message: extractErrorMessage(error) });
    } finally {
      setTestingGorillaDash(false);
    }
  };

  const handleSaveGorillaDash = async () => {
    if (!gorillaDashApiKey.trim() || !gorillaDashApiSecret.trim()) {
      toast.error('Both API Key and API Secret are required.');
      return;
    }
    setSavingGorillaDash(true);
    try {
      await integrationsService.connectCustomIntegration(GORILLA_DASH_PROVIDER, buildGorillaDashPayload());
      toast.success('Gorilla Dash connected');
      setGorillaDashModalOpen(false);
      loadCustomIntegrations();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSavingGorillaDash(false);
    }
  };

  const handleDisconnectGorillaDash = async () => {
    try {
      await integrationsService.disconnectCredential(GORILLA_DASH_PROVIDER);
      toast.success('Gorilla Dash disconnected');
      loadCustomIntegrations();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const openImportModal = () => {
    setImportManifestText('');
    setImportManifest(null);
    setImportManifestError(null);
    setImportSecrets({});
    setImportModalOpen(true);
  };

  // Live-parses the pasted JSON as the user types/pastes it, so the preview,
  // detected auth type, and matching credential input all appear before
  // Import is clicked — no network round trip needed, this is pure client-
  // side JSON.parse + shape checking.
  const handleManifestTextChange = (text: string) => {
    setImportManifestText(text);
    setImportSecrets({});
    if (!text.trim()) {
      setImportManifest(null);
      setImportManifestError(null);
      return;
    }
    try {
      const parsed = JSON.parse(text) as ConnectorManifest;
      if (!parsed.connector_id || !parsed.base_url || !Array.isArray(parsed.modules)) {
        setImportManifest(null);
        setImportManifestError('Missing connector_id, base_url, or modules — check the manifest shape.');
        return;
      }
      setImportManifest(parsed);
      setImportManifestError(null);
    } catch {
      setImportManifest(null);
      setImportManifestError('Not valid JSON yet.');
    }
  };

  const importActionCount = (manifest: ConnectorManifest) =>
    manifest.modules.reduce((sum, m) => sum + m.actions.length, 0);

  const handleImportConnector = async () => {
    if (!importManifest) return;
    setImporting(true);
    try {
      const result = await integrationsService.importConnectorManifest(importManifest, importSecrets);
      toast.success(
        `${importManifest.display_name || result.provider} imported — ${result.resourcesCreated} module(s), ${result.endpointsCreated} action(s)`,
      );
      setImportModalOpen(false);
      loadCustomIntegrations();
      // Land the user straight inside their newly-imported actions so they
      // can spot-check/Test any of them right away, rather than just a
      // success toast.
      setBuilderProvider(result.provider);
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setImporting(false);
    }
  };

  const handleConnectOutlook = async () => {
    try {
      const url = await integrationsService.getOutlookConnectUrl();
      window.location.href = url;
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const handleSetActiveOutlookAccount = async (email: string) => {
    try {
      await integrationsService.setActiveOutlookAccount(email);
      toast.success(`${email} is now the active Outlook account`);
      loadOutlookAccounts();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const handleStartAdminConsent = async () => {
    setRequestingAdminConsent(true);
    try {
      const url = await integrationsService.getOutlookAdminConsentUrl();
      window.location.href = url;
    } catch (error) {
      toast.error(extractErrorMessage(error));
      setRequestingAdminConsent(false);
    }
  };

  const handleDisconnectOutlookAccount = async (email: string) => {
    try {
      await integrationsService.disconnectOutlookAccount(email);
      toast.success(`${email} disconnected`);
      loadOutlookAccounts();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const handleConnectGmail = async () => {
    try {
      const url = await integrationsService.getGmailConnectUrl();
      window.location.href = url;
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const handleSetActiveGmailAccount = async (email: string) => {
    try {
      await integrationsService.setActiveGmailAccount(email);
      toast.success(`${email} is now the active Gmail account`);
      loadGmailAccounts();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const handleDisconnectGmailAccount = async (email: string) => {
    try {
      await integrationsService.disconnectGmailAccount(email);
      toast.success(`${email} disconnected`);
      loadGmailAccounts();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  // Shared across Outlook/Gmail personal + org-wide lists — 'needs_reauth'
  // means python-agent's refresh loop found the grant revoked/expired (see
  // outlook_store.py/gmail_store.py) and reconnecting is the only fix.
  const accountBadge = (account: { isActive: boolean; status: 'connected' | 'needs_reauth' }) => {
    if (account.status === 'needs_reauth') {
      return (
        <Badge variant="danger" dot>
          Needs reconnecting
        </Badge>
      );
    }
    return account.isActive ? (
      <Badge variant="success" dot>Active</Badge>
    ) : (
      <Badge variant="neutral" dot>Connected</Badge>
    );
  };

  const badgeFor = (state: CardState) => {
    if (state.status === 'loading') return <Badge variant="neutral">Checking...</Badge>;
    if (state.status === 'connected') return <Badge variant="success" dot>Connected</Badge>;
    if (state.status === 'error') return <Badge variant="danger" dot>Connection error</Badge>;
    return <Badge variant="neutral" dot>Not connected</Badge>;
  };

  // Gorilla Dash lives in the same customIntegrations list every generic
  // Custom Integration does (see loadCustomIntegrations) — no separate
  // status fetch needed. Excluded from the generic list below since it now
  // has its own dedicated card instead.
  const gorillaDashIntegration = customIntegrations.find((i) => i.provider === GORILLA_DASH_PROVIDER);
  const otherCustomIntegrations = customIntegrations.filter((i) => i.provider !== GORILLA_DASH_PROVIDER);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <span className={styles.headerBadge}>
            <FiZap size={12} />
            Connected Services
          </span>
          <h1 className={styles.pageTitle}>Integrations</h1>
          <p className={styles.pageSubtitle}>
            Connect the AI model, mailboxes, and business systems HaiVE uses to do real work across your
            organization — chat and analysis, email, and any CRM or SaaS tool with an API.
          </p>
        </div>
      </div>

      <div>
        <div className={styles.sectionEyebrow}>Core Connections</div>
        <div className={styles.grid}>
          {/* Gmail — real Google OAuth delegated flow, mirrors Outlook below */}
          <Card className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.logoTile}>
                <img src="/integrations/gmail.svg" alt="" />
              </span>
              <div className={styles.cardTitleRow}>
                <div className={styles.cardName}>Gmail</div>
                <div className={styles.cardCategory}>Communication</div>
              </div>
              {badgeFor({ status: gmailStatus, detail: gmailError })}
            </div>
            <p className={styles.cardDescription}>Email via the Gmail API — analyzed using Claude.</p>
            {gmailStatus === 'connected' && (
              <div className={styles.keyPreview}>
                {gmailAccounts.find((a) => a.isActive)?.email ?? gmailAccounts[0].email}
                {gmailAccounts.length > 1 && ` (+${gmailAccounts.length - 1} more)`}
              </div>
            )}
            {gmailStatus === 'error' && gmailError && <div className={styles.keyPreview}>{gmailError}</div>}
            <div className={styles.cardFooter}>
              {gmailStatus === 'connected' ? (
                <Button size="sm" variant="secondary" leftIcon={<FiSettings />} onClick={() => setGmailModalOpen(true)}>
                  Manage Accounts
                </Button>
              ) : (
                <Button size="sm" leftIcon={<FiCheckCircle />} onClick={handleConnectGmail}>
                  Connect
                </Button>
              )}
            </div>
          </Card>

          {/* Outlook — real Microsoft Graph delegated OAuth flow, supports multiple connected accounts */}
          <Card className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.logoTile}>
                <img src="/integrations/outlook.svg" alt="" />
              </span>
              <div className={styles.cardTitleRow}>
                <div className={styles.cardName}>Microsoft Outlook</div>
                <div className={styles.cardCategory}>Communication</div>
              </div>
              {badgeFor({ status: outlookStatus, detail: outlookError })}
            </div>
            <p className={styles.cardDescription}>Email and calendar via Microsoft Graph — analyzed using Claude.</p>
            {outlookStatus === 'connected' && (
              <div className={styles.keyPreview}>
                {outlookAccounts.find((a) => a.isActive)?.email ?? outlookAccounts[0].email}
                {outlookAccounts.length > 1 && ` (+${outlookAccounts.length - 1} more)`}
              </div>
            )}
            {outlookStatus === 'error' && outlookError && <div className={styles.keyPreview}>{outlookError}</div>}
            <div className={styles.cardFooter}>
              {outlookStatus === 'connected' ? (
                <Button size="sm" variant="secondary" leftIcon={<FiSettings />} onClick={() => setOutlookModalOpen(true)}>
                  Manage Accounts
                </Button>
              ) : (
                <Button size="sm" leftIcon={<FiCheckCircle />} onClick={handleConnectOutlook}>
                  Connect
                </Button>
              )}
            </div>
          </Card>
        </div>
      </div>

      <div>
        <div className={styles.sectionEyebrow}>Business Systems</div>
        <div className={styles.grid}>
          {/* Gorilla Dash — a dedicated card over the same generic Custom
              Integration flow (customHeaders auth) every other CRM/SaaS
              uses; see buildGorillaDashPayload/handleSaveGorillaDash above. */}
          <Card className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={clsx(styles.logoTile, styles.logoTileGorillaDash)}>
                <img src="/integrations/gorilla-dash.png" alt="" />
              </span>
              <div className={styles.cardTitleRow}>
                <div className={styles.cardName}>Gorilla Dash</div>
                <div className={styles.cardCategory}>CRM</div>
              </div>
              {badgeFor({ status: gorillaDashIntegration ? 'connected' : 'disconnected' })}
            </div>
            <p className={styles.cardDescription}>Sync people, enquiries, and tribe data — connect it to your AI Agent.</p>
            {gorillaDashIntegration?.baseUrl && <div className={styles.keyPreview}>{gorillaDashIntegration.baseUrl}</div>}
            <div className={styles.cardFooter}>
              {gorillaDashIntegration ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<FiSliders />}
                    onClick={() => setBuilderProvider(GORILLA_DASH_PROVIDER)}
                  >
                    Manage Resources
                  </Button>
                  <Button size="sm" variant="ghost" leftIcon={<FiTrash2 />} onClick={handleDisconnectGorillaDash}>
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button size="sm" leftIcon={<FiLink />} onClick={openGorillaDashModal}>
                  Connect
                </Button>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Custom Integrations — connect any CRM/SaaS via API Key, Bearer
          Token, Basic Auth, or Custom Headers. OAuth-based platforms need
          their own dedicated flow (like Outlook/Gmail above) and aren't
          offered here. */}
      <Card className={styles.customSection}>
        <div className={styles.customHeader}>
          <div className={styles.customHeaderText}>
            <span className={styles.customHeaderIcon}>
              <CustomCrmIcon size={20} />
            </span>
            <div>
              <div className={styles.sectionTitle}>Custom Integrations</div>
              <p className={styles.sectionSubtitle}>Connect any REST API with an API key, bearer token, basic auth, or custom headers.</p>
            </div>
          </div>
          <div className={styles.customActions}>
            <Button size="sm" variant="secondary" leftIcon={<FiUploadCloud />} onClick={openImportModal}>
              Import Connector Config
            </Button>
            <Button size="sm" leftIcon={<FiLink />} onClick={openCustomModal}>
              Add Integration
            </Button>
          </div>
        </div>
        {otherCustomIntegrations.length === 0 ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyStateIcon}>
              <FiGrid size={20} />
            </span>
            <p className={styles.emptyStateText}>
              No custom integrations yet. Connect a CRM, SaaS tool, or internal system — with an API key, bearer
              token, basic auth, or custom headers — or import a connector config to set one up in one shot.
            </p>
          </div>
        ) : (
          <div className={styles.accountList}>
            {otherCustomIntegrations.map((integration) => (
              <div key={integration.provider} className={styles.accountRow}>
                <div className={styles.accountRowMain}>
                  <Avatar
                    name={integration.label || integration.provider}
                    size="md"
                    color="linear-gradient(135deg, #8b5cf6 0%, #4c1d95 100%)"
                  />
                  <div>
                    <div className={styles.accountEmail}>{integration.label || integration.provider}</div>
                    <span className={styles.accountOwner}>
                      {integration.authType ? AUTH_TYPE_LABELS[integration.authType] : 'API Key'}
                      {integration.baseUrl ? ` · ${integration.baseUrl}` : ''}
                    </span>
                  </div>
                </div>
                <div className={styles.accountActions}>
                  <Badge variant="success" dot>
                    Connected
                  </Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<FiSliders />}
                    onClick={() => setBuilderProvider(integration.provider)}
                  >
                    Manage Resources
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<FiTrash2 />}
                    onClick={() => handleDisconnectCustomIntegration(integration.provider, integration.label || integration.provider)}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {builderProvider && (
        <ResourceEndpointBuilder provider={builderProvider} open onClose={() => setBuilderProvider(null)} />
      )}

      {customModalOpen && (
        <Modal
          open
          onClose={() => setCustomModalOpen(false)}
          title="Connect a Custom Integration"
          description="Connect any REST API using the authentication method it supports."
        >
          <div className={styles.accountList}>
            <Input
              label="Integration name"
              placeholder="e.g. salesforce, zoho, my-internal-tool"
              value={customProvider}
              onChange={(e) => setCustomProvider(e.target.value)}
              autoFocus
            />

            {customProviderRule?.note && (
              <div className={styles.testResultFail} style={{ background: 'transparent' }}>
                {customProviderRule.note}
              </div>
            )}

            {!customProviderRule?.dedicatedFlowPath && (
              <>
                <div>
                  <span className={styles.fieldLabel}>Authentication method</span>
                  <select
                    className={styles.select}
                    value={customAuthType}
                    onChange={(e) => {
                      setCustomAuthType(e.target.value as AuthType);
                      setCustomTestResult(null);
                    }}
                  >
                    {(customProviderRule?.allowedAuthTypes.length ? customProviderRule.allowedAuthTypes : AUTH_TYPES).map(
                      (type) => (
                        <option key={type} value={type}>
                          {AUTH_TYPE_LABELS[type]}
                        </option>
                      ),
                    )}
                  </select>
                </div>

                {(customAuthType === 'apiKeyBaseUrl' || customAuthType === 'apiKey') && (
                  <Input
                    label="API key"
                    type="password"
                    value={customCredentials.apiKey ?? ''}
                    onChange={(e) => setCustomCredentials((c) => ({ ...c, apiKey: e.target.value }))}
                  />
                )}
                {customAuthType === 'bearer' && (
                  <Input
                    label="Bearer token"
                    type="password"
                    value={customCredentials.bearerToken ?? ''}
                    onChange={(e) => setCustomCredentials((c) => ({ ...c, bearerToken: e.target.value }))}
                  />
                )}
                {customAuthType === 'basic' && (
                  <>
                    <Input
                      label="Username"
                      value={customCredentials.username ?? ''}
                      onChange={(e) => setCustomCredentials((c) => ({ ...c, username: e.target.value }))}
                    />
                    <Input
                      label="Password"
                      type="password"
                      value={customCredentials.password ?? ''}
                      onChange={(e) => setCustomCredentials((c) => ({ ...c, password: e.target.value }))}
                    />
                  </>
                )}
                {customAuthType === 'customHeaders' && (
                  <div>
                    <span className={styles.fieldLabel}>Headers (one "Name: value" per line)</span>
                    <textarea
                      className={styles.select}
                      style={{ height: 88, paddingTop: 'var(--space-2)', paddingBottom: 'var(--space-2)' }}
                      placeholder={'X-Api-Key: abc123\nX-Client-Id: myapp'}
                      value={customHeadersText}
                      onChange={(e) => setCustomHeadersText(e.target.value)}
                    />
                  </div>
                )}

                <Input
                  label="Base URL"
                  placeholder="https://api.example.com"
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                />
                <Input
                  label="Health check path (optional)"
                  placeholder="/health"
                  value={customHealthCheckPath}
                  onChange={(e) => setCustomHealthCheckPath(e.target.value)}
                />

                {customTestResult && (
                  <div className={customTestResult.ok ? styles.testResultOk : styles.testResultFail}>
                    {customTestResult.message}
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                  <Button variant="secondary" loading={testingCustom} onClick={handleTestCustomConnection}>
                    Test Connection
                  </Button>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Button variant="ghost" onClick={() => setCustomModalOpen(false)}>
                      Cancel
                    </Button>
                    <Button loading={savingCustom} onClick={handleSaveCustomIntegration}>
                      Save
                    </Button>
                  </div>
                </div>
              </>
            )}

            {customProviderRule?.dedicatedFlowPath && (
              <Button variant="ghost" onClick={() => setCustomModalOpen(false)}>
                Close
              </Button>
            )}
          </div>
        </Modal>
      )}

      {importModalOpen && (
        <Modal
          open
          onClose={() => setImportModalOpen(false)}
          title="Import Connector Config"
          description="Paste a connector manifest — base URL, auth template, and modules/actions — to create the integration and every configured action in one shot, instead of building it by hand."
        >
          <div className={styles.accountList}>
            <div>
              <span className={styles.fieldLabel}>Connector manifest (JSON)</span>
              <textarea
                className={styles.select}
                style={{ height: 200, paddingTop: 'var(--space-2)', paddingBottom: 'var(--space-2)', fontFamily: 'monospace', fontSize: '12px' }}
                placeholder='{"connector_id": "my_crm", "base_url": "https://api...", "auth": {...}, "modules": [...]}'
                value={importManifestText}
                onChange={(e) => handleManifestTextChange(e.target.value)}
                autoFocus
              />
            </div>

            {importManifestError && <div className={styles.testResultFail}>{importManifestError}</div>}

            {importManifest && (
              <>
                <div className={styles.testResultOk}>
                  {importManifest.display_name || importManifest.connector_id} — {importManifest.base_url} ·{' '}
                  {importManifest.modules.length} module(s), {importActionCount(importManifest)} action(s)
                </div>

                {(() => {
                  const detectedAuthType = resolveManifestAuthType(importManifest.auth);
                  return (
                    <>
                      <div className={styles.testResultFail} style={{ background: 'transparent' }}>
                        Detected auth type: {AUTH_TYPE_LABELS[detectedAuthType]}
                        {importManifest.auth.note ? ` — ${importManifest.auth.note}` : ''}
                      </div>

                      {detectedAuthType === 'basic' ? (
                        <>
                          <Input
                            label="Username"
                            value={importSecrets.username ?? ''}
                            onChange={(e) => setImportSecrets((s) => ({ ...s, username: e.target.value }))}
                          />
                          <Input
                            label="Password"
                            type="password"
                            value={importSecrets.password ?? ''}
                            onChange={(e) => setImportSecrets((s) => ({ ...s, password: e.target.value }))}
                          />
                        </>
                      ) : (
                        <Input
                          label="API key / token"
                          type="password"
                          placeholder="Your CRM's API key"
                          value={importSecrets.apiKeyValue ?? ''}
                          onChange={(e) => setImportSecrets((s) => ({ ...s, apiKeyValue: e.target.value }))}
                        />
                      )}
                    </>
                  );
                })()}
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
              <Button variant="ghost" onClick={() => setImportModalOpen(false)}>
                Cancel
              </Button>
              <Button loading={importing} disabled={!importManifest} onClick={handleImportConnector}>
                Import
              </Button>
            </div>
          </div>
        </Modal>
      )}


      {gorillaDashModalOpen && (
        <Modal
          open
          onClose={() => setGorillaDashModalOpen(false)}
          title="Gorilla Dash Integration"
          description="Paste your Gorilla Dash API Key and API Secret. They're encrypted and stored server-side — never exposed to the browser."
        >
          <div className={styles.accountList}>
            <Input
              label="API Key"
              type="password"
              value={gorillaDashApiKey}
              onChange={(e) => {
                setGorillaDashApiKey(e.target.value);
                setGorillaDashTestResult(null);
              }}
              autoFocus
            />
            <Input
              label="API Secret"
              type="password"
              value={gorillaDashApiSecret}
              onChange={(e) => {
                setGorillaDashApiSecret(e.target.value);
                setGorillaDashTestResult(null);
              }}
            />

            {gorillaDashTestResult && (
              <div className={gorillaDashTestResult.ok ? styles.testResultOk : styles.testResultFail}>
                {gorillaDashTestResult.message}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
              <Button
                variant="secondary"
                loading={testingGorillaDash}
                disabled={!gorillaDashApiKey.trim() || !gorillaDashApiSecret.trim()}
                onClick={handleTestGorillaDash}
              >
                Test Connection
              </Button>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button variant="ghost" onClick={() => setGorillaDashModalOpen(false)}>
                  Cancel
                </Button>
                <Button loading={savingGorillaDash} onClick={handleSaveGorillaDash}>
                  Save Connection
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {outlookModalOpen && (
        <Modal
          open
          onClose={() => setOutlookModalOpen(false)}
          title="Outlook Account Management"
          description="Manage Outlook accounts connected to your business, and connect new ones."
        >
          <div className={styles.accountList}>
            {outlookAccounts.map((account) => (
              <div key={account.email} className={styles.accountRow}>
                <div>
                  <div className={styles.accountEmail}>{account.email}</div>
                  {accountBadge(account)}
                </div>
                <div className={styles.accountActions}>
                  {!account.isActive && (
                    <Button size="sm" variant="secondary" onClick={() => handleSetActiveOutlookAccount(account.email)}>
                      Set Active
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<FiTrash2 />}
                    onClick={() => handleDisconnectOutlookAccount(account.email)}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {outlookOrgAccounts.length > 0 && (
            <>
              <div className={styles.sectionDivider}>Connected across your organization</div>
              <div className={styles.accountList}>
                {outlookOrgAccounts.map((account) => (
                  <div key={account.email} className={styles.accountRow}>
                    <div>
                      <div className={styles.accountEmail}>{account.email}</div>
                      <span className={styles.accountOwner}>
                        {account.ownerName} · {account.ownerEmail}
                      </span>
                    </div>
                    {accountBadge(account)}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className={styles.sectionDivider}>Organization approval</div>
          {tenantAuthStatus?.authorized ? (
            <div className={styles.accountRow}>
              <div>
                <span className={styles.accountOwner}>
                  Approved by {tenantAuthStatus.authorizedByEmail} — teammates in your organization can connect
                  Outlook without an admin approval prompt.
                </span>
              </div>
              <Badge variant="success" dot>
                Approved
              </Badge>
            </div>
          ) : (
            <div className={styles.accountRow}>
              <div>
                <span className={styles.accountOwner}>
                  If your organization's Microsoft admin policy requires it, someone with Microsoft admin rights
                  can approve Pantheras AI once for everyone — after that, teammates connect with a normal login,
                  no approval prompt.
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<FiShield />}
                loading={requestingAdminConsent}
                onClick={handleStartAdminConsent}
              >
                Approve for organization
              </Button>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-5)' }}>
            <Button variant="ghost" onClick={() => setOutlookModalOpen(false)}>
              Close
            </Button>
            <Button leftIcon={<FiPlus />} onClick={handleConnectOutlook}>
              Connect New Account
            </Button>
          </div>
        </Modal>
      )}

      {gmailModalOpen && (
        <Modal
          open
          onClose={() => setGmailModalOpen(false)}
          title="Gmail Account Management"
          description="Manage Gmail accounts connected to your business, and connect new ones."
        >
          <div className={styles.accountList}>
            {gmailAccounts.map((account) => (
              <div key={account.email} className={styles.accountRow}>
                <div>
                  <div className={styles.accountEmail}>{account.email}</div>
                  {accountBadge(account)}
                </div>
                <div className={styles.accountActions}>
                  {!account.isActive && (
                    <Button size="sm" variant="secondary" onClick={() => handleSetActiveGmailAccount(account.email)}>
                      Set Active
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<FiTrash2 />}
                    onClick={() => handleDisconnectGmailAccount(account.email)}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-5)' }}>
            <Button variant="ghost" onClick={() => setGmailModalOpen(false)}>
              Close
            </Button>
            <Button leftIcon={<FiPlus />} onClick={handleConnectGmail}>
              Connect New Account
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

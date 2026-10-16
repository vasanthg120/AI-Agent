import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  FiAlertCircle,
  FiClock,
  FiDatabase,
  FiGlobe,
  FiKey,
  FiLink,
  FiMail,
  FiPlus,
  FiRefreshCw,
  FiSettings,
  FiShield,
  FiSliders,
  FiStar,
  FiTrash2,
  FiUploadCloud,
  FiUsers,
} from 'react-icons/fi';
import { Avatar, Badge, Button, EmptyState, Input, Modal, Skeleton } from '@/components/ui';
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
import { crmIntegrationsService, type CrmIntegration } from '@/services/crmIntegrationsService';
import { formatRelativeTime } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { isAiRoleAccount, isSalesperson } from '@/utils/access';
import { usersService, type AdminUser } from '@/services/usersService';
import { useAuthStore } from '@/stores/authStore';
import { CloudStorageSection } from './CloudStorageSection';
import { CrmManageModal } from './CrmManageModal';
import { CrmSetupWizard } from './CrmSetupWizard';
import { IntegrationCard, LetterLogo, type CardTone } from './IntegrationCard';
import { ResourceEndpointBuilder } from './ResourceEndpointBuilder';
import styles from './IntegrationsPage.module.css';
import ui from './integrations.module.css';

type CardStatus = 'connected' | 'disconnected' | 'error' | 'loading';

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

// CRMs have their own provider-aware setup (see CrmSetupWizard / the
// crm-integrations API): however one was saved in the past ("crm",
// "prospectconnect", "gorilla_dash"…), it is shown once, as that CRM — never
// again as a row in the generic list below.
const CRM_CREDENTIAL = /^(crm|prospectconnect|gorilla[_-]?dash|zapier)$/i;
const CRM_LOGO: Record<string, string> = {
  prospectconnect: '/integrations/pantheras.png',
  hoops: '/integrations/hoops.png',
  gorilladash: '/integrations/gorilla-dash.png',
};
const MODULE_TERM: Record<string, string> = { deals: 'deal', quotes: 'quote', contacts: 'contact', accounts: 'account' };
const pluralOf = (word: string) => (/(s|x|ch|sh)$/i.test(word) ? `${word}es` : /[^aeiou]y$/i.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`);

export function IntegrationsPage() {
  const currentUser = useAuthStore((state) => state.user);
  const [searchParams, setSearchParams] = useSearchParams();
  // Under Settings the layout already shows this page's title; on its own route the page shows it itself.
  const insideSettings = useLocation().pathname.startsWith('/settings');
  const [outlookAccounts, setOutlookAccounts] = useState<OutlookAccount[]>([]);
  // Who a mailbox can be handed to. Only admins can list users; for everyone else the picker is simply not shown.
  const [teamMembers, setTeamMembers] = useState<AdminUser[]>([]);
  useEffect(() => {
    usersService
      .list()
      .then((users) => setTeamMembers(users.filter(isSalesperson)))
      .catch(() => setTeamMembers([]));
  }, []);
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
  // CRMs — what can be connected, what each needs, how each connected one is doing.
  const queryClient = useQueryClient();
  const {
    data: crmIntegrations,
    isLoading: crmLoading,
    isError: crmFailed,
    error: crmError,
    refetch: refetchCrm,
  } = useQuery({ queryKey: ['crm-integrations'], queryFn: crmIntegrationsService.list, refetchInterval: 60_000 });
  const [setupFor, setSetupFor] = useState<CrmIntegration | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);


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

  const syncCrm = async (integration: CrmIntegration) => {
    setSyncingId(integration.id);
    try {
      const { result } = await crmIntegrationsService.syncNow(integration.id);
      if (result.status === 'error') toast.error(result.error ?? 'The sync didn’t finish.', { duration: 8_000 });
      else toast.success(`${integration.label} is up to date`);
    } catch (error) {
      toast.error(extractErrorMessage(error), { duration: 8_000 });
    } finally {
      setSyncingId(null);
      void queryClient.invalidateQueries({ queryKey: ['crm-integrations'] });
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

  // The team dashboards count a mailbox's email as the work of whoever handles it.
  const handleSetOutlookHandler = async (email: string, userId: string | null) => {
    try {
      await integrationsService.setOutlookAccountHandler(email, userId);
      const member = teamMembers.find((m) => m.id === userId);
      toast.success(member ? `${email} now counts as ${member.name}’s email work` : `${email} counts as your own email work`);
      loadOutlookAccounts();
    } catch (err) {
      toast.error(extractErrorMessage(err));
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

  const otherCustomIntegrations = customIntegrations.filter((i) => !CRM_CREDENTIAL.test(i.provider));
  const crmList = crmIntegrations ?? [];
  const connectedCrms = crmList.filter((i) => i.status !== 'not_connected');
  const availableCrms = crmList.filter((i) => i.status === 'not_connected');
  const managed = crmList.find((i) => i.id === manageId) ?? null;
  const connectedCount =
    connectedCrms.length +
    (outlookStatus === 'connected' ? 1 : 0) +
    (gmailStatus === 'connected' ? 1 : 0) +
    otherCustomIntegrations.length;
  const needsAttention = connectedCrms.filter((i) => i.status === 'needs_attention').length + (outlookStatus === 'error' ? 1 : 0) + (gmailStatus === 'error' ? 1 : 0);

  const crmLogo = (integration: CrmIntegration) =>
    CRM_LOGO[integration.id] ? <img src={CRM_LOGO[integration.id]} alt="" /> : <LetterLogo name={integration.label} color="#6b7280" />;

  const crmTone = (integration: CrmIntegration): CardTone =>
    integration.status === 'needs_attention'
      ? 'attention'
      : integration.status === 'waiting'
        ? 'waiting'
        : integration.status === 'connected'
          ? 'connected'
          : 'idle';

  const crmStatus = (integration: CrmIntegration) =>
    integration.status === 'needs_attention'
      ? ({ label: 'Needs attention', variant: 'danger' } as const)
      : integration.status === 'waiting'
        ? ({ label: 'Waiting for data', variant: 'warning' } as const)
        : integration.status === 'connected'
          ? ({ label: 'Connected', variant: 'success' } as const)
          : undefined;

  const crmFacts = (integration: CrmIntegration) => {
    const source = integration.source;
    if (!source) return undefined;
    const records = Object.entries(source.records)
      .filter(([, count]) => count > 0)
      .map(([module, count]) => `${count.toLocaleString()} ${pluralOf(source.terminology[MODULE_TERM[module]] ?? module).toLowerCase()}`);
    return [
      {
        icon: FiClock,
        text: source.lastSyncAt
          ? `${integration.connection === 'push' ? 'Last record' : 'Last synced'} ${formatRelativeTime(source.lastSyncAt)}`
          : integration.connection === 'push'
            ? 'No records received yet'
            : 'Not synced yet',
      },
      // A CRM that hasn't sent anything yet already says so in the line above.
      ...(records.length > 0 || source.lastSyncAt ? [{ icon: FiDatabase, text: records.length > 0 ? records.join(' · ') : 'No records yet' }] : []),
      ...(source.isDefault ? [{ icon: FiStar, text: 'Shown on dashboards' }] : []),
    ];
  };

  const crmCard = (integration: CrmIntegration) => {
    const connected = integration.status !== 'not_connected';
    return (
      <IntegrationCard
        key={integration.id}
        logo={crmLogo(integration)}
        name={integration.label}
        tagline={integration.connection === 'push' ? 'Sends new records live' : 'Synced automatically'}
        tone={crmTone(integration)}
        status={crmStatus(integration)}
        // The card already carries the name: "Hoops — new customers…" reads as "New customers…".
        description={connected ? undefined : integration.description.replace(/^[^—]+—\s*/, '').replace(/^./, (c) => c.toUpperCase())}
        highlights={connected ? undefined : integration.setup.provides.slice(0, 3)}
        facts={crmFacts(integration)}
        problem={integration.source?.error?.message}
        actions={
          !connected ? (
            <Button size="sm" leftIcon={<FiLink />} onClick={() => setSetupFor(integration)}>
              Connect
            </Button>
          ) : (
            <>
              <Button size="sm" variant="secondary" leftIcon={<FiSettings />} onClick={() => setManageId(integration.id)}>
                Manage
              </Button>
              {integration.status === 'waiting' ? (
                <Button size="sm" onClick={() => setSetupFor(integration)}>
                  Finish setup
                </Button>
              ) : integration.source?.error?.kind === 'auth' ? (
                <Button size="sm" onClick={() => setSetupFor(integration)}>
                  Reconnect
                </Button>
              ) : integration.connection === 'pull' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={<FiRefreshCw />}
                  loading={syncingId === integration.id}
                  onClick={() => void syncCrm(integration)}
                >
                  Sync now
                </Button>
              ) : null}
            </>
          )
        }
      />
    );
  };

  const mailCard = (
    kind: 'outlook' | 'gmail',
    status: CardStatus,
    accounts: { email: string; isActive: boolean }[],
    onConnect: () => void,
    onManage: () => void,
  ) => (
    <IntegrationCard
      key={kind}
      logo={<img src={`/integrations/${kind}.svg`} alt="" />}
      name={kind === 'outlook' ? 'Microsoft Outlook' : 'Gmail'}
      tagline={kind === 'outlook' ? 'Email and calendar' : 'Email'}
      tone={status === 'connected' ? 'connected' : status === 'error' ? 'attention' : 'idle'}
      status={
        status === 'connected'
          ? { label: 'Connected', variant: 'success' }
          : status === 'error'
            ? { label: 'Needs attention', variant: 'danger' }
            : undefined
      }
      description={
        status === 'connected' || status === 'error'
          ? undefined
          : 'HaiVE reads your inbox, sorts what needs a reply and drafts answers for you to approve.'
      }
      highlights={
        status === 'connected' || status === 'error'
          ? undefined
          : kind === 'outlook'
            ? ['AI Email Inbox', 'Follow-up tracking', 'Calendar and meetings']
            : ['AI Email Inbox', 'Follow-up tracking']
      }
      facts={
        status === 'connected' && accounts.length > 0
          ? [
              { icon: FiMail, text: (accounts.find((a) => a.isActive) ?? accounts[0]).email },
              ...(accounts.length > 1 ? [{ icon: FiUsers, text: `${accounts.length} mailboxes connected` }] : []),
              { icon: FiClock, text: 'Checked every 30 minutes' },
            ]
          : undefined
      }
      problem={status === 'error' ? 'HaiVE couldn’t check this connection. Reconnect the account to restore it.' : undefined}
      actions={
        status === 'connected' ? (
          <Button size="sm" variant="secondary" leftIcon={<FiSettings />} onClick={onManage}>
            Manage accounts
          </Button>
        ) : (
          <Button size="sm" leftIcon={<FiLink />} loading={status === 'loading'} onClick={onConnect}>
            {status === 'error' ? 'Reconnect' : 'Connect'}
          </Button>
        )
      }
    />
  );
  // The raw connection errors stay out of the card (it says what to do instead); kept for the account dialogs.
  void outlookError;
  void gmailError;

  const mailConnectedCount = (outlookStatus === 'connected' ? 1 : 0) + (gmailStatus === 'connected' ? 1 : 0);
  // Connected first, so what's in use is always at the top of its section.
  const crmOrdered = [...connectedCrms, ...availableCrms];
  const totalRecords = connectedCrms.reduce((sum, i) => sum + (i.source?.totalRecords ?? 0), 0);
  const dashboardCrm = connectedCrms.find((i) => i.source?.isDefault);

  // An account tied to an AI role is here for one thing: connecting its own mailbox.
  const emailOnly = isAiRoleAccount(currentUser);

  return (
    <div className={styles.page}>
      {!insideSettings && (
        <div className={ui.pageHeader}>
          <div>
            <h1>Integrations</h1>
            <p>{emailOnly ? 'Connect your own mailbox for the AI Email Inbox.' : 'Connect the tools your organization uses with HaiVE.'}</p>
          </div>
        </div>
      )}

      {!emailOnly && (
        <>
      <div className={ui.overview}>
        <div>
          <span className={ui.overviewIcon}>
            <FiDatabase aria-hidden />
          </span>
          <div>
            <strong>{connectedCrms.length === 0 ? 'No CRM connected' : connectedCrms.map((i) => i.label).join(', ')}</strong>
            <span>
              {connectedCrms.length === 0
                ? 'Connect your CRM to see customers and sales in HaiVE'
                : `${totalRecords.toLocaleString()} records in HaiVE${dashboardCrm ? ` · dashboards show ${dashboardCrm.label}` : ''}`}
            </span>
          </div>
        </div>
        <div>
          <span className={ui.overviewIcon}>
            <FiMail aria-hidden />
          </span>
          <div>
            <strong>{mailConnectedCount === 0 ? 'No mailbox connected' : `${outlookAccounts.length + gmailAccounts.length} mailbox${outlookAccounts.length + gmailAccounts.length === 1 ? '' : 'es'} connected`}</strong>
            <span>{mailConnectedCount === 0 ? 'Connect email for the AI Email Inbox' : 'Feeding the AI Email Inbox and follow-ups'}</span>
          </div>
        </div>
        <div className={ui.overviewStatus}>
          <Badge variant={connectedCount > 0 ? 'success' : 'neutral'} dot>
            {connectedCount} connected
          </Badge>
          {needsAttention > 0 && (
            <Badge variant="danger" dot>
              {needsAttention} need{needsAttention === 1 ? 's' : ''} attention
            </Badge>
          )}
        </div>
      </div>

      <section className={ui.section} aria-labelledby="integrations-crm">
        <div className={ui.sectionHead}>
          <div className={ui.sectionTitle}>
            <span className={ui.sectionIcon}>
              <FiDatabase aria-hidden />
            </span>
            <div>
              <h2 id="integrations-crm">CRM</h2>
              <span>Where your customers, deals and quotations live. Each CRM’s data is kept separate.</span>
            </div>
          </div>
          {connectedCrms.length > 0 && <Badge variant="neutral">{connectedCrms.length} of {crmList.length} connected</Badge>}
        </div>
        {crmLoading ? (
          <div className={ui.grid}>
            <Skeleton height={190} />
            <Skeleton height={190} />
            <Skeleton height={190} />
          </div>
        ) : crmFailed ? (
          <EmptyState
            compact
            icon={FiAlertCircle}
            title="CRM integrations couldn’t be loaded"
            description={extractErrorMessage(crmError)}
            action={
              <Button size="sm" variant="secondary" onClick={() => void refetchCrm()}>
                Try again
              </Button>
            }
          />
        ) : (
          <div className={ui.grid}>{crmOrdered.map(crmCard)}</div>
        )}
      </section>
        </>
      )}

      <section className={ui.section} aria-labelledby="integrations-email">
        <div className={ui.sectionHead}>
          <div className={ui.sectionTitle}>
            <span className={ui.sectionIcon}>
              <FiMail aria-hidden />
            </span>
            <div>
              <h2 id="integrations-email">Email</h2>
              <span>The mailboxes HaiVE reads, sorts and drafts replies for. Each person connects their own.</span>
            </div>
          </div>
          {mailConnectedCount > 0 && <Badge variant="neutral">{mailConnectedCount} of 2 connected</Badge>}
        </div>
        <div className={ui.grid}>
          {mailCard('outlook', outlookStatus, outlookAccounts, handleConnectOutlook, () => setOutlookModalOpen(true))}
          {mailCard('gmail', gmailStatus, gmailAccounts, handleConnectGmail, () => setGmailModalOpen(true))}
        </div>
      </section>

      {/* Each person's own Drive / OneDrive (and, for admins, the company's) — for every account, AI-role ones included. */}
      <CloudStorageSection />

      {!emailOnly && (
        <>
      {/* For a system HaiVE has no dedicated integration for: any REST API,
          by API key, bearer token, basic auth or custom headers. Kept below
          the two things every customer needs. */}
      <section className={ui.section} aria-labelledby="integrations-other">
        <div className={ui.sectionHead}>
          <div className={ui.sectionTitle}>
            <span className={ui.sectionIcon}>
              <FiGlobe aria-hidden />
            </span>
            <div>
              <h2 id="integrations-other">Other systems</h2>
              <span>Any other tool that has an API — for the AI to look things up or take actions in.</span>
            </div>
          </div>
          <div className={ui.rowActions}>
            <Button size="sm" variant="ghost" leftIcon={<FiUploadCloud />} onClick={openImportModal}>
              Import connector
            </Button>
            <Button size="sm" variant="secondary" leftIcon={<FiPlus />} onClick={openCustomModal}>
              Add a connection
            </Button>
          </div>
        </div>
        {otherCustomIntegrations.length === 0 ? (
          <p className={ui.sectionEmpty}>No other systems connected. Most organizations only need a CRM and email.</p>
        ) : (
          <div className={ui.grid}>
            {otherCustomIntegrations.map((integration) => (
              <IntegrationCard
                key={integration.provider}
                logo={<Avatar name={integration.label || integration.provider} size="md" color="linear-gradient(135deg, #8b5cf6 0%, #4c1d95 100%)" />}
                name={integration.label || integration.provider}
                tagline="Custom connection"
                tone="connected"
                status={{ label: 'Connected', variant: 'success' }}
                facts={[
                  { icon: FiGlobe, text: integration.baseUrl ?? 'No address set' },
                  { icon: FiKey, text: integration.authType ? AUTH_TYPE_LABELS[integration.authType] : 'API Key' },
                ]}
                actions={
                  <>
                    <Button size="sm" variant="secondary" leftIcon={<FiSliders />} onClick={() => setBuilderProvider(integration.provider)}>
                      Manage
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      leftIcon={<FiTrash2 />}
                      onClick={() => handleDisconnectCustomIntegration(integration.provider, integration.label || integration.provider)}
                    >
                      Disconnect
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </section>
        </>
      )}

      <CrmSetupWizard integration={setupFor} onClose={() => setSetupFor(null)} />
      <CrmManageModal
        integration={managed}
        onClose={() => setManageId(null)}
        onReconnect={(integration) => {
          setManageId(null);
          setSetupFor(integration);
        }}
      />

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
                  {/* A shared mailbox is often connected by one person and answered by another. */}
                  {teamMembers.length > 0 && (
                    <label className={styles.handlerField}>
                      <span>Emails handled by</span>
                      <select
                        className={styles.select}
                        value={account.handledByUserId ?? ''}
                        onChange={(e) => void handleSetOutlookHandler(account.email, e.target.value || null)}
                      >
                        <option value="">Me (whoever connected it)</option>
                        {teamMembers.map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
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

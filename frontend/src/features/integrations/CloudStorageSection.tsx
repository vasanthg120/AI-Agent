import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiBriefcase, FiClock, FiFolder, FiFolderPlus, FiKey, FiLink, FiRefreshCw, FiSettings, FiTrash2, FiUser } from 'react-icons/fi';
import { Badge, Button, EmptyState, Modal, Skeleton } from '@/components/ui';
import { CloudFolderChooser, useCloudAccounts } from '@/components/cloud-files';
import { ROUTES } from '@/constants/routes';
import {
  CLOUD_PROVIDER_LABEL,
  CLOUD_PROVIDER_LOGO,
  cloudFilesService,
  type CloudConnection,
  type CloudFolderGrant,
  type CloudOwnership,
  type CloudProviderId,
  type CloudProviderOverview,
} from '@/services/cloudFilesService';
import { formatRelativeTime } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { IntegrationCard } from './IntegrationCard';
import styles from './IntegrationsPage.module.css';
import ui from './integrations.module.css';

const ROLE_LABEL: Record<string, string> = { manager: 'Managers', consultant: 'Consultants', user: 'Standard users', agent_user: 'AI-role accounts' };

// How a sign-in came back (backend: CloudConnectionsService.finish → /integrations?cloud=<provider>&result=<…>).
const RESULT: Record<string, { ok: boolean; say: (label: string) => string }> = {
  connected: { ok: true, say: (label) => `${label} connected` },
  cancelled: { ok: false, say: (label) => `${label} wasn’t connected — the sign-in was cancelled.` },
  forbidden: { ok: false, say: () => 'Only an owner or admin can connect the company account.' },
  admin_consent_required: {
    ok: false,
    say: () => 'Your organization’s Microsoft admin needs to approve HaiVE first (Outlook → Manage → Organization approval covers OneDrive too).',
  },
  error: { ok: false, say: (label) => `Could not connect ${label} — please try again.` },
};

async function connect(provider: CloudProviderId, ownership: CloudOwnership) {
  try {
    window.location.assign(await cloudFilesService.connectUrl(provider, ownership));
  } catch (error) {
    toast.error(extractErrorMessage(error));
  }
}

// Google Drive and OneDrive on the Integrations page: whose account is connected,
// what it allowed, when it last synced — and the company account with the folders
// it shares with each role.
export function CloudStorageSection() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const overview = useCloudAccounts();
  const [managing, setManaging] = useState<CloudProviderId | null>(null);

  useEffect(() => {
    const provider = searchParams.get('cloud') as CloudProviderId | null;
    const result = searchParams.get('result');
    if (!provider || !result || !CLOUD_PROVIDER_LABEL[provider]) return;
    const outcome = RESULT[result] ?? RESULT.error;
    if (outcome.ok) toast.success(outcome.say(CLOUD_PROVIDER_LABEL[provider]));
    else toast.error(outcome.say(CLOUD_PROVIDER_LABEL[provider]));
    void queryClient.invalidateQueries({ queryKey: ['cloud-files'] });
    if (outcome.ok) setManaging(provider);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('cloud');
        next.delete('result');
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams, queryClient]);

  const providers = overview.data?.providers ?? [];
  const connectedCount = providers.filter((p) => p.mine.length > 0 || p.company).length;
  const managed = providers.find((p) => p.id === managing) ?? null;

  const card = (p: CloudProviderOverview) => {
    const all = [...p.mine, ...(p.company ? [p.company] : [])];
    const reconnect = all.find((c) => c.status === 'needs_reauth');
    const connected = all.length > 0;
    const synced = all.map((c) => c.lastSyncAt).filter(Boolean).sort().at(-1);
    return (
      <IntegrationCard
        key={p.id}
        logo={<img src={CLOUD_PROVIDER_LOGO[p.id]} alt="" />}
        name={p.label}
        tagline={p.id === 'onedrive' ? 'Microsoft 365 and personal accounts' : 'Workspace and personal accounts'}
        tone={!p.configured ? 'idle' : reconnect ? 'attention' : connected ? 'connected' : 'idle'}
        status={
          !p.configured
            ? { label: 'Not set up', variant: 'neutral' }
            : reconnect
              ? { label: 'Reconnect', variant: 'danger' }
              : connected
                ? { label: 'Connected', variant: 'success' }
                : undefined
        }
        description={
          !p.configured
            ? `HaiVE’s ${p.label} app keys aren’t set up yet, so nobody can connect it. Your HaiVE administrator adds them.`
            : connected
              ? undefined
              : `Browse, upload and attach your ${p.label} files anywhere in HaiVE — on customers, in chat and in Business Knowledge.`
        }
        highlights={!p.configured || connected ? undefined : ['Customer folders and documents', 'Upload to the folder you choose', 'Pick files without saving them first']}
        facts={
          connected
            ? [
                ...(p.mine.length > 0 ? [{ icon: FiUser, text: `You: ${p.mine[0].accountEmail}${p.mine.length > 1 ? ` and ${p.mine.length - 1} more` : ''}` }] : []),
                ...(p.company
                  ? [
                      {
                        icon: FiBriefcase,
                        text: `Company: ${p.company.accountEmail}${p.company.sharedFolders === null || p.company.sharedFolders === undefined ? '' : ` · ${p.company.sharedFolders} folder${p.company.sharedFolders === 1 ? '' : 's'} shared with you`}`,
                      },
                    ]
                  : []),
                { icon: FiClock, text: synced ? `Synced ${formatRelativeTime(synced)}` : 'Files are read live from ' + p.label },
                ...(all[0].permissions[0] ? [{ icon: FiKey, text: all[0].permissions[0] }] : []),
              ]
            : undefined
        }
        problem={reconnect ? `The connection to ${reconnect.accountEmail} has expired or was withdrawn. Reconnect it to keep using its files.` : undefined}
        actions={
          !p.configured ? (
            <Button size="sm" leftIcon={<FiLink />} disabled>
              Connect
            </Button>
          ) : connected ? (
            <>
              <Button size="sm" leftIcon={<FiFolder />} onClick={() => navigate(`${ROUTES.files}?connection=${encodeURIComponent((p.mine[0] ?? p.company)!.id)}`)}>
                Open files
              </Button>
              <Button size="sm" variant="secondary" leftIcon={<FiSettings />} onClick={() => setManaging(p.id)}>
                Manage
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" leftIcon={<FiLink />} onClick={() => void connect(p.id, 'personal')}>
                Connect
              </Button>
              {p.canConnectCompany && (
                <Button size="sm" variant="ghost" leftIcon={<FiBriefcase />} onClick={() => void connect(p.id, 'company')}>
                  Company account
                </Button>
              )}
            </>
          )
        }
      />
    );
  };

  return (
    <section className={ui.section} aria-labelledby="integrations-files">
      <div className={ui.sectionHead}>
        <div className={ui.sectionTitle}>
          <span className={ui.sectionIcon}>
            <FiFolder aria-hidden />
          </span>
          <div>
            <h2 id="integrations-files">Cloud storage</h2>
            <span>Google Drive and OneDrive files, opened and attached from anywhere in HaiVE. Each person connects their own; an admin can add the company’s.</span>
          </div>
        </div>
        {connectedCount > 0 && <Badge variant="neutral">{connectedCount} of 2 connected</Badge>}
      </div>
      {overview.isLoading ? (
        <div className={ui.grid}>
          <Skeleton height={190} />
          <Skeleton height={190} />
        </div>
      ) : overview.error ? (
        <EmptyState
          compact
          title="Cloud storage couldn’t be loaded"
          description={extractErrorMessage(overview.error)}
          action={
            <Button size="sm" variant="secondary" onClick={() => void overview.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <div className={ui.grid}>{providers.map(card)}</div>
      )}
      {managed && <CloudAccountsModal provider={managed} roles={overview.data?.grantableRoles ?? []} onClose={() => setManaging(null)} />}
    </section>
  );
}

function statusBadge(connection: CloudConnection) {
  return connection.status === 'needs_reauth' ? (
    <Badge variant="danger" dot>
      Needs reconnecting
    </Badge>
  ) : (
    <Badge variant="success" dot>
      Connected
    </Badge>
  );
}

function CloudAccountsModal({ provider, roles, onClose }: { provider: CloudProviderOverview; roles: string[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const syncNow = async (connection: CloudConnection) => {
    setSyncing(connection.id);
    try {
      const result = await cloudFilesService.sync(connection.id);
      toast.success(
        result.linksChecked + result.foldersIndexed === 0
          ? 'Synced — no customer documents are kept from this account yet'
          : `Synced: ${result.linksChecked} attached file${result.linksChecked === 1 ? '' : 's'} checked, ${result.foldersIndexed} customer folder${result.foldersIndexed === 1 ? '' : 's'} listed${result.partial ? ' (the rest follows on the next sync)' : ''}`,
      );
      await queryClient.invalidateQueries({ queryKey: ['cloud-files'] });
      await queryClient.invalidateQueries({ queryKey: ['customer-cloud'] });
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSyncing(null);
    }
  };

  const disconnect = async (connection: CloudConnection) => {
    const company = connection.ownership === 'company';
    const sure = window.confirm(
      company
        ? `Disconnect the company ${provider.label} (${connection.accountEmail})? Everyone loses access to its shared folders in HaiVE. Nothing is deleted from ${provider.label}.`
        : `Disconnect ${connection.accountEmail}? Nothing is deleted from ${provider.label}.`,
    );
    if (!sure) return;
    setRemoving(connection.id);
    try {
      await cloudFilesService.disconnect(connection.id);
      toast.success(`${connection.accountEmail} disconnected`);
      await queryClient.invalidateQueries({ queryKey: ['cloud-files'] });
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setRemoving(null);
    }
  };

  const row = (connection: CloudConnection) => (
    <div key={connection.id} className={styles.accountRow}>
      <div>
        <div className={styles.accountEmail}>{connection.accountEmail}</div>
        <span className={styles.accountOwner}>
          {[
            connection.accountName,
            connection.connectedBy ? `Connected by ${connection.connectedBy}` : undefined,
            connection.connectedAt ? `since ${new Date(connection.connectedAt).toLocaleDateString()}` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {statusBadge(connection)}
        {connection.permissions.length > 0 && <span className={styles.accountOwner}>Allowed: {connection.permissions.join(' · ')}</span>}
        <span className={styles.accountOwner}>
          {connection.lastSyncAt
            ? `Last synced ${formatRelativeTime(connection.lastSyncAt)}${connection.lastSyncStatus === 'error' && connection.lastSyncError ? ` — ${connection.lastSyncError}` : ''}`
            : 'Not synced yet. Files are always read live; the sync keeps customer documents up to date.'}
        </span>
      </div>
      {connection.status !== 'needs_reauth' && !connection.canManage && (
        <div className={styles.accountActions}>
          <Button size="sm" variant="ghost" leftIcon={<FiRefreshCw />} loading={syncing === connection.id} onClick={() => void syncNow(connection)}>
            Sync now
          </Button>
        </div>
      )}
      {connection.canManage && (
        <div className={styles.accountActions}>
          {connection.status !== 'needs_reauth' && (
            <Button size="sm" variant="ghost" leftIcon={<FiRefreshCw />} loading={syncing === connection.id} onClick={() => void syncNow(connection)}>
              Sync now
            </Button>
          )}
          {connection.status === 'needs_reauth' && (
            <Button size="sm" variant="secondary" leftIcon={<FiRefreshCw />} onClick={() => void connect(provider.id, connection.ownership)}>
              Reconnect
            </Button>
          )}
          <Button size="sm" variant="ghost" leftIcon={<FiTrash2 />} loading={removing === connection.id} onClick={() => void disconnect(connection)}>
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <Modal open onClose={onClose} title={`${provider.label} accounts`} description="Who is connected, what HaiVE may do with each account, and the company folders shared with your team." maxWidth={720}>
      <div className={styles.sectionDivider}>Your accounts</div>
      {provider.mine.length > 0 ? (
        <div className={styles.accountList}>{provider.mine.map(row)}</div>
      ) : (
        <p className={styles.accountOwner}>You haven’t connected your own {provider.label}. Only you can open the files of an account you connect.</p>
      )}
      <div className={styles.accountActions} style={{ marginTop: 'var(--space-3)' }}>
        <Button size="sm" variant="secondary" leftIcon={<FiLink />} onClick={() => void connect(provider.id, 'personal')}>
          {provider.mine.length > 0 ? 'Connect another account' : `Connect my ${provider.label}`}
        </Button>
      </div>

      <div className={styles.sectionDivider}>Company account</div>
      {provider.company ? (
        <>
          <div className={styles.accountList}>{row(provider.company)}</div>
          {provider.company.canManage ? (
            <>
              <div className={styles.accountActions} style={{ marginTop: 'var(--space-3)' }}>
                <Button size="sm" variant="ghost" leftIcon={<FiBriefcase />} onClick={() => void connect(provider.id, 'company')}>
                  Replace with another account
                </Button>
              </div>
              <FolderGrantsEditor connection={provider.company} roles={roles} />
            </>
          ) : (
            <p className={styles.accountOwner}>
              {provider.company.sharedFolders ?? 0} folder{provider.company.sharedFolders === 1 ? ' is' : 's are'} shared with your role. An owner or admin decides which.
            </p>
          )}
        </>
      ) : provider.canConnectCompany ? (
        <>
          <p className={styles.accountOwner}>
            Connect the company’s {provider.label} (for example a shared sales@ account). Owners and admins see all of it; you choose which folders each other role can open.
          </p>
          <div className={styles.accountActions} style={{ marginTop: 'var(--space-3)' }}>
            <Button size="sm" leftIcon={<FiBriefcase />} onClick={() => void connect(provider.id, 'company')}>
              Connect company account
            </Button>
          </div>
        </>
      ) : (
        <p className={styles.accountOwner}>No company {provider.label} is shared with your role.</p>
      )}
    </Modal>
  );
}

/** Which folders of the company account each role may open, and whether it may change them. */
function FolderGrantsEditor({ connection, roles }: { connection: CloudConnection; roles: string[] }) {
  const queryClient = useQueryClient();
  const grants = useQuery({ queryKey: ['cloud-files', connection.id, 'grants'], queryFn: () => cloudFilesService.grants(connection.id) });
  const [rows, setRows] = useState<CloudFolderGrant[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const shown = rows ?? grants.data ?? [];
  const dirty = rows !== null;

  const change = (folderId: string, patch: Partial<CloudFolderGrant>) => setRows(shown.map((r) => (r.folderId === folderId ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    try {
      const saved = await cloudFilesService.setGrants(
        connection.id,
        shown.map(({ folderId, roles: r, access }) => ({ folderId, roles: r, access })),
      );
      queryClient.setQueryData(['cloud-files', connection.id, 'grants'], saved);
      setRows(null);
      toast.success('Shared folders saved');
      void queryClient.invalidateQueries({ queryKey: ['cloud-files', 'overview'] });
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className={styles.sectionDivider}>Folders shared with your team</div>
      {grants.isLoading ? (
        <Skeleton height={80} />
      ) : grants.error ? (
        <p className={styles.accountOwner}>{extractErrorMessage(grants.error)}</p>
      ) : shown.length === 0 ? (
        <p className={styles.accountOwner}>
          Nothing is shared yet: only owners and admins can open the company {CLOUD_PROVIDER_LABEL[connection.provider]}. Share a folder to let a role open it (and everything inside it).
        </p>
      ) : (
        <div className={styles.accountList}>
          {shown.map((grant) => (
            <div key={grant.folderId} className={styles.accountRow}>
              <div style={{ minWidth: 0 }}>
                <div className={styles.accountEmail} title={grant.path}>
                  {grant.path || grant.name}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', marginTop: 6, fontSize: 'var(--text-sm)' }}>
                  {roles.map((role) => (
                    <label key={role} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={grant.roles.includes(role)}
                        onChange={(e) => change(grant.folderId, { roles: e.target.checked ? [...grant.roles, role] : grant.roles.filter((r) => r !== role) })}
                      />
                      {ROLE_LABEL[role] ?? role}
                    </label>
                  ))}
                </div>
              </div>
              <div className={styles.accountActions}>
                <select
                  className={styles.select}
                  value={grant.access}
                  aria-label={`What ${grant.name} allows`}
                  onChange={(e) => change(grant.folderId, { access: e.target.value as 'view' | 'edit' })}
                >
                  <option value="view">View and download</option>
                  <option value="edit">Also upload and change</option>
                </select>
                <Button size="sm" variant="ghost" leftIcon={<FiTrash2 />} onClick={() => setRows(shown.filter((r) => r.folderId !== grant.folderId))}>
                  Stop sharing
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={styles.accountActions} style={{ marginTop: 'var(--space-3)' }}>
        <Button size="sm" variant="secondary" leftIcon={<FiFolderPlus />} onClick={() => setChoosing(true)}>
          Share a folder
        </Button>
        {dirty && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setRows(null)}>
              Undo changes
            </Button>
            <Button size="sm" loading={saving} onClick={() => void save()}>
              Save shared folders
            </Button>
          </>
        )}
      </div>
      <CloudFolderChooser
        connection={connection}
        open={choosing}
        title="Share a company folder"
        description="The roles you choose will see this folder and everything inside it."
        submit="Share this folder"
        requireEdit={false}
        onClose={() => setChoosing(false)}
        onChoose={(folder) => {
          if (folder.root) throw new Error('Share a folder rather than the whole drive.');
          if (shown.some((r) => r.folderId === folder.id)) return;
          setRows([...shown, { folderId: folder.id, name: folder.name, path: folder.name, roles: ['manager'], access: 'view' }]);
        }}
      />
    </>
  );
}

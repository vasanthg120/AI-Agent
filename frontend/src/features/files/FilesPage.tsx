import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { FiAlertCircle, FiDownload, FiExternalLink, FiEye, FiFolder, FiLink, FiSearch } from 'react-icons/fi';
import { Badge, Button, EmptyState, IconButton, PageHeader, Skeleton } from '@/components/ui';
import {
  CloudFileBrowser,
  CloudPreviewModal,
  CloudSourceBadge,
  connectionSource,
  downloadName,
  formatBytes,
  formatModified,
  iconOf,
  useCloudAccounts,
} from '@/components/cloud-files';
import { NAV_GROUPS } from '@/constants/navigation';
import { ROUTES } from '@/constants/routes';
import {
  CLOUD_PROVIDER_LABEL,
  CLOUD_PROVIDER_LOGO,
  cloudFilesService,
  saveBlob,
  type CloudConnection,
  type CloudItem,
  type CloudProviderId,
} from '@/services/cloudFilesService';
import { customerCloudService } from '@/services/customerCloudService';
import { customersService } from '@/services/customersService';
import { useAuthStore } from '@/stores/authStore';
import { canSeeNavItem } from '@/utils/access';
import { formatRelativeTime } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import styles from './FilesPage.module.css';

type View = 'all' | CloudProviderId | 'haive';
const VIEWS: { id: View; label: string }[] = [
  { id: 'all', label: 'All files' },
  { id: 'google_drive', label: 'Google Drive' },
  { id: 'onedrive', label: 'OneDrive' },
  { id: 'haive', label: 'HaiVE uploads' },
];
// HaiVE's own uploads are customer files: shown to whoever may open Customers.
const CUSTOMERS_ITEM = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === 'customers');

// One place for every Google Drive and OneDrive account this person may open:
// their own, and the company's folders shared with their role. Files stay in the
// cloud — nothing here copies them into HaiVE.
export function FilesPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const overview = useCloudAccounts();
  const [start, setStart] = useState<{ connectionId: string; trail: CloudItem[]; token: number } | null>(null);
  const user = useAuthStore((state) => state.user);
  const seesHaive = !!CUSTOMERS_ITEM && canSeeNavItem(user, CUSTOMERS_ITEM);

  const providers = overview.data?.providers ?? [];
  const accounts: CloudConnection[] = useMemo(() => providers.flatMap((p) => [...p.mine, ...(p.company ? [p.company] : [])]), [providers]);
  const wanted = params.get('connection');
  const wantedAccount = accounts.find((a) => a.id === wanted);
  const view: View = (params.get('view') as View | null) ?? wantedAccount?.provider ?? 'all';

  const go = (next: View, connectionId?: string) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('view', next);
        if (connectionId) p.set('connection', connectionId);
        else p.delete('connection');
        return p;
      },
      { replace: false },
    );

  return (
    <div className={styles.page}>
      <PageHeader
        title="Files"
        subtitle="Your Google Drive and OneDrive files, and the company folders shared with you. They stay where they are; HaiVE opens them for you."
        icon={FiFolder}
        actions={
          <Button size="sm" variant="secondary" leftIcon={<FiLink />} onClick={() => navigate(ROUTES.integrations)}>
            Manage accounts
          </Button>
        }
      />

      <div className={styles.views} role="tablist" aria-label="Where to look">
        {VIEWS.filter((v) => v.id !== 'haive' || seesHaive).map((v) => {
          const count = v.id === 'all' || v.id === 'haive' ? 0 : accounts.filter((a) => a.provider === v.id).length;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={clsx(styles.viewButton, view === v.id && styles.viewActive)}
              onClick={() => go(v.id)}
            >
              {v.id !== 'all' && v.id !== 'haive' && <img src={CLOUD_PROVIDER_LOGO[v.id]} alt="" />}
              {v.label}
              {count > 0 && v.id !== 'all' && <span className={styles.count}>{count}</span>}
            </button>
          );
        })}
      </div>

      {view === 'haive' && seesHaive ? (
        <HaiveUploads />
      ) : overview.isLoading ? (
        <Skeleton height={320} />
      ) : overview.error ? (
        <EmptyState icon={FiAlertCircle} title="Your accounts couldn’t be loaded" description={extractErrorMessage(overview.error)} />
      ) : view === 'all' ? (
        <AllFiles
          accounts={accounts}
          onOpen={(account, trail) => {
            setStart(trail ? { connectionId: account.id, trail, token: Date.now() } : null);
            go(account.provider, account.id);
          }}
        />
      ) : (
        <ProviderFiles
          key={view}
          provider={view as CloudProviderId}
          accounts={accounts.filter((a) => a.provider === view)}
          configured={!!providers.find((p) => p.id === view)?.configured}
          selectedId={wantedAccount?.provider === view ? wantedAccount.id : undefined}
          onSelect={(id) => go(view as CloudProviderId, id)}
          start={start}
          maxUploadBytes={overview.data?.maxUploadBytes}
        />
      )}
    </div>
  );
}

function ProviderFiles({
  provider,
  accounts,
  configured,
  selectedId,
  onSelect,
  start,
  maxUploadBytes,
}: {
  provider: CloudProviderId;
  accounts: CloudConnection[];
  configured: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
  start: { connectionId: string; trail: CloudItem[]; token: number } | null;
  maxUploadBytes?: number;
}) {
  const label = CLOUD_PROVIDER_LABEL[provider];
  const account = accounts.find((a) => a.id === selectedId) ?? accounts[0];
  if (!configured)
    return <EmptyState title={`${label} isn’t set up yet`} description={`Your HaiVE administrator needs to add ${label}’s app keys before anyone can connect it.`} />;
  if (!account)
    return (
      <EmptyState
        title={`Connect ${label}`}
        description={`Connect your ${label} to browse, upload and attach its files in HaiVE. Only you will be able to open your account’s files.`}
        action={
          <Button
            leftIcon={<FiLink />}
            onClick={() =>
              void cloudFilesService
                .connectUrl(provider, 'personal')
                .then((url) => window.location.assign(url))
                .catch((error) => toast.error(extractErrorMessage(error)))
            }
          >
            Connect {label}
          </Button>
        }
      />
    );
  const startHere = start && start.connectionId === account.id ? start : null;
  return (
    <div className={styles.provider}>
      {accounts.length > 1 && (
        <div className={styles.accounts} role="tablist" aria-label={`${label} accounts`}>
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={a.id === account.id}
              className={clsx(styles.accountChip, a.id === account.id && styles.accountChipActive)}
              onClick={() => onSelect(a.id)}
            >
              <span>{a.ownership === 'company' ? 'Company' : 'Mine'}</span>
              {a.accountEmail}
              {a.status === 'needs_reauth' && <Badge variant="danger">Reconnect</Badge>}
            </button>
          ))}
        </div>
      )}
      <CloudFileBrowser
        key={`${account.id}-${startHere?.token ?? 0}`}
        connection={account}
        mode="manage"
        initialTrail={startHere?.trail}
        maxUploadBytes={maxUploadBytes}
      />
    </div>
  );
}

/** Every account at a glance, and one search across all of them. */
function AllFiles({ accounts, onOpen }: { accounts: CloudConnection[]; onOpen: (account: CloudConnection, trail?: CloudItem[]) => void }) {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [previewing, setPreviewing] = useState<{ account: CloudConnection; item: CloudItem } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 400);
    return () => clearTimeout(timer);
  }, [input]);

  const searchable = accounts.filter((a) => a.status !== 'needs_reauth');
  const searches = useQueries({
    queries: searchable.map((account) => ({
      queryKey: ['cloud-files', account.id, 'search', query, '', '', undefined],
      queryFn: () => cloudFilesService.search(account.id, { q: query }),
      enabled: query.length >= 2,
      staleTime: 30_000,
    })),
  });

  if (accounts.length === 0)
    return (
      <EmptyState
        icon={FiFolder}
        title="No Google Drive or OneDrive connected"
        description="Connect your own account on the Integrations page — or ask an admin to share company folders with your role."
        action={<Button onClick={() => navigate(ROUTES.integrations)}>Go to Integrations</Button>}
      />
    );

  const results = query.length >= 2 ? searches.flatMap((s, i) => (s.data?.items ?? []).map((item) => ({ account: searchable[i], item }))) : [];
  const searching = query.length >= 2 && searches.some((s) => s.isLoading);
  const failed = query.length >= 2 ? searches.map((s, i) => (s.error ? searchable[i] : null)).filter(Boolean) : [];

  const showInFolder = async (account: CloudConnection, item: CloudItem) => {
    try {
      const { path = [] } = await cloudFilesService.item(account.id, item.id, true);
      onOpen(account, item.kind === 'folder' ? [...path, item] : path);
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const download = async (account: CloudConnection, item: CloudItem) => {
    try {
      saveBlob(await cloudFilesService.content(account.id, item.id), downloadName(item));
    } catch (error) {
      toast.error(`${item.name}: ${extractErrorMessage(error)}`);
    }
  };

  return (
    <div className={styles.all}>
      <label className={styles.search}>
        <FiSearch aria-hidden />
        <input type="search" value={input} placeholder="Search every connected account" aria-label="Search every connected account" onChange={(e) => setInput(e.target.value)} />
      </label>

      {query.length >= 2 ? (
        <section className={styles.results} aria-label="Search results">
          {failed.map((account) => (
            <p key={account!.id} className={styles.warning}>
              {CLOUD_PROVIDER_LABEL[account!.provider]} ({account!.accountEmail}) couldn’t be searched.
            </p>
          ))}
          {searching && results.length === 0 ? (
            <Skeleton height={160} />
          ) : results.length === 0 ? (
            <EmptyState compact title="Nothing found" description={`No file or folder matches “${query}” in your accounts.`} />
          ) : (
            results.map(({ account, item }) => {
              const Icon = iconOf(item);
              return (
                <div key={`${account.id}-${item.id}`} className={styles.result}>
                  <span className={styles.resultIcon}>
                    <Icon aria-hidden />
                  </span>
                  <button type="button" className={styles.resultName} onClick={() => (item.kind === 'folder' ? void showInFolder(account, item) : setPreviewing({ account, item }))}>
                    <strong>{item.name}</strong>
                    <CloudSourceBadge provider={account.provider} location={account.ownership === 'company' ? `Company · ${account.accountEmail}` : account.accountEmail} />
                  </button>
                  <span className={styles.resultMeta}>
                    {item.kind === 'file' ? `${formatBytes(item.size)} · ` : ''}
                    {formatModified(item.modifiedAt)}
                  </span>
                  <span className={styles.resultActions}>
                    {item.kind === 'file' && <IconButton size="sm" icon={<FiEye />} label={`Preview ${item.name}`} onClick={() => setPreviewing({ account, item })} />}
                    {item.kind === 'file' && <IconButton size="sm" icon={<FiDownload />} label={`Download ${item.name}`} onClick={() => void download(account, item)} />}
                    {item.webUrl && (
                      <IconButton size="sm" icon={<FiExternalLink />} label={`Open ${item.name} in ${CLOUD_PROVIDER_LABEL[account.provider]}`} onClick={() => window.open(item.webUrl, '_blank', 'noopener,noreferrer')} />
                    )}
                    <IconButton size="sm" icon={<FiFolder />} label={`Show ${item.name} in its folder`} onClick={() => void showInFolder(account, item)} />
                  </span>
                </div>
              );
            })
          )}
        </section>
      ) : (
        <div className={styles.cards}>
          {accounts.map((account) => (
            <button key={account.id} type="button" className={styles.card} onClick={() => onOpen(account)}>
              <img src={CLOUD_PROVIDER_LOGO[account.provider]} alt="" />
              <span className={styles.cardText}>
                <strong>{CLOUD_PROVIDER_LABEL[account.provider]}</strong>
                <span>{account.accountEmail}</span>
              </span>
              <span className={styles.cardBadges}>
                <Badge variant={account.ownership === 'company' ? 'info' : 'neutral'}>{account.ownership === 'company' ? 'Company' : 'Mine'}</Badge>
                {account.status === 'needs_reauth' && <Badge variant="danger">Reconnect</Badge>}
                {account.ownership === 'company' && typeof account.sharedFolders === 'number' && (
                  <Badge variant="neutral">
                    {account.sharedFolders} folder{account.sharedFolders === 1 ? '' : 's'}
                  </Badge>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      {previewing && (
        <CloudPreviewModal provider={previewing.account.provider} source={connectionSource(previewing.account.id)} item={previewing.item} onClose={() => setPreviewing(null)} />
      )}
    </div>
  );
}

/** Files kept in HaiVE itself — what the team attached to customers, and copies made from the cloud. */
function HaiveUploads() {
  const files = useQuery({ queryKey: ['customer-files'], queryFn: () => customerCloudService.haiveFiles() });
  const [search, setSearch] = useState('');
  const words = search.trim().toLowerCase();
  const shown = (files.data ?? []).filter((f) => !words || `${f.name} ${f.customerName}`.toLowerCase().includes(words));
  const download = async (customerId: string, fileId: string, name: string) => {
    try {
      saveBlob(await customersService.downloadFile(customerId, fileId), name);
    } catch (error) {
      toast.error(`${name}: ${extractErrorMessage(error)}`);
    }
  };
  if (files.isLoading) return <Skeleton height={240} />;
  if (files.error) return <EmptyState icon={FiAlertCircle} title="HaiVE’s files couldn’t be loaded" description={extractErrorMessage(files.error)} />;
  return (
    <div className={styles.all}>
      <label className={styles.search}>
        <FiSearch aria-hidden />
        <input type="search" value={search} placeholder="Search by file or customer" aria-label="Search HaiVE uploads" onChange={(e) => setSearch(e.target.value)} />
      </label>
      {shown.length === 0 ? (
        <EmptyState compact title={words ? 'Nothing found' : 'No files in HaiVE yet'} description={words ? undefined : 'Files attached to customers on the Customers page are listed here.'} />
      ) : (
        <section className={styles.results} aria-label="HaiVE uploads">
          {shown.map((file) => {
            const Icon = iconOf({ kind: 'file', name: file.name, mimeType: file.type });
            return (
              <div key={file.id} className={styles.result}>
                <span className={styles.resultIcon}>
                  <Icon aria-hidden />
                </span>
                <span className={styles.resultName}>
                  <strong>{file.name}</strong>
                  <CloudSourceBadge copied provider={file.copiedFrom} />
                </span>
                <span className={styles.resultMeta}>
                  {file.customerName} · {formatBytes(file.size)} · {file.uploadedBy} {formatRelativeTime(file.at)}
                </span>
                <span className={styles.resultActions}>
                  <IconButton size="sm" icon={<FiDownload />} label={`Download ${file.name}`} onClick={() => void download(file.customerId, file.id, file.name)} />
                </span>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

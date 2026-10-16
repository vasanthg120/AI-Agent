import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  FiCloud,
  FiCopy,
  FiDownload,
  FiExternalLink,
  FiEye,
  FiFolder,
  FiFolderPlus,
  FiLink,
  FiPaperclip,
  FiPlus,
  FiSearch,
  FiTrash2,
  FiUploadCloud,
} from 'react-icons/fi';
import { Badge, Button, Dropdown, IconButton, Input, Modal, Skeleton, type DropdownItem } from '@/components/ui';
import {
  CloudFileBrowser,
  CloudFilePickerModal,
  CloudFolderChooser,
  CloudPreviewModal,
  CloudSourceBadge,
  customerFolderSource,
  customerLinkSource,
  downloadName,
  formatBytes,
  formatModified,
  iconOf,
  useCloudAccounts,
} from '@/components/cloud-files';
import { ROUTES } from '@/constants/routes';
import {
  CLOUD_PROVIDER_LABEL,
  CLOUD_PROVIDER_LOGO,
  connectionLabel,
  saveBlob,
  type CloudConnection,
  type CloudItem,
  type CloudProviderId,
} from '@/services/cloudFilesService';
import { CATEGORY_LABEL, customerCloudService, type CustomerCloudFolder, type CustomerCloudLink, type DocumentCategory } from '@/services/customerCloudService';
import type { CustomerFile, CustomerWorkspace, WorkspaceApi } from '@/services/customersService';
import { formatRelativeTime } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { JobTag } from '../jobs/JobTag';
import detailStyles from '../customer-detail.module.css';
import panelStyles from './panel.module.css';
import { fileSize } from './WorkspaceTabs';
import styles from './customerDocuments.module.css';

interface CustomerDocumentsProps {
  customerId: string;
  /** What a new customer folder is called unless changed: the business, else the person. */
  folderName: string;
  /** The customer's quotations, for filing a document against one. */
  quotations: { id: string; label: string }[];
  /** Where HaiVE's own files of the customer are kept (the panel's workspace). */
  api: WorkspaceApi;
  workspace: UseQueryResult<CustomerWorkspace>;
  /** Something changed that the board and the timeline show. */
  onChanged: () => void;
  onOpenJob?: (jobId: string, number?: string) => void;
}

// One row of the list: a file kept in HaiVE, or a cloud file attached by link.
type Row = { type: 'haive'; at: string; file: CustomerFile } | { type: 'cloud'; at: string; link: CustomerCloudLink };

// What the filter can narrow to: where a document is, or (for attached cloud files) what kind it is.
type Show = '' | 'folders' | 'haive' | CloudProviderId | `kind:${DocumentCategory}`;

const STATUS: Record<CustomerCloudLink['status'], { label: string; variant: 'warning' | 'danger' } | null> = {
  available: null,
  moved: { label: 'Moved', variant: 'warning' },
  deleted: { label: 'Deleted in the cloud', variant: 'danger' },
  no_access: { label: 'No access', variant: 'danger' },
};

// Every document of a customer in one list: the files kept in HaiVE, the cloud
// files attached by link, and the customer's Google Drive / OneDrive folders —
// each one saying where it lives. One search, one filter, one "Add" for every way
// in; files dropped anywhere here are kept in HaiVE.
export function CustomerDocuments({ customerId, folderName, quotations, api, workspace, onChanged, onOpenJob }: CustomerDocumentsProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const key = ['customer-cloud', customerId];
  const cloud = useQuery({ queryKey: key, queryFn: () => customerCloudService.overview(customerId) });
  const accounts = useCloudAccounts();
  const input = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<Show>('');
  const [picking, setPicking] = useState<'copy' | 'attach' | 'folder' | null>(null);
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState<{ folderId: string; start?: string } | null>(null);
  const [previewing, setPreviewing] = useState<CustomerCloudLink | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [over, setOver] = useState(false);

  const limits = workspace.data?.limits;
  const connected: CloudConnection[] = useMemo(
    () => (accounts.data?.providers ?? []).flatMap((p) => [...p.mine, ...(p.company ? [p.company] : [])]).filter((c) => c.status !== 'needs_reauth'),
    [accounts.data],
  );
  const refreshCloud = () => void queryClient.invalidateQueries({ queryKey: key });

  // ---- HaiVE's own files -----------------------------------------------------------------
  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    const fits = files.filter((file) => !limits || file.size <= limits.maxFileBytes);
    for (const file of files.filter((f) => !fits.includes(f)))
      toast.error(`${file.name} is larger than ${fileSize(limits!.maxFileBytes)} and wasn’t added.`, { duration: 8_000 });
    setUploading(fits.length);
    let added = 0;
    for (const file of fits) {
      try {
        await api.uploadFile(file);
        added += 1;
      } catch (error) {
        toast.error(`${file.name}: ${extractErrorMessage(error)}`, { duration: 8_000 });
      }
      setUploading((left) => left - 1);
    }
    setUploading(0);
    if (added > 0) {
      toast.success(added === 1 ? 'File added' : `${added} files added`);
      onChanged();
    }
  };

  const downloadFile = async (file: CustomerFile) => {
    try {
      saveBlob(await api.downloadFile(file.id), file.name);
    } catch (error) {
      toast.error(extractErrorMessage(error), { duration: 8_000 });
    }
  };

  const removeFile = async (file: CustomerFile) => {
    if (!window.confirm(`Delete ${file.name}? This can’t be undone.`)) return;
    try {
      await api.removeFile(file.id);
      onChanged();
    } catch (error) {
      toast.error(extractErrorMessage(error), { duration: 8_000 });
    }
  };

  // ---- cloud links and folders --------------------------------------------------------------
  const run = async (id: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    try {
      await work();
      if (done) toast.success(done);
      refreshCloud();
    } catch (error) {
      toast.error(extractErrorMessage(error), { duration: 8_000 });
    } finally {
      setBusy(null);
    }
  };

  const downloadLink = (link: CustomerCloudLink) => run(link.id, async () => saveBlob(await customerCloudService.linkContent(customerId, link.id), downloadName(link)));

  const copyLink = (link: CustomerCloudLink) =>
    run(
      link.id,
      async () => {
        await customerCloudService.copyIntoHaive(customerId, link.id);
        onChanged();
      },
      `A copy of ${link.name} is now kept in HaiVE`,
    );

  const removeLink = (link: CustomerCloudLink) => {
    if (!window.confirm(`Take ${link.name} off this customer? The file stays in ${CLOUD_PROVIDER_LABEL[link.provider]}.`)) return;
    void run(link.id, () => customerCloudService.removeLink(customerId, link.id), 'Removed from the customer');
  };

  const unlink = (folder: CustomerCloudFolder) => {
    if (!window.confirm(`Unlink the folder “${folder.name}” from this customer? Nothing is deleted in ${CLOUD_PROVIDER_LABEL[folder.provider]}.`)) return;
    void run(folder.id, () => customerCloudService.unlinkFolder(customerId, folder.id), 'Folder unlinked');
  };

  const reachNote = (item: { reach: CustomerCloudFolder['reach']; provider: CloudProviderId; ownership: 'personal' | 'company'; ownerName?: string }) => {
    const label = CLOUD_PROVIDER_LABEL[item.provider];
    const owner = item.ownerName ?? 'a colleague';
    if (item.reach === 'reconnect') return `Reconnect ${label} on the Integrations page to open it.`;
    if (item.reach === 'own_account') return `In ${owner}’s ${label} — opens with your own ${label} if ${owner} shared it with you.`;
    if (item.reach === 'disconnected')
      return item.ownership === 'company' ? `The company ${label} was disconnected.` : `In ${owner}’s ${label}. Connect your own ${label} to open it, if ${owner} shared it with you.`;
    return undefined;
  };

  // ---- one list ------------------------------------------------------------------------------
  const words = search.trim().toLowerCase();
  const kind = show.startsWith('kind:') ? (show.slice(5) as DocumentCategory) : undefined;
  const folders = (cloud.data?.folders ?? []).filter(
    (f) => (!show || show === 'folders' || show === f.provider) && (!words || f.name.toLowerCase().includes(words)),
  );
  const rows: Row[] = useMemo(() => {
    const haive: Row[] = (workspace.data?.files ?? []).map((file) => ({ type: 'haive', at: String(file.at), file }));
    const linked: Row[] = (cloud.data?.links ?? []).map((link) => ({ type: 'cloud', at: link.at, link }));
    return [...haive, ...linked].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [workspace.data, cloud.data]);
  const shown = rows.filter((row) => {
    if (show === 'folders') return false;
    if (row.type === 'haive') {
      if (show && show !== 'haive') return false;
      return !words || row.file.name.toLowerCase().includes(words);
    }
    if (show === 'haive') return false;
    if ((show === 'google_drive' || show === 'onedrive') && row.link.provider !== show) return false;
    if (kind && row.link.category !== kind) return false;
    return !words || `${row.link.name} ${row.link.location ?? ''} ${row.link.linkedTo?.label ?? ''} ${CATEGORY_LABEL[row.link.category]}`.toLowerCase().includes(words);
  });
  const totalFolders = cloud.data?.folders.length ?? 0;
  const total = totalFolders + rows.length;
  const loading = workspace.isLoading || (cloud.isLoading && !workspace.data);

  const addItems: DropdownItem[] = [
    { id: 'upload', label: 'Upload from this computer', icon: <FiUploadCloud />, onSelect: () => input.current?.click() },
    ...(connected.length > 0
      ? [
          { id: 'copy', label: 'Copy from Google Drive or OneDrive', icon: <FiCloud />, onSelect: () => setPicking('copy') },
          { id: 'attach', label: 'Attach from the cloud (keep it there)', icon: <FiPaperclip />, separatorBefore: true, onSelect: () => setPicking('attach') },
          { id: 'link', label: 'Link the customer’s folder', icon: <FiLink />, onSelect: () => setPicking('folder') },
          { id: 'create', label: 'Create a customer folder', icon: <FiFolderPlus />, onSelect: () => setCreating(true) },
        ]
      : [{ id: 'connect', label: 'Connect Google Drive or OneDrive', icon: <FiLink />, separatorBefore: true, onSelect: () => navigate(ROUTES.integrations) }]),
  ];

  const folderRow = (folder: CustomerCloudFolder) => {
    const open = browsing?.folderId === folder.id;
    const note = reachNote(folder);
    const home: CloudItem = { id: folder.folderId, name: folder.name, kind: 'folder' };
    return (
      <li key={`folder-${folder.id}`} className={styles.folder}>
        <div className={panelStyles.listRow}>
          <span className={styles.folderIcon}>
            <FiFolder aria-hidden />
            <img src={CLOUD_PROVIDER_LOGO[folder.provider]} alt="" />
          </span>
          <div className={panelStyles.listMain}>
            <strong>{folder.name}</strong>
            <CloudSourceBadge
              provider={folder.provider}
              location={folder.ownership === 'company' ? `Company folder${folder.accountEmail ? ` · ${folder.accountEmail}` : ''}` : `${folder.ownerName ? `${folder.ownerName}’s` : 'Someone’s'} folder`}
            />
            <span>
              Linked by {folder.linkedBy} {formatRelativeTime(folder.at)}
              {folder.indexedAt ? ` · ${folder.indexedCount ?? 0} item${folder.indexedCount === 1 ? '' : 's'} inside` : ''}
            </span>
            {note && <span className={styles.note}>{note}</span>}
          </div>
          <div className={panelStyles.listEnd}>
            {folder.reach !== 'disconnected' && (
              <Button size="sm" variant={open ? 'secondary' : 'ghost'} onClick={() => setBrowsing(open ? null : { folderId: folder.id })}>
                {open ? 'Close' : 'Open'}
              </Button>
            )}
            {folder.webUrl && (
              <IconButton size="sm" icon={<FiExternalLink />} label={`Open ${folder.name} in ${CLOUD_PROVIDER_LABEL[folder.provider]}`} onClick={() => window.open(folder.webUrl, '_blank', 'noopener,noreferrer')} />
            )}
            {folder.canUnlink && <IconButton size="sm" icon={<FiTrash2 />} label={`Unlink ${folder.name}`} disabled={busy === folder.id} onClick={() => unlink(folder)} />}
          </div>
        </div>
        {folder.subfolders.length > 0 && folder.reach !== 'disconnected' && (
          <div className={styles.subfolders}>
            {folder.subfolders.map((sub) => (
              <button key={sub.key} type="button" className={styles.subfolder} onClick={() => setBrowsing({ folderId: folder.id, start: sub.folderId })}>
                <FiFolder aria-hidden /> {sub.label}
              </button>
            ))}
          </div>
        )}
        {open && (
          <div className={styles.browser}>
            <CloudFileBrowser
              key={`${folder.id}-${browsing?.start ?? ''}`}
              source={customerFolderSource(customerId, folder.id)}
              provider={folder.provider}
              home={home}
              initialTrail={
                browsing?.start ? [home, { id: browsing.start, name: folder.subfolders.find((s) => s.folderId === browsing.start)?.label ?? 'Folder', kind: 'folder' }] : undefined
              }
              maxUploadBytes={accounts.data?.maxUploadBytes}
              showTree={false}
            />
          </div>
        )}
      </li>
    );
  };

  const haiveRow = (file: CustomerFile, canManage: boolean) => {
    const Icon = iconOf({ kind: 'file', name: file.name, mimeType: file.type });
    return (
      <li key={`file-${file.id}`} className={panelStyles.listRow}>
        <Icon aria-hidden className={panelStyles.listIcon} />
        <div className={panelStyles.listMain}>
          <strong>{file.name}</strong>
          <CloudSourceBadge provider={file.copiedFrom} copied />
          <span>
            {fileSize(file.size)} · added by {file.uploadedBy} {formatRelativeTime(file.at)}
          </span>
        </div>
        <div className={panelStyles.listEnd}>
          {file.kind === 'proof' && <Badge variant="neutral">Proof</Badge>}
          {file.jobId && file.jobNumber && <JobTag job={{ id: file.jobId, number: file.jobNumber }} onOpen={onOpenJob} />}
          <IconButton size="sm" icon={<FiDownload />} label={`Download ${file.name}`} onClick={() => void downloadFile(file)} />
          {(file.mine || canManage) && <IconButton size="sm" icon={<FiTrash2 />} label={`Delete ${file.name}`} onClick={() => void removeFile(file)} />}
        </div>
      </li>
    );
  };

  const cloudRow = (link: CustomerCloudLink) => {
    const Icon = iconOf({ kind: 'file', name: link.name, mimeType: link.mimeType });
    const status = STATUS[link.status];
    const note = link.status === 'available' ? reachNote(link) : undefined;
    const usable = link.status !== 'deleted' && link.reach !== 'disconnected';
    return (
      <li key={`link-${link.id}`} className={panelStyles.listRow}>
        <Icon aria-hidden className={panelStyles.listIcon} />
        <div className={panelStyles.listMain}>
          <strong>{link.name}</strong>
          <CloudSourceBadge provider={link.provider} location={link.location || undefined} />
          <span>
            {[link.size !== undefined ? formatBytes(link.size) : '', link.modifiedAt ? `modified ${formatModified(link.modifiedAt)}` : '', `attached by ${link.attachedBy} ${formatRelativeTime(link.at)}`]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {note && <span className={styles.note}>{note}</span>}
          <div className={styles.fileFields}>
            <select
              className={styles.select}
              value={link.category}
              aria-label={`Kind of document for ${link.name}`}
              onChange={(e) => void run(link.id, () => customerCloudService.updateLink(customerId, link.id, { category: e.target.value as DocumentCategory }))}
            >
              {(Object.keys(CATEGORY_LABEL) as DocumentCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
            {quotations.length > 0 && (
              <select
                className={styles.select}
                value={link.linkedTo?.id ?? ''}
                aria-label={`Quotation for ${link.name}`}
                onChange={(e) => void run(link.id, () => customerCloudService.updateLink(customerId, link.id, { quotationId: e.target.value || null }))}
              >
                <option value="">No quotation</option>
                {quotations.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className={panelStyles.listEnd}>
          {status && <Badge variant={status.variant}>{status.label}</Badge>}
          {usable && <IconButton size="sm" icon={<FiEye />} label={`Preview ${link.name}`} onClick={() => setPreviewing(link)} />}
          {usable && <IconButton size="sm" icon={<FiDownload />} label={`Download ${link.name}`} disabled={busy === link.id} onClick={() => void downloadLink(link)} />}
          {link.webUrl && (
            <IconButton size="sm" icon={<FiExternalLink />} label={`Open ${link.name} in ${CLOUD_PROVIDER_LABEL[link.provider]}`} onClick={() => window.open(link.webUrl, '_blank', 'noopener,noreferrer')} />
          )}
          {usable && <IconButton size="sm" icon={<FiCopy />} label={`Keep a copy of ${link.name} in HaiVE`} disabled={busy === link.id} onClick={() => void copyLink(link)} />}
          {link.canRemove && <IconButton size="sm" icon={<FiTrash2 />} label={`Remove ${link.name} from this customer`} disabled={busy === link.id} onClick={() => removeLink(link)} />}
        </div>
      </li>
    );
  };

  return (
    <section
      className={clsx(detailStyles.section, styles.documents, over && styles.documentsOver)}
      aria-label="Files and documents"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setOver(false);
        void upload([...e.dataTransfer.files]);
      }}
    >
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <FiSearch aria-hidden />
          <input type="search" value={search} placeholder="Search this customer’s documents" aria-label="Search this customer’s documents" onChange={(e) => setSearch(e.target.value)} />
        </label>
        <select className={styles.select} value={show} aria-label="Show" onChange={(e) => setShow(e.target.value as Show)}>
          <option value="">All documents</option>
          <optgroup label="Where">
            <option value="haive">Kept in HaiVE</option>
            <option value="google_drive">Google Drive</option>
            <option value="onedrive">OneDrive</option>
            <option value="folders">Customer folders</option>
          </optgroup>
          <optgroup label="Kind (attached cloud files)">
            {(Object.keys(CATEGORY_LABEL) as DocumentCategory[]).map((c) => (
              <option key={c} value={`kind:${c}`}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </optgroup>
        </select>
        <Dropdown
          align="right"
          trigger={
            <Button size="sm" leftIcon={<FiPlus />} loading={uploading > 0}>
              {uploading > 0 ? `Adding ${uploading}…` : 'Add'}
            </Button>
          }
          items={addItems}
        />
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Choose files to add"
          onChange={(e) => {
            void upload([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      <p className={styles.hint}>
        {total > 0 ? `${totalFolders > 0 ? `${totalFolders} folder${totalFolders === 1 ? '' : 's'} · ` : ''}${rows.length} file${rows.length === 1 ? '' : 's'} · ` : ''}
        Drop files anywhere here to keep them in HaiVE{limits ? ` (up to ${fileSize(limits.maxFileBytes)} each)` : ''}.
      </p>
      {cloud.error && <p className={styles.note}>Cloud documents couldn’t be loaded: {extractErrorMessage(cloud.error)}</p>}

      {loading ? (
        <Skeleton height={120} />
      ) : workspace.isError ? (
        <p className={styles.note}>
          This customer’s files couldn’t be loaded: {extractErrorMessage(workspace.error)}{' '}
          <button type="button" className={styles.retry} onClick={() => void workspace.refetch()}>
            Try again
          </button>
        </p>
      ) : total === 0 ? (
        <button type="button" className={clsx(styles.empty, over && styles.emptyOver)} onClick={() => input.current?.click()}>
          <FiUploadCloud aria-hidden />
          <strong>No documents for this customer yet</strong>
          <span>
            Drop files here or click to choose them
            {connected.length > 0 ? ' — or use Add for Google Drive and OneDrive.' : '.'}
          </span>
        </button>
      ) : folders.length + shown.length === 0 ? (
        <p className={detailStyles.muted}>Nothing matches.</p>
      ) : (
        <ul className={panelStyles.list} aria-label="Documents">
          {folders.map(folderRow)}
          {shown.map((row) => (row.type === 'haive' ? haiveRow(row.file, !!workspace.data?.canManage) : cloudRow(row.link)))}
        </ul>
      )}

      <CloudFilePickerModal
        open={picking === 'copy'}
        onClose={() => setPicking(null)}
        mode="pick"
        maxBytes={limits?.maxFileBytes}
        title="Copy from Google Drive or OneDrive"
        description="A copy of each file is kept in HaiVE with this customer. The original stays where it is."
        onPick={(files) => upload(files)}
      />
      <CloudFilePickerModal
        open={picking === 'attach'}
        onClose={() => setPicking(null)}
        mode="attach"
        title="Attach from the cloud"
        description={`The files stay in the cloud; the customer keeps a link to each.${kind ? ` Filed as ${CATEGORY_LABEL[kind]}.` : ''}`}
        onAttach={async (account, items) => {
          const added = await customerCloudService.attach(customerId, account.id, items.map((i) => i.id), kind);
          toast.success(added.length === 1 ? `${added[0].name} attached` : `${added.length} files attached`);
          refreshCloud();
        }}
      />
      <CloudFilePickerModal
        open={picking === 'folder'}
        onClose={() => setPicking(null)}
        mode="folder"
        folderNeedsEdit={false}
        title="Link the customer’s folder"
        description="Open the customer’s folder and choose it. Nothing in the cloud is moved or changed."
        submitLabel="Link this folder"
        onChooseFolder={async (account, folder) => {
          await customerCloudService.linkFolder(customerId, account.id, folder.id);
          toast.success(`${folder.name} linked`);
          refreshCloud();
        }}
      />
      {creating && (
        <CreateFolderDialog
          accounts={connected}
          defaultName={folderName}
          onClose={() => setCreating(false)}
          onCreate={async (account, parent, name, subfolders) => {
            await customerCloudService.createFolder(customerId, account.id, parent.id, name, subfolders);
            toast.success(`Folder “${name}” ready`);
            refreshCloud();
          }}
        />
      )}
      {previewing && (
        <CloudPreviewModal
          provider={previewing.provider}
          source={customerLinkSource(customerId, previewing.id)}
          item={{ id: previewing.fileId, name: previewing.name, kind: 'file', mimeType: previewing.mimeType, size: previewing.size, modifiedAt: previewing.modifiedAt, webUrl: previewing.webUrl }}
          onClose={() => setPreviewing(null)}
        />
      )}
    </section>
  );
}

/** Making the customer's folder: which account, inside which folder, what it is called, and whether to add its five folders. */
function CreateFolderDialog({
  accounts,
  defaultName,
  onClose,
  onCreate,
}: {
  accounts: CloudConnection[];
  defaultName: string;
  onClose: () => void;
  onCreate: (account: CloudConnection, parent: CloudItem, name: string, subfolders: boolean) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [parent, setParent] = useState<CloudItem | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [name, setName] = useState(defaultName);
  const [subfolders, setSubfolders] = useState(true);
  const [saving, setSaving] = useState(false);
  const account = accounts.find((a) => a.id === accountId);

  const create = async () => {
    if (!account || !parent || !name.trim()) return;
    setSaving(true);
    try {
      await onCreate(account, parent, name.trim(), subfolders);
      onClose();
    } catch (error) {
      toast.error(extractErrorMessage(error), { duration: 8_000 });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Create a customer folder" description="Made only now, in the folder you choose. Asking again finds the same folder rather than making another.">
      <div className={styles.form}>
        <label className={styles.field}>
          <span>Account</span>
          <select
            className={styles.select}
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setParent(null);
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {CLOUD_PROVIDER_LABEL[a.provider]} · {connectionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.field}>
          <span>Inside</span>
          <div className={styles.parent}>
            <span>{parent ? parent.name : 'No folder chosen yet'}</span>
            <Button size="sm" variant="secondary" leftIcon={<FiFolder />} disabled={!account} onClick={() => setChoosing(true)}>
              {parent ? 'Change' : 'Choose folder'}
            </Button>
          </div>
        </div>
        <Input label="Folder name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        <label className={styles.check}>
          <input type="checkbox" checked={subfolders} onChange={(e) => setSubfolders(e.target.checked)} />
          Add Quotations, Invoices, Contracts, Orders and General Documents folders inside it
        </label>
      </div>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={saving} disabled={!account || !parent || !name.trim()} onClick={() => void create()}>
          Create folder
        </Button>
      </div>
      {account && (
        <CloudFolderChooser
          connection={account}
          open={choosing}
          title="Where should the customer folder go?"
          submit="Create it here"
          onClose={() => setChoosing(false)}
          onChoose={(folder) => setParent(folder)}
        />
      )}
    </Modal>
  );
}

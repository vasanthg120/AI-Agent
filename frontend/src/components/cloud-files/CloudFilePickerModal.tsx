import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiMonitor, FiUploadCloud, FiX } from 'react-icons/fi';
import { Badge, Button, EmptyState, IconButton, Modal, Skeleton, Tabs } from '@/components/ui';
import {
  CLOUD_PROVIDER_LABEL,
  cloudFilesService,
  connectionLabel,
  type CloudConnection,
  type CloudItem,
  type CloudProviderId,
} from '@/services/cloudFilesService';
import { extractErrorMessage } from '@/utils/errors';
import { CloudFileBrowser } from './CloudFileBrowser';
import { downloadName, formatBytes } from './cloudFormat';
import styles from './CloudFilePickerModal.module.css';

export type CloudPickerMode = 'pick' | 'attach' | 'folder';

export interface CloudFilePickerModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  /**
   * pick: the chosen files are fetched through HaiVE and handed over as File objects, exactly as if
   * chosen on this computer (they become HaiVE's copy) · attach: the cloud files themselves, by
   * reference · folder: one folder (where an upload goes).
   */
  mode: CloudPickerMode;
  multiple?: boolean;
  /** What the page takes, as a file input's accept (".pdf,.png"). */
  accept?: string;
  maxBytes?: number;
  /** pick: offer "This computer" as the first tab. */
  allowComputer?: boolean;
  onPick?: (files: File[]) => void | Promise<void>;
  onAttach?: (connection: CloudConnection, items: CloudItem[]) => void | Promise<void>;
  onChooseFolder?: (connection: CloudConnection, folder: CloudItem) => void | Promise<void>;
  submitLabel?: string;
  /** folder: only a folder the person may add to can be chosen (uploads). Off for linking a folder they only view. */
  folderNeedsEdit?: boolean;
}

const COMPUTER = 'computer';

/** Every account the person may open, per provider: their own first, then the company's. */
export function useCloudAccounts(enabled = true) {
  return useQuery({ queryKey: ['cloud-files', 'overview'], queryFn: () => cloudFilesService.overview(), staleTime: 30_000, enabled });
}

// One dialog for choosing files wherever HaiVE takes one: from this computer, from
// Google Drive or from OneDrive. Cloud files picked here are either copied into
// HaiVE (pick) or kept as links to the cloud file (attach) — the page asking says which.
export function CloudFilePickerModal({
  open,
  onClose,
  title,
  description,
  mode,
  multiple = true,
  accept,
  maxBytes,
  allowComputer = false,
  onPick,
  onAttach,
  onChooseFolder,
  submitLabel,
  folderNeedsEdit = true,
}: CloudFilePickerModalProps) {
  const overview = useCloudAccounts(open);
  const [tab, setTab] = useState<string>(allowComputer ? COMPUTER : 'google_drive');
  const [accountId, setAccountId] = useState<string>();
  const [selected, setSelected] = useState<CloudItem[]>([]);
  const [folder, setFolder] = useState<{ item: CloudItem | null; canEdit: boolean }>({ item: null, canEdit: false });
  const [working, setWorking] = useState<{ done: number; total: number; percent: number } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const computerInput = useRef<HTMLInputElement>(null);

  const providers = overview.data?.providers ?? [];
  const provider = providers.find((p) => p.id === tab);
  const accounts: CloudConnection[] = useMemo(() => (provider ? [...provider.mine, ...(provider.company ? [provider.company] : [])] : []), [provider]);
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];

  // A fresh start each time it opens; the first tab with an account when there is no computer tab.
  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setWorking(null);
    setAccountId(undefined);
    if (allowComputer) setTab(COMPUTER);
  }, [open, allowComputer]);
  useEffect(() => {
    if (!open || allowComputer || !overview.data) return;
    // Where an account is connected; failing that, a provider that can be connected (not one that isn't set up).
    const first = overview.data.providers.find((p) => p.mine.length > 0 || p.company) ?? overview.data.providers.find((p) => p.configured);
    if (first) setTab(first.id);
  }, [open, allowComputer, overview.data]);
  useEffect(() => setSelected([]), [account?.id]);

  const close = () => {
    controller.current?.abort();
    onClose();
  };

  const toggle = (item: CloudItem) =>
    setSelected((all) => (all.some((s) => s.id === item.id) ? all.filter((s) => s.id !== item.id) : multiple ? [...all, item] : [item]));

  const submit = async () => {
    if (!account) return;
    if (mode === 'folder') {
      if (!folder.item) return;
      setWorking({ done: 0, total: 1, percent: 0 });
      try {
        await onChooseFolder?.(account, folder.item);
        onClose();
      } catch (error) {
        toast.error(extractErrorMessage(error));
      } finally {
        setWorking(null);
      }
      return;
    }
    if (selected.length === 0) return;
    if (mode === 'attach') {
      setWorking({ done: 0, total: selected.length, percent: 0 });
      try {
        await onAttach?.(account, selected);
        onClose();
      } catch (error) {
        toast.error(extractErrorMessage(error));
      } finally {
        setWorking(null);
      }
      return;
    }
    // pick: each file fetched through HaiVE, then handed over like one chosen on this computer.
    controller.current = new AbortController();
    const files: File[] = [];
    try {
      for (const [index, item] of selected.entries()) {
        setWorking({ done: index, total: selected.length, percent: 0 });
        const blob = await cloudFilesService.content(account.id, item.id, {
          signal: controller.current.signal,
          onProgress: (percent) => setWorking({ done: index, total: selected.length, percent }),
        });
        if (maxBytes && blob.size > maxBytes) {
          toast.error(`${item.name} is larger than ${formatBytes(maxBytes)} — skipped.`);
          continue;
        }
        files.push(new File([blob], downloadName(item), { type: blob.type || item.mimeType || 'application/octet-stream', lastModified: item.modifiedAt ? Date.parse(item.modifiedAt) : Date.now() }));
      }
      if (files.length > 0) await onPick?.(files);
      onClose();
    } catch (error) {
      if (!controller.current.signal.aborted) toast.error(extractErrorMessage(error));
    } finally {
      setWorking(null);
    }
  };

  const tabs = [
    ...(allowComputer ? [{ id: COMPUTER, label: 'This computer', icon: <FiMonitor /> }] : []),
    ...(['google_drive', 'onedrive'] as CloudProviderId[]).map((id) => ({
      id,
      label: CLOUD_PROVIDER_LABEL[id],
      icon: <img src={id === 'google_drive' ? '/integrations/google-drive.svg' : '/integrations/onedrive.svg'} alt="" width={14} height={14} />,
    })),
  ];

  let body;
  if (tab === COMPUTER) {
    body = (
      <div className={styles.computer}>
        <FiUploadCloud aria-hidden />
        <p>Choose files from this computer.</p>
        <Button onClick={() => computerInput.current?.click()}>Choose files</Button>
        <input
          ref={computerInput}
          type="file"
          hidden
          multiple={multiple}
          accept={accept}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length === 0) return;
            void Promise.resolve(onPick?.(files)).then(onClose, (error) => toast.error(extractErrorMessage(error)));
          }}
        />
      </div>
    );
  } else if (overview.isLoading) {
    body = <Skeleton height={240} />;
  } else if (overview.error) {
    body = <EmptyState compact title="Your accounts couldn’t be loaded" description={extractErrorMessage(overview.error)} />;
  } else if (!provider?.configured) {
    body = (
      <EmptyState
        compact
        title={`${CLOUD_PROVIDER_LABEL[tab as CloudProviderId]} isn’t set up yet`}
        description="Your HaiVE administrator needs to add this provider’s app keys before anyone can connect it."
      />
    );
  } else if (!account) {
    body = (
      <EmptyState
        compact
        title={`Connect ${provider.label}`}
        description={`Connect your ${provider.label} account to choose files from it. You'll come back to the Integrations page.`}
        action={
          <Button
            size="sm"
            onClick={() =>
              void cloudFilesService
                .connectUrl(provider.id, 'personal')
                .then((url) => window.location.assign(url))
                .catch((error) => toast.error(extractErrorMessage(error)))
            }
          >
            Connect {provider.label}
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        {accounts.length > 1 && (
          <label className={styles.account}>
            <span>Account</span>
            <select value={account.id} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {connectionLabel(a)}
                </option>
              ))}
            </select>
          </label>
        )}
        <CloudFileBrowser
          key={account.id}
          connection={account}
          mode={mode === 'folder' ? 'folder' : 'pick'}
          selected={selected}
          onToggle={toggle}
          accept={accept}
          maxBytes={maxBytes}
          onLocationChange={(item, canEdit) => setFolder({ item, canEdit })}
          showTree={false}
        />
      </>
    );
  }

  const cloudTab = tab !== COMPUTER && !!account;
  const ready = mode === 'folder' ? !!folder.item && !folder.item.root && (folder.canEdit || !folderNeedsEdit) : selected.length > 0;
  const label =
    submitLabel ??
    (mode === 'folder' ? 'Choose this folder' : mode === 'attach' ? `Attach${selected.length > 1 ? ` ${selected.length} files` : ''}` : `Select${selected.length > 1 ? ` ${selected.length} files` : ''}`);

  return (
    <Modal open={open} onClose={close} title={title ?? (mode === 'folder' ? 'Choose a folder' : 'Choose files')} description={description} maxWidth={860}>
      <div className={styles.picker}>
        <Tabs items={tabs} activeId={tab} onChange={setTab} />
        <div className={styles.body}>{body}</div>

        {cloudTab && mode !== 'folder' && selected.length > 0 && (
          <div className={styles.selected} aria-label="Selected files">
            {selected.map((item) => (
              <span key={item.id} className={styles.chip}>
                <span title={item.name}>{item.name}</span>
                {item.size !== undefined && <small>{formatBytes(item.size)}</small>}
                <IconButton size="sm" icon={<FiX />} label={`Remove ${item.name}`} onClick={() => toggle(item)} />
              </span>
            ))}
          </div>
        )}

        {cloudTab && (
          <div className={styles.footer}>
            <span className={styles.footerNote}>
              {working && mode === 'pick'
                ? `Fetching ${working.done + 1} of ${working.total}${working.percent ? ` · ${working.percent}%` : ''}…`
                : mode === 'folder'
                  ? folder.item
                    ? folder.item.root
                      ? 'Open a folder inside it.'
                      : folder.canEdit || !folderNeedsEdit
                        ? `Chosen: ${folder.item.name}`
                        : 'You can’t add files to this folder — open another.'
                    : 'Open the folder to use.'
                  : mode === 'pick'
                    ? 'A copy of each file is added to HaiVE.'
                    : 'The files stay in the cloud; HaiVE keeps a link to them.'}
              {accept && mode !== 'folder' && (
                <Badge variant="neutral">{accept.split(',').map((e) => e.trim().replace(/^\./, '').toUpperCase()).filter(Boolean).slice(0, 6).join(', ')}</Badge>
              )}
            </span>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} loading={!!working} disabled={!ready}>
              {label}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}


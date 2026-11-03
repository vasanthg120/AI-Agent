import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  FiAlertCircle,
  FiChevronRight,
  FiDownload,
  FiEdit2,
  FiExternalLink,
  FiEye,
  FiFolderPlus,
  FiGrid,
  FiHardDrive,
  FiList,
  FiLock,
  FiMoreHorizontal,
  FiMove,
  FiRefreshCw,
  FiSearch,
  FiTrash2,
  FiUploadCloud,
  FiX,
} from 'react-icons/fi';
import { Button, Dropdown, EmptyState, IconButton, Input, Modal, Skeleton } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import {
  CLOUD_PROVIDER_LABEL,
  cloudErrorKind,
  saveBlob,
  type CloudConnection,
  type CloudFileType,
  type CloudItem,
  type CloudProviderId,
  type CloudSort,
} from '@/services/cloudFilesService';
import { extractErrorMessage } from '@/utils/errors';
import { CloudFolderTree } from './CloudFolderTree';
import { CloudPreviewModal } from './CloudPreviewModal';
import { CloudUploadQueue, useCloudUploads } from './CloudUploadQueue';
import { accepts, downloadName, formatBytes, formatModified, iconOf, TYPE_LABEL } from './cloudFormat';
import { connectionSource, type CloudSource } from './cloudSources';
import styles from './cloudFiles.module.css';

export type CloudBrowserMode = 'manage' | 'pick' | 'folder';

export interface CloudFileBrowserProps {
  /** The account to browse… */
  connection?: CloudConnection;
  /** …or another source of files (a customer's folder), and whose files they are. */
  source?: CloudSource;
  provider?: CloudProviderId;
  /** manage: the full file manager · pick: choose files · folder: choose a folder (only folders are shown). */
  mode?: CloudBrowserMode;
  /** pick: what is chosen so far, and choosing / un-choosing one. */
  selected?: CloudItem[];
  onToggle?: (item: CloudItem) => void;
  /** pick: what the page asking takes (".pdf,.png") and how large. */
  accept?: string;
  maxBytes?: number;
  /** Where the browser is now — in folder mode, the folder that would be chosen (null at the starting points). */
  onLocationChange?: (folder: CloudItem | null, canEdit: boolean) => void;
  /** Start in this folder and never go above it (a customer's folder). */
  home?: CloudItem;
  /** Start in this folder, reached by these folders (a search result's place) — free to go up from there. */
  initialTrail?: CloudItem[];
  maxUploadBytes?: number;
  /** Hears of every upload and change, for whatever else shows these files. */
  onChanged?: () => void;
  /** The folder tree beside the list (shown when there is room). */
  showTree?: boolean;
}

const VIEW_KEY = 'haive.cloudFiles.view';
const MODIFIED: Record<string, { label: string; days: number }> = {
  '7': { label: 'Last 7 days', days: 7 },
  '30': { label: 'Last 30 days', days: 30 },
  '365': { label: 'Last year', days: 365 },
};

function readView(): 'list' | 'grid' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

// A Google Drive or OneDrive account, browsed from inside HaiVE. The backend decides
// which folders this person may open and change; this shows what it returns and
// says plainly when something can't be opened (reconnect, no permission, gone).
export function CloudFileBrowser({
  connection,
  source,
  provider: providerProp,
  mode = 'manage',
  selected = [],
  onToggle,
  accept,
  maxBytes,
  onLocationChange,
  home,
  initialTrail,
  maxUploadBytes = 100 * 1024 * 1024,
  onChanged,
  showTree = true,
}: CloudFileBrowserProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const providerId = (connection?.provider ?? providerProp)!;
  const provider = CLOUD_PROVIDER_LABEL[providerId];
  const src = useMemo(() => source ?? connectionSource(connection!.id), [source, connection]);
  // A starting place inside `home` (a customer's Quotations folder) is honoured; anything else starts at home.
  const [trail, setTrail] = useState<CloudItem[]>(home ? (initialTrail?.[0]?.id === home.id ? initialTrail : [home]) : (initialTrail ?? []));
  const [view, setView] = useState<'list' | 'grid'>(readView);
  const [sort, setSort] = useState<CloudSort>('name');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [type, setType] = useState<CloudFileType | ''>('');
  const [modified, setModified] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [searchHere, setSearchHere] = useState(true);
  const [previewing, setPreviewing] = useState<CloudItem | null>(null);
  const [renaming, setRenaming] = useState<CloudItem | null>(null);
  const [moving, setMoving] = useState<CloudItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [chosen, setChosen] = useState<Map<string, CloudItem>>(new Map());
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const current = trail.at(-1);
  const atTop = !current;

  // The search runs a moment after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // A private window: the choice lasts until the page closes.
    }
  }, [view]);

  // Leaving a folder forgets what was ticked in it.
  useEffect(() => setChosen(new Map()), [current?.id]);

  const roots = useQuery({
    queryKey: ['cloud-files', src.key, 'roots'],
    queryFn: () => src.roots!(),
    enabled: !!src.roots && !home,
    staleTime: 60_000,
  });

  const listing = useInfiniteQuery({
    queryKey: ['cloud-files', src.key, 'list', current?.id, sort, direction, type, mode === 'folder'],
    queryFn: ({ pageParam }) => src.list(current!.id, { cursor: pageParam, sort, direction, type: type || undefined, foldersOnly: mode === 'folder' }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor,
    enabled: !!current && !search,
  });

  const searchScope = home ? home.id : searchHere && current ? current.id : undefined;
  const results = useInfiniteQuery({
    queryKey: ['cloud-files', src.key, 'search', search, type, modified, searchScope],
    queryFn: ({ pageParam }) =>
      src.search({
        q: search,
        type: (mode === 'folder' ? 'folder' : type) || undefined,
        modifiedAfter: modified ? new Date(Date.now() - MODIFIED[modified].days * 86_400_000).toISOString() : undefined,
        folderId: searchScope,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor,
    enabled: !!search,
  });

  const folderInfo = listing.data?.pages[0];
  const canEdit = mode !== 'pick' && !!folderInfo?.canEdit;
  // Kept in a ref: a parent passing a new function each render must not re-run this.
  const reportLocation = useRef(onLocationChange);
  reportLocation.current = onLocationChange;
  useEffect(() => {
    if (atTop) reportLocation.current?.(null, false);
    else if (folderInfo) reportLocation.current?.(folderInfo.folder, folderInfo.canEdit);
  }, [atTop, folderInfo]);

  const items: CloudItem[] = useMemo(() => {
    if (search) return (results.data?.pages ?? []).flatMap((p) => p.items).filter((i) => mode !== 'folder' || i.kind === 'folder');
    if (atTop) return roots.data ?? [];
    const all = (listing.data?.pages ?? []).flatMap((p) => p.items);
    // A listing has no date filter on the provider's side: applied to what is loaded.
    const since = modified ? Date.now() - MODIFIED[modified].days * 86_400_000 : 0;
    return since ? all.filter((i) => i.kind === 'folder' || (i.modifiedAt && Date.parse(i.modifiedAt) >= since)) : all;
  }, [search, results.data, atTop, roots.data, listing.data, modified, mode]);

  const active = search ? results : atTop ? roots : listing;
  const loading = active.isLoading;
  const error = active.error;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['cloud-files', src.key] });
    onChanged?.();
  };

  const uploads = useCloudUploads(src, maxUploadBytes, (item, folder) => {
    toast.success(`${item.name} uploaded to ${folder.name}`);
    refresh();
  });

  const open = async (item: CloudItem) => {
    if (item.kind === 'folder') {
      if (!search) {
        setTrail(atTop ? [item] : [...trail, item]);
        return;
      }
      // From a search result: the way to it, as far as this person may follow it.
      try {
        if (!src.item) throw new Error('no path');
        const { path = [] } = await src.item(item.id, true);
        const full = [...path, item];
        const from = home ? full.findIndex((p) => p.id === home.id) : 0;
        setTrail(from >= 0 ? full.slice(from) : [item]);
      } catch {
        setTrail(home ? [home, item] : [item]);
      }
      setSearchInput('');
      setSearch('');
      return;
    }
    if (mode === 'pick') {
      if (!blocked(item)) onToggle?.(item);
      return;
    }
    setPreviewing(item);
  };

  /** Why a file can't be picked here, if it can't. */
  const blocked = (item: CloudItem): string | undefined => {
    if (mode !== 'pick' || item.kind === 'folder') return undefined;
    if (!accepts(accept, item)) return 'Not a kind of file this takes';
    if (maxBytes && item.size !== undefined && item.size > maxBytes) return `Larger than ${formatBytes(maxBytes)}`;
    return undefined;
  };

  const download = async (list: CloudItem[]) => {
    const files = list.filter((i) => i.kind === 'file');
    if (files.length === 0) return;
    setBusy(true);
    const toastId = toast.loading(files.length === 1 ? `Downloading ${files[0].name}…` : `Downloading ${files.length} files…`);
    let done = 0;
    for (const file of files) {
      try {
        saveBlob(await src.content(file.id), downloadName(file));
        done += 1;
      } catch (failure) {
        toast.error(`${file.name}: ${extractErrorMessage(failure)}`);
      }
    }
    toast.dismiss(toastId);
    if (done > 0) toast.success(done === 1 ? 'Downloaded' : `${done} files downloaded`);
    setBusy(false);
  };

  const remove = async (list: CloudItem[]) => {
    if (list.length === 0) return;
    const what = list.length === 1 ? `“${list[0].name}”` : `${list.length} items`;
    if (!window.confirm(`Move ${what} to the ${provider} ${providerId === 'onedrive' ? 'recycle bin' : 'trash'}? It can be restored from there.`)) return;
    setBusy(true);
    let done = 0;
    for (const item of list) {
      try {
        await src.remove!(item.id);
        done += 1;
      } catch (failure) {
        toast.error(`${item.name}: ${extractErrorMessage(failure)}`);
      }
    }
    if (done > 0) toast.success(done === 1 ? 'Deleted' : `${done} items deleted`);
    setChosen(new Map());
    setBusy(false);
    refresh();
  };

  const toggleChosen = (item: CloudItem) =>
    setChosen((all) => {
      const next = new Map(all);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });

  const isChecked = (item: CloudItem) => (mode === 'pick' ? selected.some((s) => s.id === item.id) : chosen.has(item.id));
  const showChecks = (mode === 'pick' || mode === 'manage') && !atTop;

  const menu = (item: CloudItem) => {
    const editable = canEdit && !item.root;
    return [
      ...(item.kind === 'file' ? [{ id: 'preview', label: 'Preview', icon: <FiEye />, onSelect: () => setPreviewing(item) }] : []),
      ...(item.kind === 'file' ? [{ id: 'download', label: 'Download', icon: <FiDownload />, onSelect: () => void download([item]) }] : []),
      ...(item.webUrl ? [{ id: 'open', label: `Open in ${provider}`, icon: <FiExternalLink />, onSelect: () => window.open(item.webUrl, '_blank', 'noopener,noreferrer') }] : []),
      ...(editable && src.update && item.canEdit !== false
        ? [
            { id: 'rename', label: 'Rename', icon: <FiEdit2 />, separatorBefore: true, onSelect: () => setRenaming(item) },
            ...(connection ? [{ id: 'move', label: 'Move to…', icon: <FiMove />, onSelect: () => setMoving(item) }] : []),
          ]
        : []),
      ...(editable && src.remove && item.canDelete !== false ? [{ id: 'delete', label: 'Delete', icon: <FiTrash2 />, danger: true, onSelect: () => void remove([item]) }] : []),
    ];
  };

  // ---- what to show when nothing can be listed -------------------------------------------
  let problem: React.ReactNode = null;
  if (connection?.status === 'needs_reauth' || cloudErrorKind(error) === 'auth') {
    problem = (
      <EmptyState
        compact
        icon={FiLock}
        title={`Reconnect ${provider}`}
        description={
          connection ? `The connection to ${connection.accountEmail} has expired or was withdrawn.` : `The ${provider} account this folder is in needs to be reconnected.`
        }
        action={
          <Button size="sm" onClick={() => navigate(ROUTES.integrations)}>
            Go to Integrations
          </Button>
        }
      />
    );
  } else if (error) {
    const kind = cloudErrorKind(error);
    problem = (
      <EmptyState
        compact
        icon={kind === 'permission' ? FiLock : FiAlertCircle}
        title={kind === 'permission' ? 'You don’t have access to this' : kind === 'not_found' ? 'This folder is no longer there' : `${provider} couldn’t be read`}
        description={extractErrorMessage(error)}
        action={
          <Button size="sm" variant="secondary" onClick={() => (kind === 'not_found' || kind === 'permission' ? setTrail(home ? [home] : []) : void active.refetch())}>
            {kind === 'not_found' || kind === 'permission' ? 'Back to the start' : 'Try again'}
          </Button>
        }
      />
    );
  }

  const crumbs = trail;
  const location = (
    <div className={styles.where}>
      <nav className={styles.crumbs} aria-label="Folder path">
        {!home && (
          <>
            <button type="button" className={clsx(styles.crumb, atTop && styles.crumbCurrent)} onClick={() => setTrail([])} aria-current={atTop ? 'page' : undefined}>
              <FiHardDrive aria-hidden /> {connection?.ownership === 'company' ? `Company ${provider}` : provider}
            </button>
            {crumbs.length > 0 && <FiChevronRight className={styles.crumbSep} aria-hidden />}
          </>
        )}
        {crumbs.map((folder, i) => (
          <span key={`${folder.id}-${i}`} style={{ display: 'contents' }}>
            <button
              type="button"
              className={clsx(styles.crumb, i === crumbs.length - 1 && styles.crumbCurrent)}
              aria-current={i === crumbs.length - 1 ? 'page' : undefined}
              onClick={() => setTrail(trail.slice(0, i + 1))}
              title={folder.name}
            >
              {folder.name}
            </button>
            {i < crumbs.length - 1 && <FiChevronRight className={styles.crumbSep} aria-hidden />}
          </span>
        ))}
      </nav>
      {search ? (
        <span className={styles.note}>Search results{searchScope ? ` in ${trail.find((t) => t.id === searchScope)?.name ?? 'this folder'}` : ` across ${provider}`}</span>
      ) : current && !canEdit && mode === 'manage' ? (
        <span className={styles.note}>
          <FiLock aria-hidden /> View only
        </span>
      ) : null}
    </div>
  );

  const toolbar = (
    <div className={styles.toolbar}>
      <label className={styles.search}>
        <FiSearch aria-hidden />
        <input
          type="search"
          value={searchInput}
          placeholder={mode === 'folder' ? 'Search folders' : `Search ${provider}`}
          aria-label={`Search ${provider}`}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        {searchInput && (
          <IconButton className={styles.searchClear} size="sm" icon={<FiX />} label="Clear search" onClick={() => setSearchInput('')} />
        )}
      </label>
      {!home && current && searchInput && (
        <select className={styles.select} value={searchHere ? 'here' : 'all'} onChange={(e) => setSearchHere(e.target.value === 'here')} aria-label="Where to search">
          <option value="here">In this folder</option>
          <option value="all">Everywhere</option>
        </select>
      )}
      {mode !== 'folder' && (
        <select className={styles.select} value={type} onChange={(e) => setType(e.target.value as CloudFileType | '')} aria-label="File type">
          <option value="">All types</option>
          {(Object.keys(TYPE_LABEL) as CloudFileType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      )}
      {mode !== 'folder' && (
        <select className={styles.select} value={modified} onChange={(e) => setModified(e.target.value)} aria-label="Modified">
          <option value="">Any time</option>
          {Object.entries(MODIFIED).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      )}
      <select
        className={styles.select}
        value={`${sort}:${direction}`}
        aria-label="Sort"
        onChange={(e) => {
          const [s, d] = e.target.value.split(':') as [CloudSort, 'asc' | 'desc'];
          setSort(s);
          setDirection(d);
        }}
      >
        <option value="name:asc">Name A–Z</option>
        <option value="name:desc">Name Z–A</option>
        <option value="modified:desc">Newest first</option>
        <option value="modified:asc">Oldest first</option>
        <option value="size:desc">Largest first</option>
      </select>
      <div className={styles.toolbarEnd}>
        {mode !== 'folder' && (
          <IconButton
            icon={view === 'list' ? <FiGrid /> : <FiList />}
            label={view === 'list' ? 'Show as grid' : 'Show as list'}
            onClick={() => setView(view === 'list' ? 'grid' : 'list')}
          />
        )}
        <IconButton icon={<FiRefreshCw />} label="Refresh" onClick={refresh} />
        {canEdit && current && src.createFolder && (
          <Button size="sm" variant="secondary" leftIcon={<FiFolderPlus />} onClick={() => setCreating(true)}>
            New folder
          </Button>
        )}
        {canEdit && current && mode === 'manage' && src.upload && (
          <>
            <Button size="sm" leftIcon={<FiUploadCloud />} onClick={() => fileInput.current?.click()}>
              Upload
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-label={`Upload to ${current.name}`}
              onChange={(e) => {
                uploads.add([...(e.target.files ?? [])], current);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>
    </div>
  );

  const bulk =
    mode === 'manage' && chosen.size > 0 ? (
      <div className={styles.where}>
        <span className={styles.note}>{chosen.size} selected</span>
        <div className={styles.toolbarEnd}>
          <Button size="sm" variant="secondary" leftIcon={<FiDownload />} loading={busy} onClick={() => void download([...chosen.values()])}>
            Download
          </Button>
          {canEdit && src.remove && (
            <Button size="sm" variant="danger" leftIcon={<FiTrash2 />} disabled={busy} onClick={() => void remove([...chosen.values()])}>
              Delete
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setChosen(new Map())}>
            Clear
          </Button>
        </div>
      </div>
    ) : null;

  const describe = (item: CloudItem) =>
    item.root ? '' : item.kind === 'folder' ? formatModified(item.modifiedAt) : `${formatBytes(item.size)} · ${formatModified(item.modifiedAt)}`;

  const rowCheck = (item: CloudItem) => {
    if (!showChecks || item.root) return <span />;
    if (mode === 'pick' && item.kind === 'folder') return <span />;
    const reason = blocked(item);
    return (
      <span className={styles.check} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={isChecked(item)}
          disabled={!!reason}
          aria-label={`Select ${item.name}`}
          onChange={() => (mode === 'pick' ? onToggle?.(item) : toggleChosen(item))}
        />
      </span>
    );
  };

  const keyOpen = (item: CloudItem) => (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void open(item);
    }
  };

  const listBody =
    view === 'grid' && mode !== 'folder' ? (
      <div className={styles.tiles}>
        {items.map((item) => {
          const Icon = iconOf(item);
          const reason = blocked(item);
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              title={reason ?? item.name}
              className={clsx(styles.tile, item.kind === 'folder' && styles.tileFolder, isChecked(item) && styles.rowSelected, reason && styles.rowDisabled)}
              onClick={() => void open(item)}
              onKeyDown={keyOpen(item)}
            >
              {showChecks && !item.root && <span className={styles.tileCheck}>{rowCheck(item)}</span>}
              {mode === 'manage' && !item.root && menu(item).length > 0 && (
                <span className={styles.tileMenu} onClick={(e) => e.stopPropagation()}>
                  <Dropdown align="right" usePortal trigger={<IconButton size="sm" icon={<FiMoreHorizontal />} label={`Actions for ${item.name}`} />} items={menu(item)} />
                </span>
              )}
              <span className={styles.tileIcon}>{item.root ? <FiHardDrive /> : <Icon />}</span>
              <strong>{item.name}</strong>
              <span className={styles.tileMeta}>{reason ?? describe(item)}</span>
            </div>
          );
        })}
      </div>
    ) : (
      <div className={clsx(styles.list, !showChecks && styles.listNoCheck)} role="table" aria-label={current ? current.name : provider}>
        <div className={styles.head} role="row">
          <span role="columnheader" />
          <span role="columnheader">Name</span>
          <span role="columnheader" className={styles.colModified}>
            Modified
          </span>
          <span role="columnheader" className={styles.colSize}>
            Size
          </span>
          <span role="columnheader" />
        </div>
        {items.map((item) => {
          const Icon = item.root ? FiHardDrive : iconOf(item);
          const reason = blocked(item);
          return (
            <div
              key={item.id}
              role="row"
              tabIndex={0}
              title={reason}
              className={clsx(styles.row, isChecked(item) && styles.rowSelected, reason && styles.rowDisabled)}
              onClick={() => void open(item)}
              onKeyDown={keyOpen(item)}
            >
              <span role="cell">{rowCheck(item)}</span>
              <span role="cell" className={styles.name}>
                <span className={clsx(styles.nameIcon, item.kind === 'folder' && styles.nameIconFolder)}>
                  <Icon aria-hidden />
                </span>
                <span className={styles.nameText}>
                  <strong>{item.name}</strong>
                  {!item.root && <span className={styles.nameMeta}>{reason ?? describe(item)}</span>}
                </span>
              </span>
              <span role="cell" className={clsx(styles.cell, styles.colModified)}>
                {item.root ? '' : formatModified(item.modifiedAt)}
              </span>
              <span role="cell" className={clsx(styles.cell, styles.colSize)}>
                {item.kind === 'folder' ? '' : formatBytes(item.size)}
              </span>
              <span role="cell" className={styles.actions} onClick={(e) => e.stopPropagation()}>
                {mode === 'manage' && !item.root && menu(item).length > 0 && (
                  <Dropdown align="right" usePortal trigger={<IconButton size="sm" icon={<FiMoreHorizontal />} label={`Actions for ${item.name}`} />} items={menu(item)} />
                )}
              </span>
            </div>
          );
        })}
      </div>
    );

  const empty = search
    ? { title: 'Nothing found', description: `No ${mode === 'folder' ? 'folder' : 'file or folder'} matches “${search}”.` }
    : atTop
      ? { title: 'Nothing to open', description: `This ${provider} account has no folders to show.` }
      : { title: mode === 'folder' ? 'No folders here' : 'This folder is empty', description: canEdit && mode === 'manage' ? 'Upload files or make a folder.' : undefined };

  const tops = home ? [home] : (roots.data ?? []);
  const next = search ? results : listing;

  return (
    <div className={clsx(styles.browser, (!showTree || tops.length === 0) && styles.browserNoTree)}>
      {showTree && tops.length > 0 && (
        <CloudFolderTree
          source={src}
          tops={tops}
          trail={trail}
          onOpen={(path) => {
            setSearchInput('');
            setSearch('');
            setTrail(path);
          }}
        />
      )}
      <div className={styles.main}>
        {toolbar}
        {location}
        {bulk}
        <CloudUploadQueue provider={providerId} uploads={uploads} />
        {problem ??
          (loading ? (
            <div className={styles.skeletonRows}>
              <Skeleton height={36} />
              <Skeleton height={36} />
              <Skeleton height={36} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState compact title={empty.title} description={empty.description} />
          ) : (
            listBody
          ))}
        {!problem && !atTop && next.hasNextPage && (
          <div className={styles.loadMore}>
            <Button size="sm" variant="secondary" loading={next.isFetchingNextPage} onClick={() => void next.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </div>

      <CloudPreviewModal provider={providerId} source={src} item={previewing} onClose={() => setPreviewing(null)} />
      <NameDialog
        open={creating}
        title="New folder"
        label="Folder name"
        submit="Create folder"
        onClose={() => setCreating(false)}
        onSubmit={async (name) => {
          await src.createFolder!(current!.id, name);
          toast.success(`Folder “${name}” ready in ${current!.name}`);
          refresh();
        }}
      />
      <NameDialog
        open={!!renaming}
        title={`Rename ${renaming?.kind === 'folder' ? 'folder' : 'file'}`}
        label="New name"
        initial={renaming?.name}
        submit="Rename"
        onClose={() => setRenaming(null)}
        onSubmit={async (name) => {
          await src.update!(renaming!.id, { name });
          toast.success('Renamed');
          refresh();
        }}
      />
      {connection && (
        <CloudFolderChooser
        connection={connection}
        open={!!moving}
        title={`Move “${moving?.name ?? ''}”`}
        submit="Move here"
        home={home}
        onClose={() => setMoving(null)}
        onChoose={async (folder) => {
          await src.update!(moving!.id, { parentId: folder.id });
          toast.success(`Moved to ${folder.name}`);
          refresh();
        }}
        />
      )}
    </div>
  );
}

/** A small dialog asking for one name (a new folder, a rename). */
function NameDialog({
  open,
  title,
  label,
  submit,
  initial = '',
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  label: string;
  submit: string;
  initial?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    if (open) {
      setName(initial);
      setFailure(undefined);
    }
  }, [open, initial]);
  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (error) {
      setFailure(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input label={label} value={name} autoFocus maxLength={200} onChange={(e) => setName(e.target.value)} error={failure} />
        <div className={styles.dialogActions}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={!name.trim()}>
            {submit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Choosing one folder of an account: where to move something, upload to, or share. */
export function CloudFolderChooser({
  connection,
  open,
  title,
  description,
  submit,
  home,
  requireEdit = true,
  onClose,
  onChoose,
}: {
  connection: CloudConnection;
  open: boolean;
  title: string;
  description?: string;
  submit: string;
  home?: CloudItem;
  /** Only a folder the person may change can be chosen (moving, uploading). */
  requireEdit?: boolean;
  onClose: () => void;
  onChoose: (folder: CloudItem) => Promise<void> | void;
}) {
  const [here, setHere] = useState<{ folder: CloudItem | null; canEdit: boolean }>({ folder: null, canEdit: false });
  const [saving, setSaving] = useState(false);
  const choose = async () => {
    if (!here.folder) return;
    setSaving(true);
    try {
      await onChoose(here.folder);
      onClose();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const usable = !!here.folder && (!requireEdit || here.canEdit);
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} maxWidth={760}>
      {open && (
        <CloudFileBrowser
          connection={connection}
          mode="folder"
          home={home}
          showTree={false}
          onLocationChange={(folder, canEdit) => setHere({ folder, canEdit })}
        />
      )}
      <div className={styles.dialogActions}>
        <span className={styles.note} style={{ marginRight: 'auto' }}>
          {here.folder ? (usable ? `Chosen: ${here.folder.name}` : 'You can’t add to this folder — open another.') : 'Open a folder to choose it.'}
        </span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void choose()} loading={saving} disabled={!usable}>
          {submit}
        </Button>
      </div>
    </Modal>
  );
}

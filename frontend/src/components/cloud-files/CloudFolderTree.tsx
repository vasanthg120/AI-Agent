import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { FiChevronRight, FiFolder, FiHardDrive, FiUsers } from 'react-icons/fi';
import { CLOUD_SHARED, type CloudItem } from '@/services/cloudFilesService';
import type { CloudSource } from './cloudSources';
import styles from './cloudFiles.module.css';

interface TreeProps {
  source: CloudSource;
  /** Where browsing starts: the account's starting points, or one folder (a customer's). */
  tops: CloudItem[];
  /** The folders from the top to where the browser is now. */
  trail: CloudItem[];
  onOpen: (trail: CloudItem[]) => void;
}

// The folders of an account as a tree beside the list: each one is read only when
// it is opened, so a large drive costs nothing until someone goes into it.
export function CloudFolderTree({ source, tops, trail, onOpen }: TreeProps) {
  return (
    <nav className={styles.tree} aria-label="Folders">
      {tops.map((top) => (
        <TreeNode key={top.id} source={source} folder={top} path={[top]} trail={trail} onOpen={onOpen} />
      ))}
    </nav>
  );
}

function TreeNode({ source, folder, path, trail, onOpen }: { source: CloudSource; folder: CloudItem; path: CloudItem[]; trail: CloudItem[]; onOpen: (trail: CloudItem[]) => void }) {
  // Open while the browser is inside it.
  const onTrail = trail.length >= path.length && path.every((p, i) => trail[i]?.id === p.id);
  const [expanded, setExpanded] = useState(onTrail);
  const open = expanded || (onTrail && trail.length > path.length);
  const active = onTrail && trail.length === path.length;
  const { data, isLoading } = useQuery({
    queryKey: ['cloud-files', source.key, 'tree', folder.id],
    queryFn: () => source.list(folder.id, { foldersOnly: true, sort: 'name' }),
    enabled: open,
    staleTime: 60_000,
  });
  const Icon = folder.root ? (folder.id === CLOUD_SHARED ? FiUsers : FiHardDrive) : FiFolder;
  return (
    <div>
      <div className={styles.treeNode}>
        <button
          type="button"
          className={clsx(styles.treeToggle, open && styles.treeToggleOpen)}
          aria-label={open ? `Close ${folder.name}` : `Open ${folder.name}`}
          aria-expanded={open}
          onClick={() => setExpanded(!open)}
        >
          <FiChevronRight />
        </button>
        <button type="button" className={clsx(styles.treeLabel, active && styles.treeActive)} aria-current={active ? 'true' : undefined} onClick={() => onOpen(path)}>
          <Icon aria-hidden />
          <span>{folder.name}</span>
        </button>
      </div>
      {open && (
        <div className={styles.treeChildren}>
          {isLoading ? (
            <span className={styles.treeEmpty}>Loading…</span>
          ) : (data?.items ?? []).length === 0 ? (
            <span className={styles.treeEmpty}>No folders</span>
          ) : (
            data!.items.map((child) => (
              <TreeNode key={child.id} source={source} folder={child} path={[...path, child]} trail={trail} onOpen={onOpen} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

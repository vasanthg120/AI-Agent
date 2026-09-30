import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiCheck, FiChevronDown, FiDatabase, FiLayers, FiSettings } from 'react-icons/fi';
import { POPUP_SPRING } from '@/components/ui/motionPresets';
import { ROUTES } from '@/constants/routes';
import { useDataSources } from '@/hooks/useDataSources';
import { pluralize } from '@/services/dataSourcesService';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import { timeAgo } from './timeAgo';
import styles from './DataSourceSwitcher.module.css';

// The top-bar control that says which CRM the numbers on screen come from —
// and lets people switch. Choosing a source (or the Unified View) switches
// the whole app, not just one page. Shown once there is a CRM to talk about.
export function DataSourceSwitcher() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const canManage = hasRole(user, 'owner') || hasRole(user, 'admin');
  const { data, selection, setSelection, selectionLabel } = useDataSources();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!data || data.sources.length === 0) return null;

  const choose = (next: string) => {
    setOpen(false);
    if (next !== selection) setSelection(next);
  };
  const defaultSource = data.sources.find((s) => s.isDefault);
  const unified = data.selection.mode === 'unified';

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        className={clsx(styles.trigger, unified && styles.triggerUnified)}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Where the CRM figures come from"
      >
        {unified ? <FiLayers aria-hidden /> : <FiDatabase aria-hidden />}
        <span className={styles.triggerText}>
          <span className={styles.triggerEyebrow}>Data source</span>
          <span className={styles.triggerLabel}>{selectionLabel}</span>
        </span>
        <FiChevronDown className={clsx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.menu}
            role="listbox"
            aria-label="Data source"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={POPUP_SPRING}
          >
            <div className={styles.menuHead}>Show data from</div>
            {data.sources.map((source) => {
              const selected = !unified && data.selection.sourceIds.includes(source.id);
              const value = source.isDefault ? 'default' : source.id;
              return (
                <button
                  key={source.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={clsx(styles.option, selected && styles.optionSelected)}
                  onClick={() => choose(value)}
                >
                  <span
                    className={clsx(styles.dot, source.status === 'active' ? styles.dotOn : styles.dotOff)}
                    aria-hidden
                  />
                  <span className={styles.optionText}>
                    <span className={styles.optionLabel}>
                      {source.label}
                      {source.isDefault && <span className={styles.tag}>Default</span>}
                    </span>
                    <span className={styles.optionMeta}>
                      {source.status === 'disconnected'
                        ? 'Disconnected — history only'
                        : source.native
                          ? `Created in HaiVE · ${source.recordCounts.deals} ${pluralize(source.terminology.deal).toLowerCase()}`
                          : source.sync.lastSyncAt
                            ? `Synced ${timeAgo(source.sync.lastSyncAt)} · ${source.recordCounts.deals} ${pluralize(source.terminology.deal).toLowerCase()}`
                            : 'Not synced yet'}
                    </span>
                  </span>
                  {selected && <FiCheck className={styles.check} aria-hidden />}
                </button>
              );
            })}

            {data.unifiedAvailable && (
              <>
                <div className={styles.separator} />
                <button
                  type="button"
                  role="option"
                  aria-selected={unified}
                  className={clsx(styles.option, unified && styles.optionSelected)}
                  onClick={() => choose('unified')}
                >
                  <FiLayers className={styles.optionIcon} aria-hidden />
                  <span className={styles.optionText}>
                    <span className={styles.optionLabel}>Unified view</span>
                    <span className={styles.optionMeta}>Every connected CRM together — duplicates counted once</span>
                  </span>
                  {unified && <FiCheck className={styles.check} aria-hidden />}
                </button>
              </>
            )}

            {data.emailSources.length > 0 && (
              <p className={styles.note}>
                Email figures always come from{' '}
                {data.emailSources.map((e) => `${e.label} (${e.mailboxes})`).join(' and ')}.
              </p>
            )}
            {!defaultSource && <p className={styles.note}>No default source is set.</p>}

            {canManage && (
              <button
                type="button"
                className={styles.manage}
                onClick={() => {
                  setOpen(false);
                  navigate(ROUTES.settingsDataSources);
                }}
              >
                <FiSettings aria-hidden /> Manage data sources
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

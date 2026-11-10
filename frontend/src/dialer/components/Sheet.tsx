import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import styles from './Sheet.module.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A panel that slides up from the bottom, within thumb's reach — the Dialer's
 * menus and choices. A real dialog: focus moves into it and stays there, Escape
 * or a tap outside closes it, and focus goes back where it came from.
 */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnTo?.focus?.();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className={styles.layer}>
          <m.div
            className={styles.backdrop}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <m.div
            ref={panelRef}
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
          >
            <span className={styles.grabber} aria-hidden />
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {children}
          </m.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/** One row of a sheet: an icon, a label, an optional line under it. */
export function SheetItem({
  icon,
  label,
  hint,
  onClick,
  href,
  selected,
  danger,
  checked,
  disabled,
}: {
  icon?: ReactNode;
  label: string;
  hint?: string;
  onClick?: () => void;
  href?: string;
  selected?: boolean;
  danger?: boolean;
  // Makes the row an on/off switch.
  checked?: boolean;
  disabled?: boolean;
}) {
  const body = (
    <>
      {icon && (
        <span className={styles.itemIcon} aria-hidden>
          {icon}
        </span>
      )}
      <span className={styles.itemText}>
        <span className={styles.itemLabel}>{label}</span>
        {hint && <span className={styles.itemHint}>{hint}</span>}
      </span>
      {checked !== undefined && <span className={`${styles.switch} ${checked ? styles.switchOn : ''}`} aria-hidden />}
    </>
  );
  const className = `${styles.item} ${danger ? styles.itemDanger : ''}`;
  if (href) {
    return (
      <a className={className} href={href}>
        {body}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      aria-current={selected || undefined}
      role={checked !== undefined ? 'switch' : undefined}
      aria-checked={checked}
    >
      {body}
    </button>
  );
}

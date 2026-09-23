import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { useClickOutside } from '@/hooks/useClickOutside';
import { POPUP_SPRING } from './motionPresets';
import styles from './Dropdown.module.css';

export interface DropdownItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface DropdownProps {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: 'left' | 'right';
  placement?: 'top' | 'bottom';
  // Renders the menu into document.body instead of as a normal positioned
  // descendant, placed from the trigger's live screen coordinates. Needed
  // when the trigger sits inside a narrow or clipping ancestor — e.g. the
  // collapsed sidebar's icon rail, inside AppLayout's `.shell {overflow:
  // hidden}` — where a normally-positioned menu gets visually clipped
  // instead of overlaying the rest of the page. Every other call site is
  // unaffected: this defaults to false, preserving the original
  // position:absolute-within-wrapper behavior exactly.
  usePortal?: boolean;
  // Applied to the wrapper div alongside styles.wrapper — e.g. Sidebar's
  // account menu needs display:block instead of the default inline-flex so
  // its full-width trigger button actually spans the sidebar.
  className?: string;
}

interface PortalPosition {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export function Dropdown({ trigger, items, align = 'left', placement = 'bottom', usePortal = false, className }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [portalPos, setPortalPos] = useState<PortalPosition | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useClickOutside(wrapperRef, () => setOpen(false), open && !usePortal);

  // Portal mode has its own click-outside check (below) since the menu is
  // no longer a DOM descendant of wrapperRef once it's portaled — the
  // default useClickOutside above would treat every click inside it as
  // "outside" and close the menu before onSelect ever fires.
  useEffect(() => {
    if (!open || !usePortal) return;
    const listener = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapperRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', listener);
    return () => document.removeEventListener('mousedown', listener);
  }, [open, usePortal]);

  useEffect(() => {
    if (!open || !usePortal || !wrapperRef.current) return;
    const updatePosition = () => {
      const rect = wrapperRef.current!.getBoundingClientRect();
      setPortalPos({
        left: align === 'left' ? rect.left : undefined,
        right: align === 'right' ? window.innerWidth - rect.right : undefined,
        top: placement === 'bottom' ? rect.bottom + 6 : undefined,
        bottom: placement === 'top' ? window.innerHeight - rect.top + 6 : undefined,
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, usePortal, align, placement]);

  const yOffset = placement === 'top' ? 6 : -6;

  const menuContent = (
    <motion.div
      ref={menuRef}
      role="menu"
      className={clsx(
        styles.menu,
        usePortal
          ? styles.menuPortal
          : [align === 'right' ? styles.alignRight : styles.alignLeft, placement === 'top' && styles.placementTop],
      )}
      style={usePortal && portalPos ? portalPos : undefined}
      initial={{ opacity: 0, y: yOffset, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: yOffset, scale: 0.98 }}
      transition={POPUP_SPRING}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore && <div className={styles.separator} />}
          <button
            type="button"
            role="menuitem"
            className={clsx(styles.item, item.danger && styles.itemDanger)}
            onClick={() => {
              item.onSelect();
              setOpen(false);
            }}
          >
            {item.icon}
            {item.label}
          </button>
        </div>
      ))}
    </motion.div>
  );

  return (
    <div className={clsx(styles.wrapper, className)} ref={wrapperRef}>
      <span onClick={() => setOpen((prev) => !prev)}>{trigger}</span>
      <AnimatePresence>
        {open && (usePortal ? (portalPos ? createPortal(menuContent, document.body) : null) : menuContent)}
      </AnimatePresence>
    </div>
  );
}

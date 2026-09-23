import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { FiX } from 'react-icons/fi';
import { IconButton } from './IconButton';
import { BACKDROP_FADE, SURFACE_SPRING } from './motionPresets';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  maxWidth?: number;
}

export function Modal({ open, onClose, title, description, children, maxWidth }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Keeps the page behind the modal from scrolling while it's open — without
  // this the backdrop covers the page but the page underneath can still
  // scroll/jump, which reads as janky against an otherwise smooth overlay.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={styles.backdrop}
          // pointerEvents toggles instantly at each end of the fade (Framer
          // Motion applies non-numeric values immediately rather than
          // interpolating them) — without this, the backdrop stays
          // clickable for the full 150ms exit fade, so a click on whatever
          // was underneath (e.g. a "Manage" button on a row that just
          // became visible) can land on the closing backdrop instead and
          // silently do nothing until the user tries again or reloads.
          initial={{ opacity: 0, backdropFilter: 'blur(0px)', pointerEvents: 'none' }}
          animate={{ opacity: 1, backdropFilter: 'blur(4px)', pointerEvents: 'auto' }}
          exit={{ opacity: 0, backdropFilter: 'blur(0px)', pointerEvents: 'none' }}
          transition={BACKDROP_FADE}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? 'modal-title' : undefined}
            className={styles.modal}
            style={maxWidth ? ({ '--modal-max-width': `${maxWidth}px` } as React.CSSProperties) : undefined}
            initial={{ opacity: 0, scale: 0.93, y: 18, pointerEvents: 'none' }}
            animate={{ opacity: 1, scale: 1, y: 0, pointerEvents: 'auto' }}
            exit={{ opacity: 0, scale: 0.96, y: 10, pointerEvents: 'none' }}
            transition={SURFACE_SPRING}
            onClick={(event) => event.stopPropagation()}
          >
            {(title || description) && (
              <div className={styles.header}>
                <div>
                  {title && (
                    <h2 id="modal-title" className={styles.title}>
                      {title}
                    </h2>
                  )}
                  {description && <p className={styles.description}>{description}</p>}
                </div>
                <IconButton icon={<FiX />} label="Close" onClick={onClose} />
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

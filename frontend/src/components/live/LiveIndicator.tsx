import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { FiZap } from 'react-icons/fi';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { LiveData } from '@/hooks/useLiveData';
import type { LiveSource } from '@/services/liveDataService';
import { timeAgo } from '@/components/data-sources/timeAgo';
import styles from './LiveIndicator.module.css';

/** "10:42 AM" today, "24 Nov, 7:05 PM" before. */
export function clockOf(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const at = dayjs(iso);
  return at.isSame(dayjs(), 'day') ? at.format('h:mm A') : at.format('D MMM, h:mm A');
}

const names = (sources: LiveSource[]) => [...new Set(sources.map((s) => s.label))].join(', ');

export interface LiveIndicatorProps {
  live: LiveData;
  /** Show the business of each source (all-businesses views). */
  showBusiness?: boolean;
  /** Where the popover opens from. */
  align?: 'left' | 'right';
  /** The mailbox only (the AI Email Inbox): no CRM lines. */
  mailboxOnly?: boolean;
}

/**
 * Where the page's data comes from and how fresh it is: "Live · as of 10:42 AM" for CRMs
 * read when the page opened, "Hoops · nightly" for one read once a night, the mailbox, and
 * what the AI is still reading. Click for each source in detail.
 */
export function LiveIndicator({ live, showBusiness = false, align = 'left', mailboxOnly = false }: LiveIndicatorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const status = live.status;
  if (!status) {
    return (
      <span className={styles.pill} data-state="checking">
        <span className={styles.dot} aria-hidden /> Live · checking…
      </span>
    );
  }
  const sources = mailboxOnly ? [] : status.sources;
  const liveSources = sources.filter((s) => s.mode === 'live');
  const nightly = sources.filter((s) => s.mode === 'nightly');
  const mailbox = status.mailbox?.connected ? status.mailbox : undefined;
  if (liveSources.length === 0 && nightly.length === 0 && !mailbox) return null;

  const reading = liveSources.filter((s) => s.refreshing);
  const failing = liveSources.filter((s) => s.error && !s.refreshing);
  // The oldest read among the live sources: every one of them is at least this fresh.
  const asOf = liveSources
    .map((s) => s.lastSyncAt)
    .filter((x): x is string => !!x)
    .sort()[0];

  let liveText: string | null = null;
  let liveState: 'ok' | 'reading' | 'failing' = 'ok';
  if (reading.length > 0) {
    liveText = `Updating from ${names(reading)}…`;
    liveState = 'reading';
  } else if (failing.length > 0) {
    liveText = `${names(failing)} couldn’t be read · showing ${clockOf(failing[0].lastSyncAt)}`;
    liveState = 'failing';
  } else if (liveSources.length > 0) {
    liveText = `Live · as of ${clockOf(asOf ?? status.checkedAt)}`;
  }
  const mailText = mailbox ? (mailbox.fetching ? 'Checking Outlook…' : `Outlook · as of ${clockOf(mailbox.lastFetchedAt)}`) : null;
  const aiText = mailbox?.aiReading
    ? `AI reading ${mailbox.awaitingAi > 0 ? `${mailbox.awaitingAi} new` : 'new mail'}…`
    : mailbox && mailbox.awaitingAi > 0
      ? `${mailbox.awaitingAi} not read by AI yet`
      : null;

  return (
    <div className={styles.wrapper} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-label="Where this page’s data comes from"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {liveText && (
          <span className={styles.pill} data-state={liveState} title={liveText}>
            <span className={styles.dot} aria-hidden />
            <span className={styles.text}>{liveText}</span>
          </span>
        )}
        {mailText && (
          <span className={styles.pill} data-state={mailbox?.fetching ? 'reading' : 'ok'} title={mailText}>
            <span className={styles.dot} aria-hidden />
            <span className={styles.text}>{mailText}</span>
          </span>
        )}
        {nightly.length > 0 && (
          <span className={styles.pill} data-state="nightly" title={`${names(nightly)}: read once a night`}>
            <span className={styles.dot} aria-hidden />
            <span className={styles.text}>
              {names(nightly)} · nightly{nightly[0].lastSyncAt ? ` · ${clockOf(nightly[0].lastSyncAt)}` : ''}
            </span>
          </span>
        )}
        {aiText && (
          <span className={styles.pill} data-state="ai" title={aiText}>
            <FiZap size={11} aria-hidden />
            <span className={styles.text}>{aiText}</span>
          </span>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Data sources"
            className={clsx(styles.panel, styles[align])}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.16 }}
          >
            <div className={styles.panelTitle}>Where this comes from</div>
            <ul className={styles.list}>
              {sources.map((s) => (
                <li key={s.id} className={styles.row}>
                  <span className={styles.dot} data-state={s.refreshing ? 'reading' : s.error ? 'failing' : s.mode === 'nightly' ? 'nightly' : 'ok'} aria-hidden />
                  <div className={styles.rowBody}>
                    <div className={styles.rowName}>
                      {s.label}
                      {showBusiness && s.businessName ? <span className={styles.business}> · {s.businessName}</span> : null}
                    </div>
                    <div className={styles.rowMeta}>
                      {s.refreshing
                        ? 'Being read now — only what changed'
                        : s.mode === 'nightly'
                          ? `Read once a night (its rule) · last ${s.lastSyncAt ? timeAgo(s.lastSyncAt) : 'never'}${s.nextNightlyAt ? ` · next ${clockOf(s.nextNightlyAt)}` : ''}`
                          : `Live · read ${timeAgo(s.lastSyncAt ?? undefined)}`}
                    </div>
                    {s.error && !s.refreshing && <div className={styles.rowError}>{s.error}</div>}
                  </div>
                </li>
              ))}
              {mailbox && (
                <li className={styles.row}>
                  <span className={styles.dot} data-state={mailbox.fetching ? 'reading' : 'ok'} aria-hidden />
                  <div className={styles.rowBody}>
                    <div className={styles.rowName}>Outlook mailbox</div>
                    <div className={styles.rowMeta}>
                      {mailbox.fetching ? 'Checking for new mail now' : `New mail and replies checked ${timeAgo(mailbox.lastFetchedAt ?? undefined)}`}
                    </div>
                  </div>
                </li>
              )}
            </ul>
            <p className={styles.note}>
              {mailboxOnly
                ? 'The mailbox is asked for new mail and replies when you open this page, and every minute while it is open.'
                : 'Live sources are asked for what changed each time you open this page.'}
              {nightly.length > 0 ? ` ${names(nightly)} allows one read a night, so it is read after 7pm AEST.` : ''} Anything marked <span className={styles.aiInline}><FiZap size={10} /> AI</span> is
              written by the AI from these records, not taken from the source.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

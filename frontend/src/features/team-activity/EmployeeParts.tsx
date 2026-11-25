import type { ReactNode } from 'react';
import type { IconType } from 'react-icons';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { FiArrowDownRight, FiArrowUpRight, FiMinus } from 'react-icons/fi';
import { Badge } from '@/components/ui';
import { formatTalkTime, type ConnectedApp, type SourceFreshness } from '@/services/teamActivityService';
import { activityStatus } from './status';
import styles from './EmployeeActivity.module.css';

// ---- KPI cards -------------------------------------------------------------------------------

export interface KpiCardDef {
  key: string;
  label: string;
  icon: IconType;
  value: string;
  // One line of context under the number.
  context?: string;
  // Change from the period before, in percent (null: nothing to compare with).
  change?: number | null;
  // Which way is good: more deals is, more missed emails isn't.
  goodWhen?: 'up' | 'down';
  tone?: 'warning' | 'danger';
  title?: string;
  onClick?: () => void;
}

function Delta({ change, goodWhen = 'up', against }: { change: number; goodWhen?: 'up' | 'down'; against: string }) {
  const flat = change === 0;
  const good = flat ? null : change > 0 === (goodWhen === 'up');
  const Icon = flat ? FiMinus : change > 0 ? FiArrowUpRight : FiArrowDownRight;
  return (
    <span className={clsx(styles.delta, flat ? styles.deltaFlat : good ? styles.deltaGood : styles.deltaBad)} title={`Compared with ${against}`}>
      <Icon aria-hidden />
      {flat ? 'same' : `${Math.abs(change)}%`}
      <span className={styles.srOnly}>{` compared with ${against}`}</span>
    </span>
  );
}

/** The headline figures: a number, a line of context, and how it moved since the period before. A card opens its detail. */
export function KpiCards({ cards, against }: { cards: KpiCardDef[]; against?: string }) {
  return (
    <div className={styles.kpiGrid}>
      {cards.map((card, i) => {
        const Icon = card.icon;
        const content = (
          <>
            <span className={styles.kpiHead}>
              <span className={styles.kpiIcon} aria-hidden>
                <Icon />
              </span>
              <span>{card.label}</span>
            </span>
            <span className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>{card.value}</span>
              {against && card.change !== undefined && card.change !== null && <Delta change={card.change} goodWhen={card.goodWhen} against={against} />}
            </span>
            <span className={styles.kpiContext}>{card.context ?? ' '}</span>
          </>
        );
        const motionProps = {
          initial: { opacity: 0, y: 6 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.25, delay: Math.min(i, 8) * 0.03, ease: [0.16, 1, 0.3, 1] as const },
        };
        return card.onClick ? (
          <motion.button
            key={card.key}
            type="button"
            className={clsx(styles.kpiCard, card.tone && styles[`kpiCard_${card.tone}`])}
            onClick={card.onClick}
            title={card.title}
            {...motionProps}
          >
            {content}
          </motion.button>
        ) : (
          <motion.div key={card.key} className={clsx(styles.kpiCard, styles.kpiCardStatic, card.tone && styles[`kpiCard_${card.tone}`])} title={card.title} {...motionProps}>
            {content}
          </motion.div>
        );
      })}
    </div>
  );
}

// ---- share bars ------------------------------------------------------------------------------

export interface ShareRow {
  key: string;
  label: ReactNode;
  value: number;
  color: string;
  // What the number reads as ("3h 05m", "₹1.2L").
  display: string;
  // A word after it ("42%", "4 days").
  extra?: string;
}

/** Bars side by side for comparing amounts — parts of the app, or people — each with its number written out. */
export function ShareBars({ rows, onSelect, ariaLabel }: { rows: ShareRow[]; onSelect?: (key: string) => void; ariaLabel: string }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <ul className={styles.shareList} aria-label={ariaLabel}>
      {rows.map((row) => {
        const inner = (
          <span className={styles.shareRow}>
            <span className={styles.shareLabel}>
              <span className={styles.legendSwatch} style={{ background: row.color }} aria-hidden />
              <span>{row.label}</span>
            </span>
            <span className={styles.shareTrack} aria-hidden>
              <span className={styles.shareFill} style={{ width: `${max > 0 ? Math.max(1.5, (row.value / max) * 100) : 0}%`, background: row.color, display: 'block' }} />
            </span>
            <span className={styles.shareValue}>
              {row.display}
              {row.extra && <small>{row.extra}</small>}
            </span>
          </span>
        );
        return (
          <li key={row.key}>
            {onSelect ? (
              <button type="button" className={styles.shareRowButton} onClick={() => onSelect(row.key)}>
                {inner}
              </button>
            ) : (
              inner
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---- freshness -------------------------------------------------------------------------------

const MODE_WORDS: Record<SourceFreshness['mode'], string> = {
  real_time: 'live',
  on_open: 'read when opened',
  nightly: 'read nightly',
};

/**
 * Where the figures come from and how fresh each source is: calls and app time are
 * recorded as they happen (live), Outlook and most CRMs are read when a page is
 * opened, Hoops once a night — and the figures themselves were worked out at a time.
 */
export function FreshnessLine({ sources, generatedAt }: { sources: SourceFreshness[]; generatedAt?: string }) {
  // One entry per source across businesses: the stalest time and the worst state.
  const rank = { failing: 0, never: 1, not_connected: 2, ok: 3 } as const;
  const merged = new Map<string, SourceFreshness>();
  for (const s of sources) {
    const key = s.key.startsWith('crm:') ? `crm:${s.label}` : s.key;
    const seen = merged.get(key);
    if (!seen) merged.set(key, s);
    else {
      const worse = rank[s.status] < rank[seen.status] ? s : seen;
      const oldest = [seen.lastSuccessAt, s.lastSuccessAt].filter(Boolean).sort()[0];
      merged.set(key, { ...worse, lastSuccessAt: oldest });
    }
  }
  const items = [...merged.values()].filter((s) => s.key !== 'usage');
  const when = (iso?: string) => (iso ? (dayjs(iso).isSame(dayjs(), 'day') ? dayjs(iso).format('h:mm a') : dayjs(iso).format('D MMM, h:mm a')) : undefined);
  return (
    <div className={styles.freshness}>
      {generatedAt && <span className={styles.freshItem}>Figures as of {dayjs(generatedAt).format('h:mm a')} · refreshed every minute</span>}
      {items.map((s) => {
        const text =
          s.key === 'calls'
            ? 'Calls & app time: live'
            : s.status === 'not_connected'
              ? `${s.label}: not connected`
              : s.status === 'failing'
                ? `${s.label}: not updating${s.lastSuccessAt ? ` — last read ${when(s.lastSuccessAt)}` : ''}`
                : s.status === 'never'
                  ? `${s.label}: not read yet`
                  : `${s.label}: ${MODE_WORDS[s.mode]}${s.lastSuccessAt ? ` · ${when(s.lastSuccessAt)}` : ''}`;
        return (
          <span key={`${s.key}-${s.label}`} className={styles.freshItem} title={s.mode === 'nightly' ? 'Read once a night, as the CRM’s own rules ask.' : undefined}>
            <span className={clsx(styles.freshDot, styles[`fresh_${s.status}`])} aria-hidden />
            {text}
          </span>
        );
      })}
    </div>
  );
}

// ---- connected apps --------------------------------------------------------------------------

const MEASURE_BADGE: Record<ConnectedApp['measure'], { text: string; variant: 'success' | 'info' | 'neutral' }> = {
  time: { text: 'Time measured', variant: 'success' },
  activity: { text: 'Activity only', variant: 'info' },
  none: { text: 'Not measured', variant: 'neutral' },
};

/** Every app people work in, and what can honestly be said about each: time, what was done, or nothing. */
export function ConnectedApps({ apps }: { apps: ConnectedApp[] }) {
  return (
    <div className={styles.appsGrid}>
      {apps.map((app) => {
        const badge = !app.connected && app.measure !== 'time' ? { text: 'Not connected', variant: 'neutral' as const } : MEASURE_BADGE[app.measure];
        const muted = !app.connected || app.measure === 'none';
        return (
          <div key={app.key} className={clsx(styles.appCard, muted && styles.appCardMuted)}>
            <div className={styles.appHead}>
              <span className={styles.appName}>{app.label}</span>
              <Badge variant={badge.variant}>{badge.text}</Badge>
            </div>
            {app.measure === 'time' && <span className={styles.appTime}>{formatTalkTime(app.seconds ?? 0)}</span>}
            {app.activity.length > 0 && (
              <ul className={styles.appStats}>
                {app.activity.map((a) => (
                  <li key={a.label}>
                    <span>{a.label}</span>
                    <strong>{a.count}</strong>
                  </li>
                ))}
              </ul>
            )}
            <span className={styles.appNote}>{app.note}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---- status ----------------------------------------------------------------------------------

/** "● Active now" / "● Active 2h ago" / "No app time yet". */
export function StatusLabel({ lastActiveAt }: { lastActiveAt?: string }) {
  const status = activityStatus(lastActiveAt);
  return (
    <span className={styles.statusLine}>
      <span className={clsx(styles.statusDot, styles[`status_${status.tone}`])} aria-hidden />
      {status.label}
    </span>
  );
}

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiAlertTriangle,
  FiBell,
  FiCheck,
  FiCheckCircle,
  FiChevronRight,
  FiClock,
  FiInfo,
  FiLink2,
  FiSettings,
  FiXCircle,
} from 'react-icons/fi';
import { Badge, Button, EmptyState, Modal, PageHeader, Skeleton } from '@/components/ui';
import { useNotificationsStore } from '@/stores/notificationsStore';
import { dayjs, formatFullDate, formatRelativeTime } from '@/utils/date';
import { ROUTES } from '@/constants/routes';
import { resolveNotificationTarget } from '@/utils/notificationTarget';
import type { AppNotification, NotificationKind } from '@/services/mock/fixtures/notifications';
import styles from './NotificationsPage.module.css';

const KIND_META: Record<NotificationKind, { icon: ReactElement; tone: string; label: string }> = {
  system: { icon: <FiInfo />, tone: styles.toneInfo, label: 'System' },
  integration: { icon: <FiLink2 />, tone: styles.toneAccent, label: 'Integration' },
  warning: { icon: <FiAlertTriangle />, tone: styles.toneWarning, label: 'Warning' },
  error: { icon: <FiXCircle />, tone: styles.toneDanger, label: 'Error' },
  sla_breach: { icon: <FiClock />, tone: styles.toneDanger, label: 'SLA breach' },
};

const KIND_BADGE_VARIANT: Record<NotificationKind, 'info' | 'accent' | 'warning' | 'danger'> = {
  system: 'info',
  integration: 'accent',
  warning: 'warning',
  error: 'danger',
  sla_breach: 'danger',
};

const KIND_ORDER: NotificationKind[] = ['sla_breach', 'error', 'warning', 'integration', 'system'];

// "workflow:crm_follow_up_check" -> "crm follow up check" — python-agent's
// own workflow engine (todo_agent/eod_agent/crm_follow_up_check/
// summarize_document, see python-agent/app/workflows/definitions.py) still
// creates real notifications with this source shape; unrelated to the
// removed NestJS Workflow Automation settings page.
function formatSource(source: string): string {
  const name = source.startsWith('workflow:') ? source.slice('workflow:'.length) : source;
  return name.replace(/[_-]+/g, ' ');
}

function dayGroup(iso: string): string {
  const d = dayjs(iso);
  if (d.isToday()) return 'Today';
  if (d.isYesterday()) return 'Yesterday';
  if (d.isAfter(dayjs().subtract(7, 'day'))) return 'Earlier this week';
  return 'Older';
}
const GROUP_ORDER = ['Today', 'Yesterday', 'Earlier this week', 'Older'];

export function NotificationsPage() {
  const navigate = useNavigate();
  const notifications = useNotificationsStore((state) => state.notifications);
  const loaded = useNotificationsStore((state) => state.loaded);
  const markRead = useNotificationsStore((state) => state.markRead);
  const markAllRead = useNotificationsStore((state) => state.markAllRead);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [kind, setKind] = useState<'all' | NotificationKind>('all');
  const [selected, setSelected] = useState<AppNotification | null>(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

  // Kind chips only for kinds that actually have notifications, with counts.
  const kindCounts = useMemo(() => {
    const base = unreadOnly ? notifications.filter((n) => !n.read) : notifications;
    const map = new Map<NotificationKind, number>();
    for (const n of base) map.set(n.kind, (map.get(n.kind) ?? 0) + 1);
    return KIND_ORDER.filter((k) => map.has(k)).map((k) => [k, map.get(k)!] as const);
  }, [notifications, unreadOnly]);

  const filtered = notifications.filter((n) => (!unreadOnly || !n.read) && (kind === 'all' || n.kind === kind));

  const groups = useMemo(() => {
    const map = new Map<string, AppNotification[]>();
    for (const n of filtered) map.set(dayGroup(n.timestamp), [...(map.get(dayGroup(n.timestamp)) ?? []), n]);
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [filtered]);

  // If this notification is about one specific record (entityType +
  // entityId set — see backend/src/notifications/schemas/notification.schema.ts),
  // jump straight there instead of showing the local detail panel — the
  // user should never have to go find it themselves. Anything without a
  // resolvable target falls back to the detail panel.
  const openNotification = (notification: AppNotification) => {
    if (!notification.read) markRead(notification.id);
    const target = resolveNotificationTarget(notification);
    if (target) {
      navigate(target);
      return;
    }
    setSelected(notification);
  };

  const selectedMeta = selected ? KIND_META[selected.kind] : null;

  return (
    <div className={styles.page}>
      <PageHeader
        icon={FiBell}
        title="Notifications"
        subtitle="Alerts from your AI agents, integrations and SLA tracking. Click one to jump straight to what it's about."
        meta={
          unreadCount > 0 ? (
            <span className={styles.unreadChip}>
              <span className={styles.unreadChipDot} /> {unreadCount} unread
            </span>
          ) : undefined
        }
        actions={
          <>
            <Button variant="ghost" size="sm" leftIcon={<FiSettings />} onClick={() => navigate(ROUTES.settingsNotifications)}>
              Preferences
            </Button>
            <Button variant="outline" size="sm" leftIcon={<FiCheck />} disabled={unreadCount === 0} onClick={markAllRead}>
              Mark all as read
            </Button>
          </>
        }
      />

      <div className={styles.toolbar}>
        <LayoutGroup id="notif-read-filter">
          <div className={styles.segmented} role="radiogroup" aria-label="Show">
            {[
              { id: false, label: 'All' },
              { id: true, label: `Unread${unreadCount ? ` (${unreadCount})` : ''}` },
            ].map((opt) => (
              <button
                key={String(opt.id)}
                type="button"
                role="radio"
                aria-checked={unreadOnly === opt.id}
                className={clsx(styles.segment, unreadOnly === opt.id && styles.segmentActive)}
                onClick={() => setUnreadOnly(opt.id)}
              >
                {unreadOnly === opt.id && (
                  <motion.span layoutId="notif-thumb" className={styles.segmentThumb} transition={{ type: 'spring', stiffness: 460, damping: 36 }} />
                )}
                <span className={styles.segmentText}>{opt.label}</span>
              </button>
            ))}
          </div>
        </LayoutGroup>

        {kindCounts.length > 1 && (
          <div className={styles.kinds}>
            <button type="button" className={clsx(styles.kindChip, kind === 'all' && styles.kindChipActive)} onClick={() => setKind('all')}>
              All types
            </button>
            {kindCounts.map(([k, count]) => (
              <button
                key={k}
                type="button"
                className={clsx(styles.kindChip, KIND_META[k].tone, kind === k && styles.kindChipActive)}
                onClick={() => setKind(kind === k ? 'all' : k)}
              >
                <span className={styles.kindIcon}>{KIND_META[k].icon}</span>
                {KIND_META[k].label}
                <span className={styles.kindCount}>{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!loaded ? (
        <div className={styles.list}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={styles.skeletonRow}>
              <Skeleton width={40} height={40} />
              <div className={styles.skeletonText}>
                <Skeleton height={14} width="50%" />
                <Skeleton height={12} width="80%" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyCard}>
          {notifications.length === 0 ? (
            <EmptyState icon={FiBell} title="No notifications yet" description="Alerts from your AI agents, integrations and SLA tracking will appear here." />
          ) : unreadOnly && kind === 'all' ? (
            <EmptyState icon={FiCheckCircle} title="You're all caught up" description="Nothing unread. New alerts show up here the moment they arrive." />
          ) : (
            <EmptyState icon={FiBell} title="Nothing here" description="No notifications match this filter." />
          )}
        </div>
      ) : (
        groups.map(([group, items]) => (
          <section key={group} className={styles.group}>
            <div className={styles.groupLabel}>
              {group}
              <span className={styles.groupCount}>{items.length}</span>
            </div>
            <div className={styles.list}>
              <AnimatePresence initial={false}>
                {items.map((n) => {
                  const meta = KIND_META[n.kind];
                  const hasTarget = !!resolveNotificationTarget(n);
                  return (
                    <motion.div
                      key={n.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className={clsx(styles.item, !n.read && styles.itemUnread)}
                    >
                      <button type="button" className={styles.itemMain} onClick={() => openNotification(n)}>
                        <span className={clsx(styles.iconTile, meta.tone)}>{meta.icon}</span>
                        <span className={styles.textCol}>
                          <span className={styles.itemTitle}>{n.title}</span>
                          <span className={styles.itemDescription}>{n.description}</span>
                          <span className={styles.itemMeta}>
                            <time dateTime={n.timestamp} title={formatFullDate(n.timestamp)}>
                              {formatRelativeTime(n.timestamp)}
                            </time>
                            {n.source && <span className={styles.source}>{formatSource(n.source)}</span>}
                            {hasTarget && <span className={styles.opens}>Opens the record</span>}
                          </span>
                        </span>
                        {hasTarget && <FiChevronRight className={styles.chevron} aria-hidden />}
                      </button>
                      {!n.read && (
                        <button
                          type="button"
                          className={styles.markRead}
                          onClick={() => markRead(n.id)}
                          title="Mark as read"
                          aria-label={`Mark "${n.title}" as read`}
                        >
                          <span className={styles.unreadDot} />
                          <FiCheck className={styles.markReadIcon} />
                        </button>
                      )}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </section>
        ))
      )}

      {selected && selectedMeta && (
        <Modal open onClose={() => setSelected(null)} title="Notification">
          <div className={styles.detailHead}>
            <span className={clsx(styles.iconTile, styles.iconTileLarge, selectedMeta.tone)}>{selectedMeta.icon}</span>
            <div className={styles.detailTitleCol}>
              <div className={styles.detailTitle}>{selected.title}</div>
              <Badge variant={KIND_BADGE_VARIANT[selected.kind]}>{selectedMeta.label}</Badge>
            </div>
          </div>
          <p className={styles.detailBody}>{selected.description}</p>
          <div className={styles.detailMeta}>
            <span>{formatFullDate(selected.timestamp)}</span>
            {selected.source && <span>Triggered by: {formatSource(selected.source)}</span>}
          </div>
          <div className={styles.detailActions}>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Close
            </Button>
            {selected.kind === 'integration' && (
              <Button
                onClick={() => {
                  setSelected(null);
                  navigate(ROUTES.settingsIntegrations);
                }}
              >
                View Integrations
              </Button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

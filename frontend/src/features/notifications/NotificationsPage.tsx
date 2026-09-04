import { useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { FiInfo, FiAlertTriangle, FiXCircle, FiLink2, FiClock } from 'react-icons/fi';
import { Card, Button, Badge, Modal } from '@/components/ui';
import { useNotificationsStore } from '@/stores/notificationsStore';
import { formatRelativeTime, formatFullDate } from '@/utils/date';
import { ROUTES } from '@/constants/routes';
import { resolveNotificationTarget } from '@/utils/notificationTarget';
import type { AppNotification, NotificationKind } from '@/services/mock/fixtures/notifications';
import styles from './NotificationsPage.module.css';

const KIND_META: Record<NotificationKind, { icon: ReactElement; color: string; bg: string; label: string }> = {
  system: { icon: <FiInfo />, color: 'var(--color-info)', bg: 'rgba(96, 165, 250, 0.14)', label: 'System' },
  integration: { icon: <FiLink2 />, color: 'var(--color-accent)', bg: 'var(--color-accent-muted)', label: 'Integration' },
  warning: { icon: <FiAlertTriangle />, color: 'var(--color-warning)', bg: 'rgba(251, 191, 36, 0.14)', label: 'Warning' },
  error: { icon: <FiXCircle />, color: 'var(--color-danger)', bg: 'rgba(248, 113, 113, 0.14)', label: 'Error' },
  sla_breach: { icon: <FiClock />, color: 'var(--color-danger)', bg: 'rgba(248, 113, 113, 0.14)', label: 'SLA Breach' },
};

const KIND_BADGE_VARIANT: Record<NotificationKind, 'info' | 'accent' | 'warning' | 'danger'> = {
  system: 'info',
  integration: 'accent',
  warning: 'warning',
  error: 'danger',
  sla_breach: 'danger',
};

const FILTERS: { id: 'all' | NotificationKind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'system', label: 'System' },
  { id: 'integration', label: 'Integrations' },
  { id: 'warning', label: 'Warnings' },
  { id: 'error', label: 'Errors' },
  { id: 'sla_breach', label: 'SLA Breaches' },
];

// "workflow:crm_follow_up_check" -> "crm follow up check" — python-agent's
// own workflow engine (todo_agent/eod_agent/crm_follow_up_check/
// summarize_document, see python-agent/app/workflows/definitions.py) still
// creates real notifications with this source shape; unrelated to the
// removed NestJS Workflow Automation settings page.
function formatSource(source: string): string {
  const name = source.startsWith('workflow:') ? source.slice('workflow:'.length) : source;
  return name.replace(/[_-]+/g, ' ');
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const notifications = useNotificationsStore((state) => state.notifications);
  const markRead = useNotificationsStore((state) => state.markRead);
  const markAllRead = useNotificationsStore((state) => state.markAllRead);
  const [filter, setFilter] = useState<'all' | NotificationKind>('all');
  const [selected, setSelected] = useState<AppNotification | null>(null);

  const filtered = filter === 'all' ? notifications : notifications.filter((n) => n.kind === filter);

  // If this notification is about one specific record (entityType +
  // entityId set — see backend/src/notifications/schemas/notification.schema.ts),
  // jump straight there instead of showing the local detail panel — the
  // user should never have to go find it themselves. Anything without a
  // resolvable target (e.g. "Achievement unlocked", or an older
  // notification written before entityType existed) falls back to the
  // detail panel exactly as before this feature existed.
  const openNotification = (notification: AppNotification) => {
    markRead(notification.id);
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
      <div className={styles.header}>
        <div className={styles.title}>Notifications</div>
        <Button variant="ghost" size="sm" onClick={markAllRead}>
          Mark all as read
        </Button>
      </div>

      <div className={styles.filterRow}>
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={clsx(styles.chip, filter === f.id && styles.chipActive)} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {filtered.map((notification) => {
          const meta = KIND_META[notification.kind];
          return (
            <div
              key={notification.id}
              className={styles.item}
              onClick={() => openNotification(notification)}
              style={{ cursor: 'pointer' }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') openNotification(notification);
              }}
            >
              <span className={styles.iconTile} style={{ color: meta.color, background: meta.bg }}>
                {meta.icon}
              </span>
              <div className={styles.textCol}>
                <div className={styles.itemTitle}>{notification.title}</div>
                <div className={styles.itemDescription}>{notification.description}</div>
                <div className={styles.itemTime}>{formatRelativeTime(notification.timestamp)}</div>
              </div>
              {!notification.read && <span className={styles.unreadDot} />}
            </div>
          );
        })}
      </Card>

      {selected && selectedMeta && (
        <Modal open onClose={() => setSelected(null)} title="Notification">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
            <span className={styles.iconTile} style={{ color: selectedMeta.color, background: selectedMeta.bg, width: 44, height: 44 }}>
              {selectedMeta.icon}
            </span>
            <div style={{ flex: 1 }}>
              <div className={styles.itemTitle} style={{ fontSize: 'var(--text-md)' }}>
                {selected.title}
              </div>
              <Badge variant={KIND_BADGE_VARIANT[selected.kind]}>{selectedMeta.label}</Badge>
            </div>
          </div>

          <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 'var(--space-4)' }}>
            {selected.description}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginBottom: 'var(--space-5)' }}>
            <div className={styles.itemTime}>{formatFullDate(selected.timestamp)}</div>
            {selected.source && <div className={styles.itemTime}>Triggered by: {formatSource(selected.source)}</div>}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
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

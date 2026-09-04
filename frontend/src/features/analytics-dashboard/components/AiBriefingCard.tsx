import { FiZap, FiTrendingDown, FiClock, FiActivity, FiCheckCircle, FiChevronRight } from 'react-icons/fi';
import type { IconType } from 'react-icons';
import { formatRelativeTime } from '@/utils/date';
import type { AiInsightItem } from '@/services/analyticsDashboardService';
import styles from './AiBriefingCard.module.css';

// Every real message from buildInsights() (backend analytics-dashboard.service.ts)
// is written as "<headline> — <recommendation>" — split on that em dash so the
// headline reads as a bold title and the rest as its description, instead of
// one run-on sentence.
function splitMessage(message: string): { title: string; description?: string } {
  const idx = message.indexOf(' — ');
  if (idx === -1) return { title: message };
  return { title: message.slice(0, idx), description: message.slice(idx + 3) };
}

// Icon is chosen from severity + actionTabId — both stable, typed fields
// buildInsights() already sets per insight kind, not string-matched against
// message text (which would break the moment the backend's wording changes).
// - critical (the only critical case: achievement-gap) -> trending down
// - warning + actionTabId 'customers' (missed emails) -> clock
// - warning + actionTabId 'pipeline' (lost > won) -> trending down
// - info + actionTabId set (open deals reminder) -> activity
// - info + no actionTabId (the "all good" fallback) -> check
function insightIcon(insight: AiInsightItem): IconType {
  if (!insight.actionTabId) return FiCheckCircle;
  if (insight.severity === 'critical') return FiTrendingDown;
  if (insight.actionTabId === 'customers') return FiClock;
  if (insight.severity === 'warning') return FiTrendingDown;
  return FiActivity;
}

export interface AiBriefingCardProps {
  insights: AiInsightItem[];
  dataUpdatedAt?: number;
  onAction: (actionTabId: string) => void;
}

export function AiBriefingCard({ insights, dataUpdatedAt, onAction }: AiBriefingCardProps) {
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <FiZap size={16} />
          AI briefing
        </span>
        {dataUpdatedAt && <span className={styles.headerMeta}>Updated {formatRelativeTime(new Date(dataUpdatedAt).toISOString())}</span>}
      </div>

      <div className={styles.grid}>
        {insights.map((insight, i) => {
          const { title, description } = splitMessage(insight.message);
          const Icon = insightIcon(insight);
          return (
            <div key={i} className={styles.item}>
              <span className={styles.iconBadge}>
                <Icon size={16} />
              </span>
              <div className={styles.body}>
                <div className={styles.title}>{title}</div>
                {description && <div className={styles.description}>{description}</div>}
              </div>
              {insight.actionTabId && (
                <button type="button" className={styles.action} onClick={() => onAction(insight.actionTabId!)}>
                  {insight.actionLabel ?? 'View'}
                  <FiChevronRight size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

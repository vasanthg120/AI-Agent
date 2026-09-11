import { FiCornerUpRight, FiHelpCircle, FiMessageCircle, FiShield } from 'react-icons/fi';
import type { CallRecommendation } from '@/services/callCopilotService';
import styles from './RecommendationsPanel.module.css';

const TYPE_ICON: Record<CallRecommendation['type'], typeof FiMessageCircle> = {
  say: FiMessageCircle,
  ask: FiHelpCircle,
  handle_objection: FiShield,
  next_action: FiCornerUpRight,
};

const TYPE_LABEL: Record<CallRecommendation['type'], string> = {
  say: 'Say',
  ask: 'Ask',
  handle_objection: 'Handle Objection',
  next_action: 'Next Action',
};

// Newest first, capped to a short live list — this is meant to be glanced at
// mid-call, not scrolled through like a transcript.
export function RecommendationsPanel({ recommendations }: { recommendations: CallRecommendation[] }) {
  if (recommendations.length === 0) {
    return <p className={styles.empty}>Real-time suggestions — what to say, ask, or do next — will appear here.</p>;
  }

  const recent = [...recommendations].reverse().slice(0, 8);

  return (
    <div className={styles.list}>
      {recent.map((rec, i) => {
        const Icon = TYPE_ICON[rec.type];
        return (
          <div key={i} className={i === 0 ? styles.rowLatest : styles.row}>
            <span className={styles.iconBadge}>
              <Icon size={14} />
            </span>
            <div>
              <div className={styles.typeLabel}>{TYPE_LABEL[rec.type]}</div>
              <div className={styles.text}>{rec.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

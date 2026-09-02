import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiCheckCircle, FiList, FiPlay, FiX } from 'react-icons/fi';
import { Badge, Button, SectionCard, Skeleton } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import { businessKnowledgeAdvisorService, type BusinessRecommendation, type RecommendationStatus } from '@/services/businessKnowledgeAdvisorService';
import { extractErrorMessage } from '@/utils/errors';
import styles from '../business-knowledge.module.css';

const PRIORITY_VARIANT: Record<BusinessRecommendation['priority'], BadgeVariant> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
  opportunity: 'info',
};
const STATUS_VARIANT: Record<RecommendationStatus, BadgeVariant> = {
  open: 'neutral',
  in_progress: 'accent',
  completed: 'success',
  dismissed: 'neutral',
};

// Rule-based recommendations (business-knowledge-insights.service.ts) —
// every row here traces back to a concrete completeness gap, not an LLM
// inventing a suggestion. Status is user-driven (Start/Complete/Dismiss per
// spec §17); a row also auto-completes on its own once the underlying gap
// closes, which just shows up here as its status already being 'completed'.
export function BusinessKnowledgeRecommendationsSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['business-knowledge-recommendations'],
    queryFn: () => businessKnowledgeAdvisorService.listRecommendations(),
  });

  const setStatus = async (id: string, status: RecommendationStatus) => {
    try {
      await businessKnowledgeAdvisorService.updateRecommendationStatus(id, status);
      queryClient.invalidateQueries({ queryKey: ['business-knowledge-recommendations'] });
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  return (
    <div className={styles.tabContent}>
      <SectionCard title="Recommendations" icon={FiList}>
        {isLoading || !data ? (
          <Skeleton height={220} />
        ) : data.length === 0 ? (
          <p className={styles.emptyState}>No recommendations yet — they appear here as gaps are found in your business knowledge.</p>
        ) : (
          <div className={styles.formGrid}>
            {data.map((rec) => (
              <div key={rec._id} className={styles.card} style={{ gap: 'var(--space-2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-2)' }}>
                  <strong style={{ fontSize: 'var(--text-sm)' }}>{rec.title}</strong>
                  <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                    <Badge variant={PRIORITY_VARIANT[rec.priority]}>{rec.priority}</Badge>
                    <Badge variant={STATUS_VARIANT[rec.status]}>{rec.status.replace('_', ' ')}</Badge>
                  </div>
                </div>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{rec.category}</span>
                <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{rec.reason}</p>
                <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{rec.recommendedAction}</p>

                {rec.status !== 'completed' && rec.status !== 'dismissed' && (
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    {rec.status === 'open' && (
                      <Button size="sm" variant="secondary" leftIcon={<FiPlay size={12} />} onClick={() => setStatus(rec._id, 'in_progress')}>
                        Start Improvement
                      </Button>
                    )}
                    <Button size="sm" leftIcon={<FiCheckCircle size={12} />} onClick={() => setStatus(rec._id, 'completed')}>
                      Complete Improvement
                    </Button>
                    <Button size="sm" variant="ghost" leftIcon={<FiX size={12} />} onClick={() => setStatus(rec._id, 'dismissed')}>
                      Dismiss
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

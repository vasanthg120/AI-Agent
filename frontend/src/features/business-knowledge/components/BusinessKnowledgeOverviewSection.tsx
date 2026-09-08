import { useQuery } from '@tanstack/react-query';
import { FiActivity } from 'react-icons/fi';
import { SectionCard, Skeleton } from '@/components/ui';
import { businessKnowledgeAdvisorService } from '@/services/businessKnowledgeAdvisorService';
import styles from '../business-knowledge.module.css';

// Landing view of the Business Advisor (Phase 1) — per-category completeness
// (business-knowledge-insights.service.ts's deterministic engine: profile
// fields + reviewed-document coverage, never an LLM-decided number) plus a
// strong/needs-attention summary, matching the spec's worked example
// ("Your Business Knowledge is 62% complete... Strong: ... Needs attention: ...").
export function BusinessKnowledgeOverviewSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['business-knowledge-completeness'],
    queryFn: () => businessKnowledgeAdvisorService.getCompleteness(),
  });

  return (
    <div className={styles.tabContent}>
      <SectionCard title="Business Knowledge Completeness" icon={FiActivity}>
        {isLoading || !data ? (
          <Skeleton height={220} />
        ) : (
          <div className={styles.formGrid}>
            <div className={styles.completenessRow}>
              <strong style={{ fontSize: 'var(--text-lg)', color: 'var(--color-text-primary)' }}>{data.overallPct}%</strong>
              <span>complete</span>
            </div>

            <div className={styles.formGrid}>
              {data.categories.map((category) => (
                <div key={category.id} className={styles.formGrid} style={{ gap: 'var(--space-1)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}>
                    <span>{category.label}</span>
                    <span className={styles.completenessRow}>{category.pct}%</span>
                  </div>
                  <div className={styles.completenessTrack} style={{ width: '100%' }}>
                    <div
                      className={styles.completenessFill}
                      style={{
                        width: `${category.pct}%`,
                        background:
                          category.status === 'strong'
                            ? 'var(--color-success, #2f9e5b)'
                            : category.status === 'needs_attention'
                              ? 'var(--color-danger, #c0432f)'
                              : 'var(--brand-accent-primary)',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {(data.strong.length > 0 || data.needsAttention.length > 0) && (
              <div className={styles.twoColumn}>
                {data.strong.length > 0 && (
                  <div className={styles.card}>
                    <strong style={{ fontSize: 'var(--text-sm)' }}>Strong</strong>
                    {data.strong.map((label) => (
                      <span key={label} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                        ✓ {label}
                      </span>
                    ))}
                  </div>
                )}
                {data.needsAttention.length > 0 && (
                  <div className={styles.card}>
                    <strong style={{ fontSize: 'var(--text-sm)' }}>Needs attention</strong>
                    {data.needsAttention.map((label) => (
                      <span key={label} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                        ⚠ {label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

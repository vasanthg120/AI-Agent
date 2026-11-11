import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiArrowLeft } from 'react-icons/fi';
import { Badge, SectionCard, Skeleton, StatTile } from '@/components/ui';
import { aiUsageHierarchyService, type RequestDetail } from '@/services/aiUsageHierarchyService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import { ADMIN_ROUTES } from '@/constants/routes';
import shared from '../adminShared.module.css';

export function AiUsageRequestDetailPage() {
  const { organizationId, userId, requestId } = useParams<{ organizationId: string; userId: string; requestId: string }>();
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!organizationId || !userId || !requestId) return;
    setLoading(true);
    aiUsageHierarchyService
      .getRequestDetail(organizationId, userId, requestId)
      .then(setDetail)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  }, [organizationId, userId, requestId]);

  return (
    <div className={shared.page}>
      <Link to={organizationId && userId ? ADMIN_ROUTES.aiUsageUserDetail(organizationId, userId) : ADMIN_ROUTES.aiUsage} className={shared.backLink}>
        <FiArrowLeft size={14} /> User
      </Link>

      {loading || !detail ? (
        <Skeleton height={200} />
      ) : (
        <>
          <div className={shared.headerRow}>
            <div>
              <h1 className={shared.pageTitle} style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                {detail.requestId}
              </h1>
              <p className={shared.pageSubtitle}>
                {detail.startedAt ? formatFullDate(detail.startedAt) : '—'}
                {detail.status && (
                  <>
                    {' '}
                    <Badge variant={detail.status === 'success' ? 'success' : 'danger'}>{detail.status}</Badge>
                  </>
                )}
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 'var(--space-4)' }}>
            <StatTile value={detail.summary.generationCount} label="LLM Generations" />
            <StatTile value={detail.summary.totalTokens.toLocaleString()} label="Total Tokens" />
            {detail.summary.reasoningTokens != null && <StatTile value={detail.summary.reasoningTokens.toLocaleString()} label="Reasoning Tokens" />}
            <StatTile value={`$${detail.summary.providerCostUsd.toFixed(4)}`} label="Provider Cost" />
            <StatTile value={`${detail.summary.customerChargeCredits.toLocaleString()} cr`} label="Customer Charge" />
          </div>

          <SectionCard title="Timeline">
            <div className={shared.tableWrap}>
              <table className={shared.table}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Kind</th>
                    <th>Agent</th>
                    <th>Provider / Model</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                    <th>Latency</th>
                    <th>Status</th>
                    <th>Trace</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.generations.map((g) => (
                    <tr key={g.id}>
                      <td>{formatFullDate(g.occurredAt)}</td>
                      <td>
                        <Badge variant="neutral">{g.kind}</Badge>
                      </td>
                      <td>{g.agentName}</td>
                      <td>
                        {g.provider ?? '—'} {g.model ? `/ ${g.model}` : ''}
                      </td>
                      <td>
                        {g.inputTokens != null ? `${g.inputTokens.toLocaleString()} in / ${(g.outputTokens ?? 0).toLocaleString()} out` : '—'}
                        {g.reasoningTokens != null && <div className={shared.mono}>{g.reasoningTokens.toLocaleString()} reasoning</div>}
                      </td>
                      <td>{g.costUsd != null ? `$${g.costUsd.toFixed(4)}` : '—'}</td>
                      <td>{g.latencyMs != null ? `${Math.round(g.latencyMs)}ms` : '—'}</td>
                      <td>
                        <Badge variant={g.success ? 'success' : 'danger'}>{g.success ? 'success' : 'failed'}</Badge>
                        {g.error && <div className={shared.mono}>{g.error}</div>}
                      </td>
                      <td>
                        {g.langfuseTraceUrl ? (
                          <a href={g.langfuseTraceUrl} target="_blank" rel="noopener noreferrer">
                            View Trace
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}

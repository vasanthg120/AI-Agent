import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiArrowLeft, FiDownload } from 'react-icons/fi';
import { Badge, Button, SectionCard, Skeleton, StatTile } from '@/components/ui';
import { aiUsageHierarchyService, type UserDetail } from '@/services/aiUsageHierarchyService';
import { saveBlob } from '@/services/cloudFilesService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import { ADMIN_ROUTES } from '@/constants/routes';
import { AdminPagination } from '../components/AdminPagination';
import shared from '../adminShared.module.css';

const DAYS = 30;
const PAGE_SIZE = 25;

export function AiUsageUserDetailPage() {
  const { organizationId, userId } = useParams<{ organizationId: string; userId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!organizationId || !userId) return;
    setLoading(true);
    aiUsageHierarchyService
      .getUserDetail(organizationId, userId, DAYS, page, PAGE_SIZE)
      .then(setDetail)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  }, [organizationId, userId, page]);

  const handleExport = async () => {
    if (!organizationId || !userId) return;
    setExporting(true);
    try {
      const blob = await aiUsageHierarchyService.exportCsv({ organizationId, userId }, DAYS);
      saveBlob(blob, `ai-usage-requests-${userId}.csv`);
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={shared.page}>
      <Link to={organizationId ? ADMIN_ROUTES.aiUsageOrganizationDetail(organizationId) : ADMIN_ROUTES.aiUsage} className={shared.backLink}>
        <FiArrowLeft size={14} /> Organization
      </Link>

      {loading || !detail ? (
        <Skeleton height={200} />
      ) : (
        <>
          <div className={shared.headerRow}>
            <div>
              <h1 className={shared.pageTitle}>{detail.userName}</h1>
              <p className={shared.pageSubtitle}>{detail.email ?? 'No email on file'} · AI usage over the last {DAYS} days</p>
            </div>
            <Button size="sm" variant="outline" leftIcon={<FiDownload />} loading={exporting} onClick={() => void handleExport()}>
              Export Requests CSV
            </Button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 'var(--space-4)' }}>
            <StatTile value={detail.requests.total.toLocaleString()} label="Requests" />
            <StatTile value={(detail.inputTokens + detail.outputTokens).toLocaleString()} label="Total Tokens" />
            <StatTile value={`$${detail.providerCostUsd.toFixed(4)}`} label="Provider Cost" />
            <StatTile value={`${detail.customerChargeCredits.toLocaleString()} cr`} label="Customer Charges" />
            <StatTile value={detail.lastActivity ? formatFullDate(detail.lastActivity) : 'Never'} label="Last Activity" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
            <SectionCard title="Model Breakdown">
              {detail.modelBreakdown.map((m) => (
                <div key={m.model} style={{ display: 'flex', justifyContent: 'space-between', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--color-border)' }}>
                  <span>{m.model}</span>
                  <span>
                    {m.requests} requests · ${m.cost.toFixed(4)}
                  </span>
                </div>
              ))}
            </SectionCard>
            <SectionCard title="Agent Breakdown">
              {detail.agentBreakdown.map((a) => (
                <div key={a.agentName} style={{ display: 'flex', justifyContent: 'space-between', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--color-border)' }}>
                  <span>{a.agentName}</span>
                  <span>
                    {a.requests} requests · ${a.cost.toFixed(4)}
                  </span>
                </div>
              ))}
            </SectionCard>
          </div>

          <SectionCard title="Requests">
            <div className={shared.tableWrap}>
              <table className={shared.table}>
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Started</th>
                    <th>Agents</th>
                    <th>Generations</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.requests.items.length === 0 && (
                    <tr>
                      <td colSpan={7} className={shared.emptyState}>
                        No requests in the last {DAYS} days.
                      </td>
                    </tr>
                  )}
                  {detail.requests.items.map((r) => (
                    <tr
                      key={r.requestId}
                      className={shared.tableRow}
                      onClick={() => organizationId && userId && navigate(ADMIN_ROUTES.aiUsageRequestDetail(organizationId, userId, r.requestId))}
                    >
                      <td className={shared.mono}>{r.requestId}</td>
                      <td>{formatFullDate(r.startedAt)}</td>
                      <td>{r.agents.join(', ')}</td>
                      <td>{r.generationCount}</td>
                      <td>{r.totalTokens.toLocaleString()}</td>
                      <td>${r.providerCostUsd.toFixed(4)}</td>
                      <td>
                        <Badge variant={r.status === 'success' ? 'success' : 'danger'}>{r.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <AdminPagination page={page} limit={PAGE_SIZE} total={detail.requests.total} onChange={setPage} />
          </SectionCard>
        </>
      )}
    </div>
  );
}

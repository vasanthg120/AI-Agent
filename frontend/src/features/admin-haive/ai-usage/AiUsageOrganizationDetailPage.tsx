import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiArrowLeft, FiDownload } from 'react-icons/fi';
import { Badge, Button, SectionCard, Skeleton, StatTile } from '@/components/ui';
import { aiUsageHierarchyService, type OrganizationDetail } from '@/services/aiUsageHierarchyService';
import { saveBlob } from '@/services/cloudFilesService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import { ADMIN_ROUTES } from '@/constants/routes';
import shared from '../adminShared.module.css';

const DAYS = 30;

export function AiUsageOrganizationDetailPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<OrganizationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!organizationId) return;
    setLoading(true);
    aiUsageHierarchyService
      .getOrganizationDetail(organizationId, DAYS)
      .then(setDetail)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  }, [organizationId]);

  const handleExport = async () => {
    if (!organizationId) return;
    setExporting(true);
    try {
      const blob = await aiUsageHierarchyService.exportCsv({ organizationId }, DAYS);
      saveBlob(blob, `ai-usage-users-${organizationId}.csv`);
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={shared.page}>
      <Link to={ADMIN_ROUTES.aiUsage} className={shared.backLink}>
        <FiArrowLeft size={14} /> AI Usage
      </Link>

      {loading || !detail ? (
        <Skeleton height={200} />
      ) : (
        <>
          <div className={shared.headerRow}>
            <div>
              <h1 className={shared.pageTitle}>{detail.organizationName}</h1>
              <p className={shared.pageSubtitle}>AI usage over the last {DAYS} days {detail.status && <Badge variant={detail.status === 'active' ? 'success' : 'neutral'}>{detail.status}</Badge>}</p>
            </div>
            <Button size="sm" variant="outline" leftIcon={<FiDownload />} loading={exporting} onClick={() => void handleExport()}>
              Export Users CSV
            </Button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 'var(--space-4)' }}>
            <StatTile value={detail.requests.toLocaleString()} label="Requests" />
            <StatTile value={detail.users.length} label="Active Users" />
            <StatTile value={(detail.inputTokens + detail.outputTokens).toLocaleString()} label="Total Tokens" />
            <StatTile value={`$${detail.providerCostUsd.toFixed(4)}`} label="Provider Cost" />
            <StatTile value={`${detail.customerChargeCredits.toLocaleString()} cr`} label="Customer Charges" />
          </div>

          <SectionCard title="Users">
            <div className={shared.tableWrap}>
              <table className={shared.table}>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Requests</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Provider Cost</th>
                    <th>Last Activity</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.users.length === 0 && (
                    <tr>
                      <td colSpan={6} className={shared.emptyState}>
                        No AI activity for this organization in the last {DAYS} days.
                      </td>
                    </tr>
                  )}
                  {detail.users.map((u) => (
                    <tr key={u.userId} className={shared.tableRow} onClick={() => navigate(ADMIN_ROUTES.aiUsageUserDetail(detail.organizationId, u.userId))}>
                      <td>
                        {u.userName}
                        {u.email && <div className={shared.mono}>{u.email}</div>}
                      </td>
                      <td>{u.requests.toLocaleString()}</td>
                      <td>{u.inputTokens.toLocaleString()}</td>
                      <td>{u.outputTokens.toLocaleString()}</td>
                      <td>${u.providerCostUsd.toFixed(4)}</td>
                      <td>{u.lastActivity ? formatFullDate(u.lastActivity) : '—'}</td>
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

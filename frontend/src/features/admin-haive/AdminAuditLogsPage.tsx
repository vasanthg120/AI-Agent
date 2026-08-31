import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiSearch } from 'react-icons/fi';
import { Badge, Input, Skeleton } from '@/components/ui';
import { auditLogsAdminService, type AuditLogRow } from '@/services/auditLogsAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import { AdminPagination } from './components/AdminPagination';
import shared from './adminShared.module.css';

const LIMIT = 50;

// Read-only over rows the global AuditInterceptor already writes for every
// mutating route app-wide (see audit.interceptor.ts) — no before/after
// values or request bodies are ever captured there, so none appear here
// either; this is the accountability trail (who/what/when/outcome), not a
// request replay log.
export function AdminAuditLogsPage() {
  const [route, setRoute] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setLoading(true);
      auditLogsAdminService
        .listAll({ route: route || undefined, page, limit: LIMIT })
        .then((result) => {
          setRows(result.items);
          setTotal(result.total);
        })
        .catch((error) => toast.error(extractErrorMessage(error)))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timeout);
  }, [route, page]);

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Audit Logs</h1>
          <p className={shared.pageSubtitle}>Every admin mutation across the platform — plans, prices, refunds, payment settings, and more.</p>
        </div>
      </div>

      <Input
        className={shared.searchInput}
        placeholder="Filter by route (e.g. refunds)..."
        leftIcon={<FiSearch />}
        value={route}
        onChange={(event) => {
          setPage(1);
          setRoute(event.target.value);
        }}
      />

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Actor</th>
              <th>Method</th>
              <th>Route</th>
              <th>Status</th>
              <th>Duration</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 10 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={7}>
                    <Skeleton height={20} />
                  </td>
                </tr>
              ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className={shared.emptyState}>
                  No audit entries match this filter.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((row) => (
                <tr key={row._id}>
                  <td>{formatFullDate(row.createdAt)}</td>
                  <td className={shared.mono}>{row.userId}</td>
                  <td>{row.method}</td>
                  <td className={shared.mono}>{row.route}</td>
                  <td>
                    <Badge variant={row.statusCode < 300 ? 'success' : row.statusCode < 500 ? 'warning' : 'danger'}>{row.statusCode}</Badge>
                  </td>
                  <td>{row.durationMs}ms</td>
                  <td className={shared.mono}>{row.ip ?? '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <AdminPagination page={page} limit={LIMIT} total={total} onChange={setPage} />
    </div>
  );
}

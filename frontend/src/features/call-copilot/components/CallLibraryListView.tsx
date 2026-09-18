import { useEffect, useState } from 'react';
import { FiMic, FiSearch, FiUploadCloud } from 'react-icons/fi';
import { Badge, DateRangeControl, Input, Skeleton, StatTile } from '@/components/ui';
import type { DateRange } from '@/components/ui';
import {
  callCopilotService,
  type CallLibraryStats,
  type CallSessionDetail,
  type CallSessionSummary,
} from '@/services/callCopilotService';
import { CallSummaryModal } from './CallSummaryModal';
import styles from './CallLibraryListView.module.css';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 400;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Modeled on BusinessKnowledgeDocumentListView.tsx's row/pagination/
// Skeleton/empty-state shape — a state-swap sibling view within
// CallCopilotPage (reached via its Tabs control), not a new route, matching
// how Business Knowledge/Finance's own list views work.
export function CallLibraryListView() {
  const [query, setQuery] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>({});
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<CallSessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState<'browse' | 'search'>('browse');
  const [stats, setStats] = useState<CallLibraryStats | null>(null);
  const [selected, setSelected] = useState<CallSessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    callCopilotService.getStats().then(setStats).catch(() => setStats(null));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true);
      callCopilotService
        .searchSessions({ q: query || undefined, dateFrom: dateRange.dateFrom, dateTo: dateRange.dateTo, page, pageSize: PAGE_SIZE })
        .then((result) => {
          setItems(result.items);
          setTotal(result.total);
          setMode(result.mode);
        })
        .catch(() => {
          setItems([]);
          setTotal(0);
        })
        .finally(() => setLoading(false));
    }, query ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [query, dateRange, page]);

  const openSession = async (id: string) => {
    setDetailLoading(true);
    try {
      const detail = await callCopilotService.getSession(id);
      setSelected(detail);
    } finally {
      setDetailLoading(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className={styles.wrapper}>
      {stats && (
        <div className={styles.statRow}>
          <StatTile label="Total Calls" value={stats.total} />
          <StatTile label="Last 7 Days" value={stats.last7Days} />
          <StatTile label="Live" value={stats.live} icon={FiMic} />
          <StatTile label="Uploaded" value={stats.uploaded} icon={FiUploadCloud} />
        </div>
      )}

      <div className={styles.filterRow}>
        <Input
          placeholder="Search what was said in past calls…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          leftIcon={<FiSearch />}
        />
        <DateRangeControl
          value={dateRange}
          onChange={(range) => {
            setDateRange(range);
            setPage(1);
          }}
        />
      </div>

      {mode === 'search' && query && <p className={styles.hint}>Showing top matches for &quot;{query}&quot;.</p>}

      {loading ? (
        <div className={styles.list}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} height={64} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>No calls found.</div>
      ) : (
        <div className={styles.list}>
          {items.map((item) => (
            <button key={item._id} type="button" className={styles.row} onClick={() => void openSession(item._id)}>
              <div className={styles.rowMain}>
                <Badge variant={item.source === 'upload' ? 'neutral' : 'success'}>{item.source === 'upload' ? 'Uploaded' : 'Live'}</Badge>
                <span className={styles.rowTitle}>{item.headline || item.originalFilename || 'Sales call'}</span>
              </div>
              <div className={styles.rowMeta}>
                <Badge variant={item.status === 'ended' ? 'success' : item.status === 'error' ? 'danger' : 'neutral'}>{item.status}</Badge>
                <span>{formatDate(item.createdAt)}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {mode === 'browse' && totalPages > 1 && (
        <div className={styles.pagination}>
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>
            Page {page} of {totalPages}
          </span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}

      {(selected || detailLoading) && (
        <CallSummaryModal
          open={!!selected || detailLoading}
          onClose={() => setSelected(null)}
          source={selected?.source}
          originalFilename={selected?.originalFilename}
          summaryResult={selected}
          segments={selected?.transcript}
          events={selected?.events}
          sentiment={selected?.sentiment}
          sessionId={selected?._id}
        />
      )}
    </div>
  );
}

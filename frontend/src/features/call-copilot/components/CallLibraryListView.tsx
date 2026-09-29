import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import dayjs from 'dayjs';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiChevronLeft,
  FiChevronRight,
  FiClock,
  FiFolder,
  FiInbox,
  FiMic,
  FiPhoneCall,
  FiSearch,
  FiUploadCloud,
  FiX,
} from 'react-icons/fi';
import { Button, DateRangeControl, Input, Skeleton, Spinner } from '@/components/ui';
import type { DateRange } from '@/components/ui';
import {
  callCopilotService,
  hasCoachingReport,
  type CallLibraryStats,
  type CallSessionDetail,
  type CallSessionSummary,
} from '@/services/callCopilotService';
import { OUTCOME_META, describeSource, formatCallDate, type CallKind } from '../callMeta';
import { FADE_UP, staggerChildren } from '../motion';
import { CallSummaryModal } from './CallSummaryModal';
import { CountUp } from './CountUp';
import { ScoreRing } from './ScoreRing';
import { SentimentIndicator } from './SentimentIndicator';
import styles from './CallLibraryListView.module.css';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 400;

const DAY_FORMAT = 'YYYY-MM-DD';

// The Library opens on today's calls — what you just did is what you most
// likely want to look at. (The date control lights up "Today" by itself when
// its value is exactly today's range.)
function todayRange(): DateRange {
  const today = dayjs().format(DAY_FORMAT);
  return { dateFrom: today, dateTo: today };
}

function isTodayRange(range: DateRange): boolean {
  const today = todayRange();
  return range.dateFrom === today.dateFrom && range.dateTo === today.dateTo;
}

// The control speaks in plain dates; the server needs instants. Sending the
// start and end of the picked days in the *viewer's* timezone makes "Today"
// mean their own calendar day (a bare date would be read as midnight UTC — the
// start of the day, so a same-day range would match nothing at all).
function toQueryRange(range: DateRange): { dateFrom?: string; dateTo?: string } {
  return {
    dateFrom: range.dateFrom ? dayjs(range.dateFrom).startOf('day').toISOString() : undefined,
    dateTo: range.dateTo ? dayjs(range.dateTo).endOf('day').toISOString() : undefined,
  };
}

const KIND_ICON: Record<CallKind, ReactNode> = {
  live: <FiMic />,
  phone: <FiPhoneCall />,
  upload: <FiUploadCloud />,
};

// Modeled on BusinessKnowledgeDocumentListView.tsx's row/pagination/
// Skeleton/empty-state shape — a state-swap sibling view within
// CallCopilotPage (reached via its Tabs control), not a new route, matching
// how Business Knowledge/Finance's own list views work.
export function CallLibraryListView({ onStartCall }: { onStartCall?: () => void }) {
  const [query, setQuery] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(todayRange);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  // Bumped each time a new result set arrives — the list's entrance animation
  // replays for new results only, not on every keystroke or refresh.
  const [resultVersion, setResultVersion] = useState(0);
  const [items, setItems] = useState<CallSessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState<'browse' | 'search'>('browse');
  const [stats, setStats] = useState<CallLibraryStats | null>(null);
  const [selected, setSelected] = useState<CallSessionDetail | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    callCopilotService
      .getStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const searching = query.trim() !== '';

  useEffect(() => {
    // A slower, older request must never overwrite the results of a newer one.
    let stale = false;
    const timer = setTimeout(
      () => {
        setLoading(true);
        callCopilotService
          .searchSessions({
            q: searching ? query.trim() : undefined,
            // Searching by words looks across every call — the server's text search doesn't take a date range —
            // so the dates only apply when browsing (see the dimmed date control below).
            ...(searching ? {} : toQueryRange(dateRange)),
            page,
            pageSize: PAGE_SIZE,
          })
          .then((result) => {
            if (stale) return;
            setResultVersion((v) => v + 1);
            setItems(result.items);
            setTotal(result.total);
            setMode(result.mode);
          })
          .catch(() => {
            if (stale) return;
            setItems([]);
            setTotal(0);
          })
          .finally(() => {
            if (!stale) setLoading(false);
          });
      },
      searching ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // `searching` is derived from `query`, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, dateRange, page]);

  // The dialog opens once the call has loaded — not before, when it would show
  // an empty "not coached yet" state for a call that simply hasn't arrived.
  const openSession = async (id: string) => {
    setOpeningId(id);
    try {
      setSelected(await callCopilotService.getSession(id));
    } catch {
      toast.error("Couldn't open that call. Please try again.");
    } finally {
      setOpeningId(null);
    }
  };

  const hasDates = !!dateRange.dateFrom || !!dateRange.dateTo;
  const showAllCalls = () => {
    setQuery('');
    setDateRange({});
    setPage(1);
  };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // What "nothing here" means depends on why: the Library opens on Today, so an
  // empty screen is usually just "no calls yet today" — not a failed search.
  const empty = searching
    ? { title: 'No calls match your search', text: 'Try a different word.', reset: 'Clear search' }
    : hasDates
      ? isTodayRange(dateRange)
        ? {
            title: 'No calls today yet',
            text: 'Calls you record, make or upload today show up here.',
            reset: 'Show all calls',
          }
        : {
            title: 'No calls in this date range',
            text: 'Try a wider range, or look at everything.',
            reset: 'Show all calls',
          }
      : {
          title: 'Your Call Library is empty',
          text: 'Every call you record, make or upload shows up here with a summary and AI coaching.',
          reset: null,
        };

  return (
    <div className={styles.wrapper}>
      {stats && (
        <motion.div className={styles.kpis} variants={staggerChildren(0.06)} initial="hidden" animate="show">
          <Kpi icon={<FiFolder />} label="Total calls" value={stats.total} />
          <Kpi icon={<FiClock />} label="Last 7 days" value={stats.last7Days} />
          <Kpi icon={<FiMic />} label="Recorded live" value={stats.live} />
          <Kpi icon={<FiUploadCloud />} label="Uploaded & phone" value={stats.uploaded} />
        </motion.div>
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
          rightIcon={
            query ? (
              <button
                type="button"
                className={styles.clear}
                aria-label="Clear the search box"
                onClick={() => {
                  setQuery('');
                  setPage(1);
                }}
              >
                <FiX />
              </button>
            ) : undefined
          }
        />
        <div
          className={clsx(styles.dates, searching && styles.datesOff)}
          aria-disabled={searching || undefined}
          title={searching ? 'Searching looks across all dates' : undefined}
        >
          <DateRangeControl
            value={dateRange}
            onChange={(range) => {
              setDateRange(range);
              setPage(1);
            }}
          />
        </div>
      </div>

      {mode === 'search' && searching && (
        <p className={styles.hint}>Showing the best matches for &ldquo;{query.trim()}&rdquo; across all dates.</p>
      )}

      {/* Skeletons only before the first results; after that the current list stays up, dimmed, while the next
          page or search loads — swapping it for placeholders on every change is what made it flicker. */}
      {loading && resultVersion === 0 ? (
        <div className={styles.list} aria-busy>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} height={92} className={styles.skeletonRow} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <motion.div className={styles.empty} variants={FADE_UP} initial="hidden" animate="show">
          <span className={styles.emptyIcon} aria-hidden>
            <FiInbox />
          </span>
          <h3 className={styles.emptyTitle}>{empty.title}</h3>
          <p className={styles.emptyText}>{empty.text}</p>
          <div className={styles.emptyActions}>
            {empty.reset && (
              <Button
                type="button"
                variant="secondary"
                onClick={
                  searching
                    ? () => {
                        setQuery('');
                        setPage(1);
                      }
                    : showAllCalls
                }
              >
                {empty.reset}
              </Button>
            )}
            {!searching && onStartCall && (
              <Button type="button" leftIcon={<FiMic />} onClick={onStartCall}>
                Start a call
              </Button>
            )}
          </div>
        </motion.div>
      ) : (
        <motion.ul
          key={resultVersion}
          className={styles.list}
          aria-busy={loading || undefined}
          style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 150ms ease-out' }}
          variants={staggerChildren(0.045)}
          initial="hidden"
          animate="show"
        >
          {items.map((item) => (
            <CallRow
              key={item._id}
              item={item}
              opening={openingId === item._id}
              onOpen={() => void openSession(item._id)}
            />
          ))}
        </motion.ul>
      )}

      {mode === 'browse' && totalPages > 1 && (
        <nav className={styles.pagination} aria-label="Call Library pages">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <FiChevronLeft aria-hidden /> Previous
          </button>
          <span className={styles.pageInfo}>
            Page {page} of {totalPages}
          </span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next <FiChevronRight aria-hidden />
          </button>
        </nav>
      )}

      {selected && (
        <CallSummaryModal
          open
          onClose={() => setSelected(null)}
          source={selected.source}
          originalFilename={selected.originalFilename}
          summaryResult={selected}
          segments={selected.transcript}
          sessionId={selected._id}
          // Uploaded recordings' detectedAt timestamps reflect when batch
          // processing happened to create them, not the audio's real
          // position — showing elapsed-time-since-call-start for those would
          // be misleading, so createdAt is only passed for a real live call.
          createdAt={selected.source === 'live' ? selected.createdAt : undefined}
          sentiment={selected.sentiment}
          coaching={hasCoachingReport(selected) ? selected : undefined}
          onCoachingGenerated={(report) => setSelected((prev) => (prev ? { ...prev, ...report } : prev))}
        />
      )}
    </div>
  );
}

function Kpi({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <motion.div className={styles.kpi} variants={FADE_UP}>
      <span className={styles.kpiIcon} aria-hidden>
        {icon}
      </span>
      <span className={styles.kpiText}>
        <span className={styles.kpiValue}>
          <CountUp value={value} />
        </span>
        <span className={styles.kpiLabel}>{label}</span>
      </span>
    </motion.div>
  );
}

function CallRow({ item, opening, onOpen }: { item: CallSessionSummary; opening: boolean; onOpen: () => void }) {
  const kind = describeSource(item.source, item.originalFilename);
  const outcome = item.outcome ? OUTCOME_META[item.outcome] : undefined;
  const coached = hasCoachingReport(item);
  // A mean of 0 means every skill scored 0 — nothing to score, not a bad call.
  const notScored = coached && item.overallScore === 0;
  const title = item.headline || (kind.kind === 'phone' ? 'Phone call' : item.originalFilename) || 'Sales call';
  const snippet = item.summaryPoints?.[0];
  const state = item.status === 'error' ? 'Failed' : item.status === 'ended' ? null : 'Processing';

  return (
    <motion.li variants={FADE_UP}>
      <button type="button" className={styles.row} onClick={onOpen} disabled={opening} aria-busy={opening}>
        <span className={clsx(styles.kindIcon, styles[kind.kind])} aria-hidden>
          {KIND_ICON[kind.kind]}
        </span>

        <span className={styles.rowMain}>
          <span className={styles.rowTitle}>{title}</span>
          {snippet && <span className={styles.rowSnippet}>{snippet}</span>}
          <span className={styles.rowMeta}>
            <span className={styles.metaText}>{kind.label}</span>
            <span className={styles.sep} aria-hidden />
            <span className={styles.metaText}>{formatCallDate(item.createdAt)}</span>
            {outcome && <span className={clsx(styles.chip, styles[`chip_${outcome.tone}`])}>{outcome.label}</span>}
            {item.sentiment && <SentimentIndicator sentiment={item.sentiment} />}
            {state && (
              <span className={clsx(styles.chip, state === 'Failed' ? styles.chip_danger : styles.chip_info)}>
                {state}
              </span>
            )}
          </span>
        </span>

        <span className={styles.rowEnd}>
          {opening ? (
            <Spinner size={18} />
          ) : coached ? (
            <span
              className={styles.score}
              title={notScored ? 'Not scored — no sales conversation' : `Coach score ${item.overallScore} out of 10`}
            >
              <ScoreRing value={item.overallScore ?? 0} size={46} strokeWidth={5} showOutOf={false} muted={notScored} />
            </span>
          ) : (
            <span className={styles.noScore} title="Not coached yet">
              —
            </span>
          )}
          <FiChevronRight className={styles.chevron} aria-hidden />
        </span>
      </button>
    </motion.li>
  );
}

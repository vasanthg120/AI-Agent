import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { getSocket } from '@/api/socketClient';
import { useAuthStore } from '@/stores/authStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { Button, ChoiceCards, DateRangeControl, Input, MultiSelectDropdown, PageHeader, SectionCard } from '@/components/ui';
import type { ChoiceCardItem, DateRange } from '@/components/ui';
import { FiAlertCircle, FiCheckCircle, FiClock, FiCornerUpLeft, FiInbox, FiRefreshCw, FiSearch } from 'react-icons/fi';
import { dayjs } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import {
  EMAIL_INTELLIGENCE_INTENTS,
  emailIntelligenceService,
  RELEVANT_EMAIL_INTENTS,
  type EmailInboxCounts,
  type EmailIntelligenceItem,
  type EmailResponseStatus,
  type SyncPreviewResult,
} from '@/services/emailIntelligenceService';
import { EmailIntelligenceList } from './components/EmailIntelligenceList';
import { EmailIntelligenceDetailModal } from './components/EmailIntelligenceDetailModal';
import { EmailSyncPreviewModal } from './components/EmailSyncPreviewModal';
import { FollowUpsSection } from './components/FollowUpsSection';
import { RESPONSE_VIEW_LABEL } from './emailResponseLabels';
import styles from './email-intelligence.module.css';

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Anthropic', groq: 'Groq' };

const PAGE_SIZE = 25;
const QUERY_ROOT = 'email-intelligence-items';
const VIEWS: EmailResponseStatus[] = ['needs_response', 'responded', 'resolved'];

type SortKey = 'urgency' | 'newest' | 'oldest';
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'urgency', label: 'Most urgent first' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

// What each queue card says about itself — so the three queues explain
// the reply workflow without a paragraph of instructions.
const VIEW_META: Record<EmailResponseStatus, Omit<ChoiceCardItem<EmailResponseStatus>, 'id' | 'label' | 'count'>> = {
  needs_response: { icon: FiAlertCircle, tone: 'warning', description: 'Waiting on a reply from you' },
  responded: { icon: FiCornerUpLeft, tone: 'success', description: 'Answered — here or in Outlook' },
  resolved: { icon: FiCheckCircle, tone: 'neutral', description: 'No reply needed, or rejected' },
};

const EMPTY_MESSAGE: Record<EmailResponseStatus, string> = {
  needs_response: "You're all caught up — no emails are waiting for a reply.",
  responded: 'No replied emails yet. Once you reply — here or in Outlook — the email moves here.',
  resolved: 'Nothing here. Rejected emails and mail that needs no reply appear in this tab.',
};

function intentOptionLabel(intent: string): string {
  return intent
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// One real, visible filter control — same underlying allow-list as the previous
// default (customer/enquiry/vendor-type mail), but user-adjustable per intent.
// An empty selection means "no filter" (show everything), matching every other
// MultiSelectDropdown filter in this app — never "show nothing". Now applied
// server-side, so the tab counts, the list and paging all agree.
const INTENT_FILTER_OPTIONS = EMAIL_INTELLIGENCE_INTENTS.map((intent) => ({ value: intent, label: intentOptionLabel(intent) }));

// AI Email Inbox. The tabs answer the question the inbox exists for — does this
// email still need a reply — using a state the BACKEND derives from what
// actually happened to the email (replied through the app, replied in Outlook,
// covered by a later reply in the thread), not from the AI draft's approval
// status. So an email leaves "Needs Response" the moment it is answered, stays
// out across refreshes, syncs and re-logins, and a failed send keeps it there.
export function EmailIntelligencePage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<EmailResponseStatus>('needs_response');
  const [intentFilter, setIntentFilter] = useState<string[]>([...RELEVANT_EMAIL_INTENTS]);
  const [range, setRange] = useState<DateRange>({});
  const [search, setSearch] = useState('');
  // null = "automatic": most urgent first for the reply queue, newest first for
  // the history tabs, until the person picks an order themselves.
  const [sortChoice, setSortChoice] = useState<SortKey | null>(null);
  const [selected, setSelected] = useState<EmailIntelligenceItem | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [preview, setPreview] = useState<SyncPreviewResult | null>(null);

  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const sort: SortKey = sortChoice ?? (view === 'needs_response' ? 'urgency' : 'newest');
  const filters = useMemo(
    () => ({ dateFrom: range.dateFrom, dateTo: range.dateTo, intents: intentFilter, search: debouncedSearch }),
    [range.dateFrom, range.dateTo, intentFilter, debouncedSearch],
  );

  // Every filter is applied server-side (real receivedAt/intent/text filtering,
  // real paging), so what the tab badge counts is exactly what the list can show.
  const {
    data: pages,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: [QUERY_ROOT, 'list', view, sort, filters],
    queryFn: ({ pageParam }) => emailIntelligenceService.list({ ...filters, view, sort, limit: PAGE_SIZE, skip: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (lastPage.length === PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined),
    refetchInterval: 60_000,
  });
  const items = useMemo(() => pages?.pages.flat(), [pages]);

  const { data: counts } = useQuery({
    queryKey: [QUERY_ROOT, 'counts', filters],
    queryFn: () => emailIntelligenceService.counts(filters),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  // Phase 21 follow-up — surfaced before the user clicks Sync, so a real
  // Anthropic/Groq outage is visible up front rather than discovered only
  // after a sync fails. Derived from real recent call telemetry server-side,
  // never a live ping from here.
  const { data: providerHealth } = useQuery({
    queryKey: ['email-intelligence-provider-health'],
    queryFn: () => emailIntelligenceService.getProviderHealth(),
    refetchInterval: 60_000,
  });

  // Arrived here from a notification click (see
  // frontend/src/utils/notificationTarget.ts) — fetched directly by id
  // rather than found in the list above, since the target email may not be in
  // whichever tab happens to be selected (it could already be answered while
  // this page defaults to Needs Response). Independent of the list query, so it
  // opens immediately without waiting on or being limited by its filters.
  useEffect(() => {
    const openEmailId = searchParams.get('openEmailId');
    if (!openEmailId) return;
    emailIntelligenceService
      .getOne(openEmailId)
      .then(setSelected)
      .catch((err) => toast.error(extractErrorMessage(err)));
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('openEmailId');
        return next;
      },
      { replace: true },
    );
  }, [searchParams]);

  // Reflects a change to one email everywhere at once — the open dialog, the
  // rows, and the tab badges — without waiting for a refetch or a page reload:
  // an email that has just been answered leaves Needs Response and its count
  // drops immediately; the refetch that follows then confirms it from the server.
  const applyUpdate = (updated: EmailIntelligenceItem) => {
    const before = selected && selected._id === updated._id ? selected.responseStatus : undefined;
    setSelected(updated);

    for (const query of queryClient.getQueryCache().findAll({ queryKey: [QUERY_ROOT, 'list'] })) {
      const cachedView = query.queryKey[2] as EmailResponseStatus;
      queryClient.setQueryData<InfiniteData<EmailIntelligenceItem[], number>>(query.queryKey, (old) =>
        old && {
          ...old,
          pages: old.pages.map((page) =>
            cachedView === updated.responseStatus
              ? page.map((row) => (row._id === updated._id ? updated : row))
              : page.filter((row) => row._id !== updated._id),
          ),
        },
      );
    }
    if (before && before !== updated.responseStatus) {
      for (const query of queryClient.getQueryCache().findAll({ queryKey: [QUERY_ROOT, 'counts'] })) {
        queryClient.setQueryData<EmailInboxCounts>(query.queryKey, (old) =>
          old && { ...old, [before]: Math.max(0, old[before] - 1), [updated.responseStatus]: old[updated.responseStatus] + 1 },
        );
      }
    }
    void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
  };

  // The only place this page spends an LLM call — nothing runs in the
  // background beyond the half-hourly sweep (see emailIntelligenceService.sync's
  // own comment). "Last synced" is client-only/session-only, since it's purely a
  // UX nicety telling the user their click actually did something. The cheap,
  // LLM-free preview opens a real modal (EmailSyncPreviewModal) showing the full
  // breakdown + a real token estimate, and is skipped entirely when there's
  // genuinely nothing new to process. A sync also picks up replies made directly
  // in Outlook, so the lists are refreshed even when no new mail arrived.
  const handleOpenSyncPreview = async () => {
    setPreviewing(true);
    try {
      const result = await emailIntelligenceService.previewSync();
      if (!result.connected) {
        toast.error('Outlook is not connected — connect it in Integrations to sync your inbox.');
        return;
      }
      const newCount = result.scannedCount - result.alreadyAnalyzedCount;
      if (newCount === 0) {
        setLastSyncedAt(new Date());
        toast.success('Synced — no new mail since last sync.');
        void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
        return;
      }
      setPreview(result);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleConfirmSync = async () => {
    setSyncing(true);
    try {
      const result = await emailIntelligenceService.sync();
      setLastSyncedAt(new Date());
      setPreview(null);
      if (!result.connected) {
        toast.error('Outlook is not connected — connect it in Integrations to sync your inbox.');
      } else if (result.newItemsCount > 0) {
        toast.success(`Synced — ${result.newItemsCount} new email(s) processed.`);
      } else {
        toast.success('Synced — no new mail since last sync.');
      }
      void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  // Real-time nudge: once a synced item is analyzed, the backend notifies
  // the mailbox owner via the existing notification socket channel — same
  // established pattern as FinancePage.tsx's identical listener, no new
  // WebSocket gateway needed.
  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    const socket = getSocket(token);
    const handler = (n: { source?: string }) => {
      if (n.source === 'email-intelligence') {
        void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
      }
    };
    socket.on('notification', handler);
    return () => {
      socket.off('notification', handler);
    };
  }, [queryClient]);

  const queueCards: ChoiceCardItem<EmailResponseStatus>[] = VIEWS.map((id) => ({
    id,
    label: RESPONSE_VIEW_LABEL[id],
    count: counts?.[id],
    ...VIEW_META[id],
  }));
  const total = counts?.[view];
  const filtersActive = debouncedSearch !== '' || range.dateFrom !== undefined || range.dateTo !== undefined;
  const clearFilters = () => {
    setSearch('');
    setRange({});
  };

  return (
    <div className={styles.page}>
      <PageHeader
        icon={FiInbox}
        title="AI Email Inbox"
        subtitle="The AI sorts your mail and drafts replies. Answer an email — here or in Outlook — and it moves out of Needs Response on its own. Syncs every 30 minutes."
        meta={
          <>
            {lastSyncedAt && (
              <span className={styles.lastSynced}>
                <FiClock /> Last synced {dayjs(lastSyncedAt).format('h:mm A')}
              </span>
            )}
            {providerHealth &&
              providerHealth.length > 0 &&
              providerHealth.map((p) => (
                <span key={p.provider} className={styles.providerPill} title={p.lastError ?? undefined}>
                  <span
                    className={clsx(
                      styles.providerDot,
                      p.status === 'available' && styles.providerDotAvailable,
                      p.status === 'degraded' && styles.providerDotDegraded,
                    )}
                  />
                  {PROVIDER_LABEL[p.provider] ?? p.provider}
                  {p.status === 'degraded' ? ' unavailable' : p.status === 'unknown' ? ' status unknown' : ' online'}
                </span>
              ))}
          </>
        }
        actions={
          <Button type="button" leftIcon={<FiRefreshCw />} loading={previewing} onClick={() => void handleOpenSyncPreview()}>
            Sync Inbox
          </Button>
        }
      />

      <ChoiceCards ariaLabel="Email queue" items={queueCards} activeId={view} onChange={setView} />

      <div className={styles.filterRow}>
        <div className={styles.searchBox}>
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject or sender"
            aria-label="Search emails"
            leftIcon={<FiSearch />}
          />
        </div>
        <DateRangeControl value={range} onChange={setRange} />
        <MultiSelectDropdown label="Mail Type" options={INTENT_FILTER_OPTIONS} selected={intentFilter} onChange={setIntentFilter} />
        <select
          className={styles.select}
          aria-label="Sort emails"
          value={sort}
          onChange={(e) => setSortChoice(e.target.value as SortKey)}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <SectionCard
        title={RESPONSE_VIEW_LABEL[view]}
        icon={FiInbox}
        action={
          items && total !== undefined ? (
            <span className={styles.listItemMeta} aria-live="polite">
              Showing {items.length} of {total}
            </span>
          ) : undefined
        }
      >
        {isError ? (
          <div className={styles.errorState} role="alert">
            <span>Couldn't load your emails. {extractErrorMessage(error)}</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <EmailIntelligenceList
              items={items}
              isLoading={isLoading}
              emptyTitle={filtersActive ? 'No matching emails' : view === 'needs_response' ? "You're all caught up" : 'Nothing here yet'}
              emptyMessage={filtersActive ? 'No emails match your search or dates.' : EMPTY_MESSAGE[view]}
              celebrate={!filtersActive && view === 'needs_response'}
              onSelect={setSelected}
            />
            {filtersActive && items && items.length === 0 && (
              <div className={styles.listFooter}>
                <Button type="button" variant="secondary" size="sm" onClick={clearFilters}>
                  Clear search and dates
                </Button>
              </div>
            )}
            {hasNextPage && (
              <div className={styles.listFooter}>
                <Button type="button" variant="outline" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </SectionCard>

      <SectionCard title="Follow-ups" icon={FiClock}>
        <FollowUpsSection />
      </SectionCard>

      <EmailIntelligenceDetailModal
        open={!!selected}
        item={selected}
        onClose={() => setSelected(null)}
        onUpdated={applyUpdate}
      />

      <EmailSyncPreviewModal
        open={!!preview}
        preview={preview}
        syncing={syncing}
        onCancel={() => setPreview(null)}
        onConfirm={() => void handleConfirmSync()}
      />
    </div>
  );
}

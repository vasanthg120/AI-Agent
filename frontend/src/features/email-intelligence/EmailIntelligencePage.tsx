import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { getSocket } from '@/api/socketClient';
import { useAuthStore } from '@/stores/authStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { Button, ChoiceCards, Input, MultiSelectDropdown, PageHeader, SectionCard, Tabs } from '@/components/ui';
import type { ChoiceCardItem, DateRange } from '@/components/ui';
import {
  FiAlertCircle,
  FiCheckCircle,
  FiClock,
  FiCornerUpLeft,
  FiInbox,
  FiRefreshCw,
  FiSearch,
  FiSend,
} from 'react-icons/fi';
import { dayjs } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { isAiRoleAccount } from '@/utils/access';
import { ROUTES } from '@/constants/routes';
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
import { FollowUpAnalysisSection } from './components/FollowUpAnalysisSection';
import { FollowUpsSection } from './components/FollowUpsSection';
import { DRAFT_SUMMARY_KEY, ReplyAssistBar } from './components/ReplyAssistBar';
import { MailboxHistorySection } from './components/MailboxHistorySection';
import { RESPONSE_VIEW_LABEL } from './emailResponseLabels';
import styles from './email-intelligence.module.css';

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Anthropic', groq: 'Groq' };

const PAGE_SIZE = 25;
const QUERY_ROOT = 'email-intelligence-items';
const VIEWS: EmailResponseStatus[] = ['needs_response', 'responded', 'resolved'];
// How often an open inbox asks Outlook whether anything waiting has been answered.
const REPLY_CHECK_MS = 60_000;

type Section = 'inbox' | 'follow_ups' | 'history';

// The date filter as one compact control: the ranges people actually pick, plus a custom one.
type DatePreset = 'all' | 'today' | '7' | '30' | '90' | 'month' | 'custom';
const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'month', label: 'This month' },
  { value: 'custom', label: 'Custom range…' },
];
function presetRange(preset: DatePreset): DateRange {
  const today = dayjs();
  const day = (d: ReturnType<typeof dayjs>) => d.format('YYYY-MM-DD');
  if (preset === 'today') return { dateFrom: day(today), dateTo: day(today) };
  if (preset === 'month') return { dateFrom: day(today.startOf('month')), dateTo: day(today) };
  if (preset === '7' || preset === '30' || preset === '90')
    return { dateFrom: day(today.subtract(Number(preset) - 1, 'day')), dateTo: day(today) };
  return {};
}

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
const INTENT_FILTER_OPTIONS = EMAIL_INTELLIGENCE_INTENTS.map((intent) => ({
  value: intent,
  label: intentOptionLabel(intent),
}));

// AI Email Inbox. The tabs answer the question the inbox exists for — does this
// email still need a reply — using a state the BACKEND derives from what
// actually happened to the email (replied through the app, replied in Outlook,
// covered by a later reply in the thread), not from the AI draft's approval
// status. So an email leaves "Needs Response" the moment it is answered, stays
// out across refreshes, syncs and re-logins, and a failed send keeps it there.
export function EmailIntelligencePage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const currentUser = useAuthStore((state) => state.user);
  const [view, setView] = useState<EmailResponseStatus>('needs_response');
  const [intentFilter, setIntentFilter] = useState<string[]>([...RELEVANT_EMAIL_INTENTS]);
  const [range, setRange] = useState<DateRange>({});
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [section, setSection] = useState<Section>('inbox');
  const [search, setSearch] = useState('');
  // null = "automatic": most urgent first for the reply queue, newest first for
  // the history tabs, until the person picks an order themselves.
  const [sortChoice, setSortChoice] = useState<SortKey | null>(null);
  const [selected, setSelected] = useState<EmailIntelligenceItem | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [preview, setPreview] = useState<SyncPreviewResult | null>(null);

  // The mailbox owner's reply settings (shared with the reply assistant strip): does approving also send.
  const { data: draftSummary } = useQuery({
    queryKey: DRAFT_SUMMARY_KEY,
    queryFn: () => emailIntelligenceService.getDraftSummary(),
    staleTime: 30_000,
  });

  // When the mailbox was last synced (by anyone: a click, the background
  // sweep), and how many stored emails still wait for an AI reading.
  const { data: syncState } = useQuery({
    queryKey: [QUERY_ROOT, 'sync-state'],
    queryFn: () => emailIntelligenceService.syncState(),
    refetchInterval: 60_000,
  });

  // A reply typed in Outlook should show up here without anyone pressing Sync.
  // While this page is open and visible it asks the backend to look at Outlook's
  // Sent Items (no new mail is read, no AI is called), and refreshes the lists
  // the moment that finds something answered. The backend also does this on its
  // own every couple of minutes, so the state is right even before the page opens.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await emailIntelligenceService.refreshReplies();
        if (!cancelled && result.answered > 0) void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
      } catch {
        // A failed background check is silent: the lists still refresh on their own timer.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), REPLY_CHECK_MS);
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [queryClient]);

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
    queryFn: ({ pageParam }) =>
      emailIntelligenceService.list({ ...filters, view, sort, limit: PAGE_SIZE, skip: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (lastPage.length === PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined),
    refetchInterval: 60_000,
  });
  const items = useMemo(() => pages?.pages.flat(), [pages]);

  const { data: counts, isPlaceholderData: countsStale } = useQuery({
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
      queryClient.setQueryData<InfiniteData<EmailIntelligenceItem[], number>>(
        query.queryKey,
        (old) =>
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
        queryClient.setQueryData<EmailInboxCounts>(
          query.queryKey,
          (old) =>
            old && {
              ...old,
              [before]: Math.max(0, old[before] - 1),
              [updated.responseStatus]: old[updated.responseStatus] + 1,
            },
        );
      }
    }
    void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
    // A reply sent or a draft written changes what the reply assistant counts.
    void queryClient.invalidateQueries({ queryKey: DRAFT_SUMMARY_KEY });
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
      } else if (result.alreadyRunning) {
        toast('A sync of this mailbox is already running — it will finish shortly.');
      } else if ((result.deferredCount ?? 0) > 0) {
        // Stored and tracked, but the AI could not read them (usually: no credits left).
        toast(
          `Synced — ${result.newItemsCount} new email(s) added. ${result.deferredCount} could not be read by the AI yet and will be retried.`,
          { duration: 8_000 },
        );
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

  // New drafts were written in the background: show them.
  const refreshLists = useCallback(() => void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] }), [queryClient]);

  // Opens any stored email in the detail view (used by the follow-up analysis rows).
  const openEmail = async (emailId: string) => {
    try {
      setSelected(await emailIntelligenceService.getOne(emailId));
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  // Each queue card says what is inside it in a few words (the finer
  // categories the backend derives), so no separate breakdown line is needed.
  const categories = counts?.categories;
  const parts = (...items: [number | undefined, string][]) =>
    items
      .filter(([n]) => (n ?? 0) > 0)
      .map(([n, label]) => `${n} ${label}`)
      .join(' · ');
  const queueDescription: Record<EmailResponseStatus, ChoiceCardItem<EmailResponseStatus>['description']> = {
    needs_response: parts([categories?.urgent, 'urgent']) || VIEW_META.needs_response.description || '',
    responded:
      parts(
        [categories?.waiting_for_customer, 'waiting on customer'],
        [categories?.follow_up_required, 'need a follow-up'],
      ) ||
      VIEW_META.responded.description ||
      '',
    resolved:
      parts([categories?.informational, 'no reply needed'], [categories?.completed, 'closed']) ||
      VIEW_META.resolved.description ||
      '',
  };
  const queueCards: ChoiceCardItem<EmailResponseStatus>[] = VIEWS.map((id) => ({
    id,
    label: RESPONSE_VIEW_LABEL[id],
    count: counts?.[id],
    ...VIEW_META[id],
    description: queueDescription[id],
  }));
  // Hidden while the counts still belong to the previous filters, so the line
  // never pairs a fresh list with a stale total.
  const total = countsStale ? undefined : counts?.[view];
  const filtersActive = debouncedSearch !== '' || range.dateFrom !== undefined || range.dateTo !== undefined;
  const clearFilters = () => {
    setSearch('');
    setRange({});
    setDatePreset('all');
  };

  // Follow-ups that are due — shared with the Follow-ups tab (same query), shown as its count.
  const { data: followUps } = useQuery({
    queryKey: ['email-intelligence-follow-up-analysis'],
    queryFn: () => emailIntelligenceService.getFollowUpAnalysis(),
    refetchInterval: 120_000,
  });
  const followUpsDue = (followUps?.counts.follow_up_required ?? 0) + (followUps?.counts.overdue_follow_up ?? 0);
  const degradedProviders = (providerHealth ?? []).filter((p) => p.status === 'degraded');

  return (
    <div className={styles.page}>
      <PageHeader
        icon={FiInbox}
        title="AI Email Inbox"
        subtitle="Emails waiting for your reply, with drafts ready. Reply here or in Outlook — it is picked up automatically."
        meta={
          <>
            {(lastSyncedAt || syncState?.lastSyncedAt) && (
              <span className={styles.lastSynced}>
                <FiClock /> {syncState?.running ? 'Syncing now · last synced ' : 'Last synced '}
                {dayjs(lastSyncedAt ?? syncState?.lastSyncedAt).format('h:mm A')}
              </span>
            )}
            {(syncState?.awaitingAnalysis ?? 0) > 0 && (
              <span
                className={styles.lastSynced}
                title="These emails are stored and tracked. The AI will read them once it is available again (for example after credits are added)."
              >
                <FiAlertCircle /> {syncState?.awaitingAnalysis} not read by AI yet
              </span>
            )}
            {/* Only worth a mention when something is wrong. */}
            {degradedProviders.map((p) => (
              <span key={p.provider} className={styles.providerPill} title={p.lastError ?? undefined}>
                <span className={clsx(styles.providerDot, styles.providerDotDegraded)} />
                {PROVIDER_LABEL[p.provider] ?? p.provider} unavailable
              </span>
            ))}
          </>
        }
        actions={
          <>
            {/* Team members connect their own mailbox here (admins have Settings → Integrations). */}
            {isAiRoleAccount(currentUser) && (
              <Button type="button" variant="secondary" onClick={() => navigate(ROUTES.integrations)}>
                Connect mailbox
              </Button>
            )}
            <Button
              type="button"
              leftIcon={<FiRefreshCw />}
              loading={previewing}
              onClick={() => void handleOpenSyncPreview()}
            >
              Sync Inbox
            </Button>
          </>
        }
      />

      <Tabs
        items={[
          { id: 'inbox', label: 'Inbox', icon: <FiInbox /> },
          {
            id: 'follow_ups',
            label: followUpsDue > 0 ? `Follow-ups (${followUpsDue})` : 'Follow-ups',
            icon: <FiClock />,
          },
          { id: 'history', label: 'Sent & history', icon: <FiSend /> },
        ]}
        activeId={section}
        onChange={(id) => setSection(id as Section)}
      />

      {section === 'inbox' && (
        <>
          <ChoiceCards ariaLabel="Email queue" items={queueCards} activeId={view} onChange={setView} />

          <ReplyAssistBar onDrafted={refreshLists} />

          <div className={styles.filterBar}>
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
            <select
              className={styles.select}
              aria-label="Date range"
              value={datePreset}
              onChange={(e) => {
                const preset = e.target.value as DatePreset;
                setDatePreset(preset);
                if (preset !== 'custom') setRange(presetRange(preset));
              }}
            >
              {DATE_PRESETS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {datePreset === 'custom' && (
              <>
                <input
                  type="date"
                  className={styles.select}
                  aria-label="From date"
                  value={range.dateFrom ?? ''}
                  max={range.dateTo}
                  onChange={(e) => setRange((r) => ({ ...r, dateFrom: e.target.value || undefined }))}
                />
                <input
                  type="date"
                  className={styles.select}
                  aria-label="To date"
                  value={range.dateTo ?? ''}
                  min={range.dateFrom}
                  onChange={(e) => setRange((r) => ({ ...r, dateTo: e.target.value || undefined }))}
                />
              </>
            )}
            <MultiSelectDropdown
              label="Mail Type"
              options={INTENT_FILTER_OPTIONS}
              selected={intentFilter}
              onChange={setIntentFilter}
            />
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
            {items && total !== undefined && (
              <span className={clsx(styles.listItemMeta, styles.filterCount)} aria-live="polite">
                {items.length} of {total}
              </span>
            )}
          </div>

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
                emptyTitle={
                  filtersActive
                    ? 'No matching emails'
                    : view === 'needs_response'
                      ? "You're all caught up"
                      : 'Nothing here yet'
                }
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
                  <Button
                    type="button"
                    variant="outline"
                    loading={isFetchingNextPage}
                    onClick={() => void fetchNextPage()}
                  >
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {section === 'follow_ups' && (
        <>
          <FollowUpAnalysisSection onOpenEmail={(emailId) => void openEmail(emailId)} />
          <SectionCard title="Follow-up drafts and reminders" icon={FiClock}>
            <FollowUpsSection />
          </SectionCard>
        </>
      )}

      {section === 'history' && (
        <SectionCard title="Sent mail & mailbox history" icon={FiSend}>
          <MailboxHistorySection onImported={() => void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] })} />
        </SectionCard>
      )}

      <EmailIntelligenceDetailModal
        open={!!selected}
        item={selected}
        sendOnApprove={draftSummary?.settings.sendOnApprove ?? true}
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

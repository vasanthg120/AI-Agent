import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { getSocket } from '@/api/socketClient';
import { useAuthStore } from '@/stores/authStore';
import { Button, DateRangeControl, MultiSelectDropdown, SectionCard, Tabs } from '@/components/ui';
import type { DateRange } from '@/components/ui';
import { FiClock, FiInbox, FiRefreshCw } from 'react-icons/fi';
import { dayjs } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import {
  EMAIL_INTELLIGENCE_INTENTS,
  emailIntelligenceService,
  RELEVANT_EMAIL_INTENTS,
  type EmailIntelligenceItem,
  type SyncPreviewResult,
} from '@/services/emailIntelligenceService';
import { EmailIntelligenceList } from './components/EmailIntelligenceList';
import { EmailIntelligenceDetailModal } from './components/EmailIntelligenceDetailModal';
import { EmailSyncPreviewModal } from './components/EmailSyncPreviewModal';
import { FollowUpsSection } from './components/FollowUpsSection';
import styles from './email-intelligence.module.css';

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Anthropic', groq: 'Groq' };

const STATUS_TABS = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
];

function intentOptionLabel(intent: string): string {
  return intent
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// One real, visible filter control instead of the old unlabeled "Relevant/
// All" tab pair — same underlying allow-list as the previous default
// (customer/enquiry/vendor-type mail), but now user-adjustable per intent
// rather than a fixed binary. An empty selection means "no filter" (show
// everything), matching every other MultiSelectDropdown filter in this app
// (Deal Performance/Finance/Timeline) — never "show nothing".
const INTENT_FILTER_OPTIONS = EMAIL_INTELLIGENCE_INTENTS.map((intent) => ({ value: intent, label: intentOptionLabel(intent) }));

export function EmailIntelligencePage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [intentFilter, setIntentFilter] = useState<string[]>([...RELEVANT_EMAIL_INTENTS]);
  const [range, setRange] = useState<DateRange>({});
  const [selected, setSelected] = useState<EmailIntelligenceItem | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [preview, setPreview] = useState<SyncPreviewResult | null>(null);

  // Date range is applied server-side (real receivedAt filtering, not just
  // hiding rows from an already-fetched page); Mail Type stays client-side
  // over that date-bounded set, same split TimelinePage.tsx already uses.
  const { data, isLoading } = useQuery({
    queryKey: ['email-intelligence-items', status, range],
    queryFn: () => emailIntelligenceService.list(status, { from: range.dateFrom, to: range.dateTo }),
    refetchInterval: 60_000,
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

  const visibleItems = data?.filter((item) => intentFilter.length === 0 || intentFilter.includes(item.intent));

  // Arrived here from a notification click (see
  // frontend/src/utils/notificationTarget.ts) — fetched directly by id
  // rather than found in `data` above, since the target email may not be
  // in whichever status tab happens to be selected (e.g. it could already
  // be approved while this page defaults to the Pending tab). Independent
  // of the tab-scoped list query, so it opens immediately without waiting
  // on or being limited by that query's status filter.
  useEffect(() => {
    const openEmailId = searchParams.get('openEmailId');
    if (!openEmailId) return;
    emailIntelligenceService
      .getOne(openEmailId)
      .then(setSelected)
      .catch((error) => toast.error(extractErrorMessage(error)));
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('openEmailId');
      return next;
    }, { replace: true });
  }, [searchParams]);

  // The only place this page spends an LLM call — nothing runs in the
  // background anymore (see emailIntelligenceService.sync's own comment).
  // "Last synced" is client-only/session-only, not persisted, since it's
  // purely a UX nicety telling the user their click actually did something.
  // Phase 21 follow-up: the cheap, LLM-free preview now opens a real modal
  // (EmailSyncPreviewModal) showing the full breakdown + a real token
  // estimate instead of a one-line window.confirm, and is skipped entirely
  // when there's genuinely nothing new to process.
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
        void queryClient.invalidateQueries({ queryKey: ['email-intelligence-items'] });
      } else {
        toast.success('Synced — no new mail since last sync.');
      }
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
        void queryClient.invalidateQueries({ queryKey: ['email-intelligence-items'] });
      }
    };
    socket.on('notification', handler);
    return () => {
      socket.off('notification', handler);
    };
  }, [queryClient]);

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.pageTitle}>AI Email Inbox</div>
          <div className={styles.pageSubtitle}>
            Your connected mailbox syncs automatically every 30 minutes — hit Sync for an immediate check. Review,
            edit, and approve AI-drafted replies here.
          </div>
          {providerHealth && providerHealth.length > 0 && (
            <div className={styles.providerHealthRow}>
              {providerHealth.map((p) => (
                <span key={p.provider} className={styles.providerPill} title={p.lastError ?? undefined}>
                  <span
                    className={clsx(
                      styles.providerDot,
                      p.status === 'available' && styles.providerDotAvailable,
                      p.status === 'degraded' && styles.providerDotDegraded,
                    )}
                  />
                  {PROVIDER_LABEL[p.provider] ?? p.provider}
                  {p.status === 'degraded' ? ' unavailable' : p.status === 'unknown' ? ' status unknown' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className={styles.headerActions}>
          {lastSyncedAt && <span className={styles.lastSynced}>Last synced {dayjs(lastSyncedAt).format('h:mm A')}</span>}
          <Button type="button" leftIcon={<FiRefreshCw />} loading={previewing} onClick={() => void handleOpenSyncPreview()}>
            Sync Inbox
          </Button>
        </div>
      </div>

      <div className={styles.tabBar}>
        <Tabs items={STATUS_TABS} activeId={status} onChange={(id) => setStatus(id as typeof status)} />
      </div>

      <div className={styles.filterRow}>
        <DateRangeControl value={range} onChange={setRange} />
        <MultiSelectDropdown label="Mail Type" options={INTENT_FILTER_OPTIONS} selected={intentFilter} onChange={setIntentFilter} />
      </div>

      <SectionCard
        title="Email Queue"
        icon={FiInbox}
        action={
          <span className={styles.listItemMeta}>
            Sorted by what needs a reply soonest
            {data && visibleItems && data.length > visibleItems.length ? ` · ${visibleItems.length} of ${data.length} shown` : ''}
          </span>
        }
      >
        <EmailIntelligenceList items={visibleItems} isLoading={isLoading} onSelect={setSelected} />
      </SectionCard>

      <SectionCard title="Follow-ups" icon={FiClock}>
        <FollowUpsSection />
      </SectionCard>

      <EmailIntelligenceDetailModal
        open={!!selected}
        item={selected}
        onClose={() => setSelected(null)}
        onUpdated={(updated) => {
          // Keep the open modal showing the fresh item immediately (e.g. a
          // newly-set sentAt/sendError after Send) rather than stale data
          // until it's closed and reopened, on top of invalidating the list.
          setSelected(updated);
          void queryClient.invalidateQueries({ queryKey: ['email-intelligence-items'] });
        }}
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

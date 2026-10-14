import { useState } from 'react';
import toast from 'react-hot-toast';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { FiDownloadCloud, FiSearch, FiSend } from 'react-icons/fi';
import { Button, EmptyState, Input, Skeleton } from '@/components/ui';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { emailIntelligenceService } from '@/services/emailIntelligenceService';
import { dayjs } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import styles from '../email-intelligence.module.css';

const RANGES = [
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 3 months' },
  { days: 180, label: 'Last 6 months' },
  { days: 365, label: 'Last year' },
  { days: 730, label: 'Last 2 years' },
];
const PAGE_SIZE = 20;

// Older mail and sent mail. The regular sync only reads recent inbox mail;
// this loads the mailbox's history from Outlook — inbox and Sent Items — and
// works out from each thread whether it was answered. No AI credits are used.
export function MailboxHistorySection({ onImported }: { onImported: () => void }) {
  const queryClient = useQueryClient();
  const [days, setDays] = useState(90);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data: status } = useQuery({
    queryKey: ['email-intelligence-history-status'],
    queryFn: () => emailIntelligenceService.getHistoryStatus(),
  });
  const {
    data: sent,
    isLoading,
    isError,
    error,
    isFetching,
  } = useQuery({
    queryKey: ['email-intelligence-sent', debouncedSearch, limit],
    queryFn: () => emailIntelligenceService.listSent({ search: debouncedSearch, limit }),
    placeholderData: keepPreviousData,
  });

  const load = async () => {
    setImporting(true);
    try {
      const result = await emailIntelligenceService.importHistory(days);
      if (!result.connected) {
        toast.error('Outlook is not connected — connect it in Integrations to load your mailbox history.');
        return;
      }
      toast.success(
        `Loaded ${result.inboxAdded.toLocaleString()} older inbox email${result.inboxAdded === 1 ? '' : 's'} and ${result.sentAdded.toLocaleString()} sent. ${result.markedResponded.toLocaleString()} matched to a reply.`,
        { duration: 8_000 },
      );
      if (result.truncated) {
        toast(
          'That range holds more mail than one load reads — the newest part was loaded. Pick a shorter range to fill in the rest.',
          {
            duration: 10_000,
          },
        );
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['email-intelligence-history-status'] }),
        queryClient.invalidateQueries({ queryKey: ['email-intelligence-sent'] }),
        queryClient.invalidateQueries({ queryKey: ['email-intelligence-follow-up-analysis'] }),
        queryClient.invalidateQueries({ queryKey: ['email-intelligence-follow-ups'] }),
      ]);
      onImported();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className={styles.formGrid}>
      <div className={styles.historyBar}>
        <div className={styles.listItemMain}>
          <span className={styles.listItemTitle}>Mailbox history</span>
          <span className={styles.listItemMeta}>
            {status
              ? status.inboxCount + status.sentCount === 0
                ? 'No mail loaded yet.'
                : `${status.inboxCount.toLocaleString()} inbox and ${status.sentCount.toLocaleString()} sent emails${
                    status.oldestInboxAt ? `, back to ${dayjs(status.oldestInboxAt).format('D MMM YYYY')}` : ''
                  }.`
              : 'Checking what’s loaded…'}{' '}
            Loading older mail uses no AI credits.
          </span>
        </div>
        <div className={styles.badgeRow}>
          <select
            className={styles.select}
            aria-label="How far back to load"
            value={days}
            disabled={importing}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="secondary"
            leftIcon={<FiDownloadCloud />}
            loading={importing}
            onClick={() => void load()}
          >
            {importing ? 'Loading… this can take a few minutes' : 'Load older mail'}
          </Button>
        </div>
      </div>

      <div className={styles.searchBox}>
        <Input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(PAGE_SIZE);
          }}
          placeholder="Search sent mail by subject or recipient"
          aria-label="Search sent mail"
          leftIcon={<FiSearch />}
        />
      </div>

      {isLoading ? (
        <Skeleton height={120} />
      ) : isError ? (
        <div className={styles.errorState} role="alert">
          <span>Couldn’t load sent mail. {extractErrorMessage(error)}</span>
        </div>
      ) : !sent || sent.items.length === 0 ? (
        <EmptyState
          compact
          icon={FiSend}
          title={debouncedSearch ? 'No sent mail matches' : 'No sent mail loaded yet'}
          description={
            debouncedSearch
              ? 'Try a different subject or recipient.'
              : 'Sent mail appears here after the next sync, or load older mail above.'
          }
        />
      ) : (
        <>
          <div aria-busy={isFetching}>
            {sent.items.map((mail) => (
              <div key={mail.id} className={styles.sentRow}>
                <div className={styles.listItemMain}>
                  <span className={styles.listItemTitle}>{mail.subject || '(no subject)'}</span>
                  <span className={styles.listItemMeta}>
                    To {mail.to.slice(0, 3).join(', ') || 'unknown recipient'}
                    {mail.to.length > 3 ? ` +${mail.to.length - 3}` : ''}
                  </span>
                  {mail.preview && <span className={styles.sentPreview}>{mail.preview}</span>}
                </div>
                <span className={styles.listItemMeta}>{dayjs(mail.sentAt).format('D MMM YYYY, h:mm A')}</span>
              </div>
            ))}
          </div>
          <div className={styles.listFooter}>
            <span className={styles.listItemMeta}>
              Showing {sent.items.length} of {sent.total.toLocaleString()}
            </span>
            {sent.items.length < sent.total && limit < 100 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLimit((l) => Math.min(l + PAGE_SIZE, 100))}
              >
                Show more
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

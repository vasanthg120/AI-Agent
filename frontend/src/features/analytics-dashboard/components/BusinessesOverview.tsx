import { useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { FiAlertOctagon, FiAlertTriangle, FiArrowRight, FiCheckCircle, FiGrid, FiInfo } from 'react-icons/fi';
import { Button, EmptyState, SectionCard, Skeleton } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useAuthStore } from '@/stores/authStore';
import { formatAmountIn } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import {
  businessesOverviewService,
  type AttentionItem,
  type BusinessHealthItem,
  type BusinessListKind,
  type BusinessOverviewRow,
  type BusinessesOverview as Overview,
} from '@/services/businessesOverviewService';
import { formatTalkTime, type CallFilter, type TeamListKind } from '@/services/teamActivityService';
import { ActivityListModal } from '@/features/team-activity/ActivityList';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import styles from './BusinessesOverview.module.css';

// The Main Account owner's Dashboard, first tab: every business side by side —
// revenue, deals, pipeline, quotations, emails waiting, calls, and whether its
// mailboxes and CRM are syncing — each in its own currency, counted as its own
// Dashboard counts it. Every number opens the records behind it, from every
// business at once; "Open" switches into one business to work there.

type ListTarget =
  | { source: 'business'; kind: BusinessListKind; organizationId: string; title: string }
  | { source: 'activity'; kind: TeamListKind; organizationId: string; callFilter?: CallFilter; subtitle?: string };

const ALL = 'all';
// Lines of “Needs your attention” shown before “Show all”, so the businesses stay in view.
const ATTENTION_SHOWN = 3;

/** "Fully Promoted T.Nagar" → "T.Nagar" when every business shares the first words. */
function shortNames(names: string[]): (name: string) => string {
  if (names.length < 2) return (n) => n;
  const words = names.map((n) => n.split(/\s+/));
  let shared = 0;
  while (words.every((w) => w.length > shared + 1 && w[shared].toLowerCase() === words[0][shared].toLowerCase())) shared += 1;
  return (n) => (shared ? n.split(/\s+/).slice(shared).join(' ') : n);
}

const whole = (value: number, currency: string) => formatAmountIn(Math.round(value), currency);

function healthSummary(health: BusinessHealthItem[]): { tone: 'ok' | 'warning' | 'danger' | 'muted'; text: string; detail: string } {
  if (health.length === 0) return { tone: 'muted', text: 'Nothing connected', detail: 'No mailbox or CRM is connected to this business.' };
  const detail = health
    .map((h) => {
      const what = h.kind === 'mailbox' ? `Mailbox ${h.label}` : h.label;
      if (h.status === 'ok') return `${what}: syncing${h.lastOkAt ? ` (last ${dayjs(h.lastOkAt).format('D MMM, h:mm a')})` : ''}`;
      if (h.status === 'never') return `${what}: never synced yet`;
      if (h.status === 'reconnect') return `${what}: needs connecting again`;
      if (h.status === 'stale') return `${what}: last synced ${h.lastOkAt ? dayjs(h.lastOkAt).format('D MMM, h:mm a') : 'a while ago'}`;
      return `${what}: failing${h.reason ? ` — ${h.reason}` : ''}`;
    })
    .join('\n');
  const broken = health.filter((h) => h.status === 'failing' || h.status === 'reconnect');
  if (broken.length) {
    const mailbox = broken.some((h) => h.kind === 'mailbox');
    const crm = broken.some((h) => h.kind === 'crm');
    return { tone: 'danger', text: mailbox && crm ? 'Mail & CRM stopped' : mailbox ? 'Mailbox stopped' : 'CRM sync failing', detail };
  }
  if (health.some((h) => h.status === 'stale' || h.status === 'never')) return { tone: 'warning', text: 'Sync is late', detail };
  return { tone: 'ok', text: 'All syncing', detail };
}

/** A number that opens the records behind it. */
function Figure({ children, onClick, label, tone }: { children: ReactNode; onClick?: () => void; label: string; tone?: 'warning' | 'danger' | 'muted' }) {
  if (!onClick) return <span className={clsx(styles.figure, tone && styles[`tone_${tone}`])}>{children}</span>;
  return (
    <button type="button" className={clsx(styles.figure, styles.figureButton, tone && styles[`tone_${tone}`])} onClick={onClick} aria-label={label} title={label}>
      {children}
    </button>
  );
}

const SEVERITY_ICON = { critical: FiAlertOctagon, warning: FiAlertTriangle, info: FiInfo } as const;

export function BusinessesOverview({ dateFrom, dateTo, onOpenCurrent }: { dateFrom: string; dateTo: string; onOpenCurrent: () => void }) {
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const [target, setTarget] = useState<ListTarget | null>(null);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ['businesses-overview', dateFrom, dateTo],
    queryFn: () => businessesOverviewService.overview(dateFrom, dateTo),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const short = useMemo(() => shortNames((data?.businesses ?? []).map((b) => b.name)), [data?.businesses]);
  const nameOf = (id: string) => (id === ALL ? 'all businesses' : short(data?.businesses.find((b) => b.id === id)?.name ?? ''));

  const businessTarget = target?.source === 'business' ? target : null;
  const { data: list, isLoading: listLoading } = useQuery({
    queryKey: ['businesses-overview-list', businessTarget?.kind, businessTarget?.organizationId, dateFrom, dateTo],
    queryFn: () => businessesOverviewService.list(businessTarget!.kind, dateFrom, dateTo, businessTarget!.organizationId),
    enabled: !!businessTarget,
  });
  const rows: DrillDownRow[] = useMemo(
    () =>
      (list?.items ?? []).map((r) => {
        const many = businessTarget?.organizationId === ALL;
        return {
          id: `${r.businessId}:${r.id}`,
          title: r.title,
          // Across businesses the chip says whose it is; the status moves into the line under it.
          subtitle: many ? short(r.businessName) : r.subtitle,
          meta: many && r.subtitle ? `${r.subtitle} · ${r.meta ?? ''}` : r.meta,
          note: r.note,
          value: r.value,
          currency: r.currency,
          dealId: r.dealId,
        };
      }),
    [list, businessTarget?.organizationId, short],
  );

  const open = (kind: BusinessListKind, organizationId: string, what: string) =>
    setTarget({ source: 'business', kind, organizationId, title: `${what} · ${nameOf(organizationId)}` });
  const openActivity = (kind: TeamListKind, organizationId: string, callFilter?: CallFilter) =>
    setTarget({ source: 'activity', kind, organizationId, callFilter, subtitle: organizationId === ALL ? 'Every business' : nameOf(organizationId) });

  const openAttention = (item: AttentionItem) => {
    if (!item.list) return;
    if (item.list === 'missed_calls') return openActivity('calls', item.businessId, 'missed');
    const titles: Record<BusinessListKind, string> = {
      won: 'Won deals',
      lost: 'Lost deals',
      open: 'Open deals',
      pipeline: 'Open pipeline',
      past_due: 'Open deals past the closing date',
      quotes: 'Quotations',
      quotes_accepted: 'Accepted quotations',
      emails_waiting: 'Emails waiting for a reply',
      emails_overdue: 'Emails waiting over 24 hours',
      new_enquiries: 'New enquiries waiting',
    };
    open(item.list, item.businessId, titles[item.list]);
  };

  const enter = async (business: BusinessOverviewRow) => {
    setEntering(business.id);
    try {
      // Reloads the app into that business when it succeeds.
      await switchAccount(business.id, ROUTES.dashboard);
    } catch (err) {
      toast.error(extractErrorMessage(err));
      setEntering(null);
    }
  };

  if (isLoading) {
    return (
      <div className={styles.stack}>
        <Skeleton height={96} />
        <Skeleton height={260} />
      </div>
    );
  }
  if (isError || !data) {
    return <EmptyState icon={FiAlertTriangle} title="Your businesses couldn’t be loaded" description="Please try again in a moment." />;
  }

  const attention = showAllAttention ? data.attention : data.attention.slice(0, ATTENTION_SHOWN);
  const periodNote = describePeriod(data);

  return (
    <div className={clsx(styles.stack, isFetching && styles.fading)}>
      {data.attention.length > 0 ? (
        <SectionCard title={`Needs your attention · ${data.attention.length}`} icon={FiAlertTriangle} glass>
          <ul className={styles.attention}>
            {attention.map((item, i) => {
              const Icon = SEVERITY_ICON[item.severity];
              const body = (
                <>
                  <Icon className={clsx(styles.attentionIcon, styles[`sev_${item.severity}`])} aria-hidden />
                  <span className={styles.attentionText}>
                    <strong>{short(item.businessName)}</strong> — {item.text}
                  </span>
                  {item.list && <FiArrowRight className={styles.attentionGo} aria-hidden />}
                </>
              );
              return (
                <li key={`${item.businessId}-${i}`}>
                  {item.list ? (
                    <button type="button" className={clsx(styles.attentionRow, styles.attentionButton)} onClick={() => openAttention(item)}>
                      {body}
                    </button>
                  ) : (
                    <div className={styles.attentionRow}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
          {data.attention.length > ATTENTION_SHOWN && (
            <button type="button" className={styles.more} onClick={() => setShowAllAttention((v) => !v)}>
              {showAllAttention ? 'Show fewer' : `Show all ${data.attention.length}`}
            </button>
          )}
        </SectionCard>
      ) : (
        <div className={styles.allClear} role="status">
          <FiCheckCircle aria-hidden /> Nothing needs your attention in any business right now.
        </div>
      )}

      <SectionCard title={`Your businesses · ${data.businesses.length}`} icon={FiGrid} glass>
        <p className={styles.note}>{periodNote}</p>
        <Totals data={data} onOpen={open} onOpenActivity={openActivity} />

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Business</th>
                <th className={styles.num}>Revenue</th>
                <th className={styles.num}>Won / lost</th>
                <th className={styles.num}>Open pipeline</th>
                <th className={styles.num}>Quotations</th>
                <th className={styles.num}>Emails waiting</th>
                <th className={styles.num}>Calls</th>
                <th>Sync</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {data.businesses.map((b) => (
                <BusinessRow key={b.id} b={b} name={short(b.name)} entering={entering === b.id} onOpen={open} onOpenActivity={openActivity} onEnter={enter} onOpenCurrent={onOpenCurrent} />
              ))}
            </tbody>
          </table>
        </div>

        <ul className={styles.cards}>
          {data.businesses.map((b) => (
            <BusinessCard key={b.id} b={b} name={short(b.name)} entering={entering === b.id} onOpen={open} onOpenActivity={openActivity} onEnter={enter} onOpenCurrent={onOpenCurrent} />
          ))}
        </ul>
      </SectionCard>

      <DrillDownModal
        open={target?.source === 'business'}
        onClose={() => setTarget(null)}
        title={businessTarget?.title ?? ''}
        isLoading={listLoading}
        rows={rows}
        totalCount={list?.total}
      />
      <ActivityListModal
        kind={target?.source === 'activity' ? target.kind : null}
        onClose={() => setTarget(null)}
        period={{ period: 'custom', from: dateFrom, to: dateTo }}
        filters={target?.source === 'activity' ? { organizationId: target.organizationId, callFilter: target.callFilter } : {}}
        showPerson
        subtitle={target?.source === 'activity' ? target.subtitle : undefined}
      />
    </div>
  );
}

function describePeriod(data: Overview): string {
  const months =
    data.months.first === data.months.last
      ? dayjs(`${data.months.first}-01`).format('MMMM YYYY')
      : `${dayjs(`${data.months.first}-01`).format('MMM YYYY')} – ${dayjs(`${data.months.last}-01`).format('MMM YYYY')}`;
  const days = `${dayjs(data.dateFrom).format('D MMM')} – ${dayjs(data.dateTo).format('D MMM')}`;
  return `Revenue, deals and targets: ${months}, by expected closing date, as each business’s own Dashboard. Quotations, calls and replies: ${days}. Emails waiting and open pipeline: right now. Each business in its own currency — click any number for the records behind it.`;
}

type OpenList = (kind: BusinessListKind, organizationId: string, what: string) => void;
type OpenActivity = (kind: TeamListKind, organizationId: string, callFilter?: CallFilter) => void;

function Totals({ data, onOpen, onOpenActivity }: { data: Overview; onOpen: OpenList; onOpenActivity: OpenActivity }) {
  const { totals } = data;
  const perCurrency = (pick: (t: Overview['totals']['byCurrency'][number]) => number) =>
    totals.byCurrency.map((t) => whole(pick(t), t.currency)).join(' · ');
  const pipelineDeals = totals.byCurrency.reduce((s, t) => s + t.pipeline.count, 0);
  const pastDue = totals.byCurrency.reduce((s, t) => s + t.pastDue.count, 0);
  const items = [
    { label: 'Revenue won', value: perCurrency((t) => t.revenue), sub: `${totals.deals.won} deal${totals.deals.won === 1 ? '' : 's'} won`, open: () => onOpen('won', ALL, 'Won deals') },
    {
      label: 'Open pipeline',
      value: perCurrency((t) => t.pipeline.value),
      sub: `${pipelineDeals} deals${pastDue ? ` · ${pastDue} past due` : ''}`,
      open: () => onOpen('pipeline', ALL, 'Open pipeline'),
    },
    {
      label: 'Emails waiting',
      value: String(totals.emails.waiting),
      sub: totals.emails.overdue ? `${totals.emails.overdue} over 24 hours` : 'none over 24 hours',
      open: () => onOpen('emails_waiting', ALL, 'Emails waiting for a reply'),
      tone: totals.emails.overdue ? ('warning' as const) : undefined,
    },
    {
      label: 'Calls',
      value: String(totals.calls.total),
      sub: `${totals.calls.missed} missed · ${formatTalkTime(totals.calls.talkSeconds)} talk`,
      open: () => onOpenActivity('calls', ALL),
    },
  ];
  return (
    <div className={styles.totals}>
      {items.map((item) => (
        <button key={item.label} type="button" className={styles.total} onClick={item.open} title={`See every business’s ${item.label.toLowerCase()}`}>
          <span className={styles.totalLabel}>{item.label}</span>
          <span className={clsx(styles.totalValue, item.tone && styles[`tone_${item.tone}`])}>{item.value}</span>
          <span className={styles.totalSub}>{item.sub}</span>
        </button>
      ))}
    </div>
  );
}

interface RowProps {
  b: BusinessOverviewRow;
  name: string;
  entering: boolean;
  onOpen: OpenList;
  onOpenActivity: OpenActivity;
  onEnter: (b: BusinessOverviewRow) => void;
  onOpenCurrent: () => void;
}

/** The figures of one business, shared by the table row and the phone card. */
function figuresOf({ b, onOpen, onOpenActivity }: Pick<RowProps, 'b' | 'onOpen' | 'onOpenActivity'>) {
  const cur = b.currency;
  const target =
    b.revenue.target === null ? 'No target set' : `${b.revenue.pct ?? 0}% of ${whole(b.revenue.target, cur)}`;
  return {
    revenue: (
      <>
        <Figure onClick={() => onOpen('won', b.id, 'Won deals')} label={`${b.name}: won deals`} tone={b.revenue.achieved ? undefined : 'muted'}>
          {whole(b.revenue.achieved, cur)}
        </Figure>
        <span className={styles.sub}>{target}</span>
      </>
    ),
    deals: (
      <>
        <span className={styles.pair}>
          <Figure onClick={() => onOpen('won', b.id, 'Won deals')} label={`${b.name}: won deals`} tone={b.deals.won.count ? undefined : 'muted'}>
            {b.deals.won.count}
          </Figure>
          <span className={styles.slash}>/</span>
          <Figure onClick={() => onOpen('lost', b.id, 'Lost deals')} label={`${b.name}: lost deals`} tone={b.deals.lost.count ? undefined : 'muted'}>
            {b.deals.lost.count}
          </Figure>
        </span>
        <span className={styles.sub}>{b.deals.winRatePct === null ? 'none closed' : `${b.deals.winRatePct}% won`}</span>
      </>
    ),
    pipeline: (
      <>
        <Figure onClick={() => onOpen('pipeline', b.id, 'Open pipeline')} label={`${b.name}: open pipeline`} tone={b.pipeline.open.count ? undefined : 'muted'}>
          {whole(b.pipeline.open.value, cur)}
        </Figure>
        <span className={styles.sub}>
          {b.pipeline.open.count} deal{b.pipeline.open.count === 1 ? '' : 's'}
          {b.pipeline.pastDue.count > 0 && (
            <>
              {' · '}
              <button type="button" className={clsx(styles.subButton, styles.tone_warning)} onClick={() => onOpen('past_due', b.id, 'Open deals past the closing date')}>
                {b.pipeline.pastDue.count} past due
              </button>
            </>
          )}
        </span>
      </>
    ),
    quotes: (
      <>
        <Figure onClick={() => onOpen('quotes', b.id, 'Quotations')} label={`${b.name}: quotations`} tone={b.quotes.created.count ? undefined : 'muted'}>
          {b.quotes.created.count}
        </Figure>
        <span className={styles.sub}>
          {b.quotes.accepted.count > 0 ? (
            <button type="button" className={styles.subButton} onClick={() => onOpen('quotes_accepted', b.id, 'Accepted quotations')}>
              {b.quotes.accepted.count} accepted
            </button>
          ) : (
            'none accepted'
          )}
        </span>
      </>
    ),
    emails: (
      <>
        <Figure
          onClick={() => onOpen('emails_waiting', b.id, 'Emails waiting for a reply')}
          label={`${b.name}: emails waiting for a reply`}
          tone={b.emails.overdue ? 'warning' : b.emails.waiting ? undefined : 'muted'}
        >
          {b.emails.waiting}
        </Figure>
        <span className={styles.sub}>
          {b.emails.overdue ? `${b.emails.overdue} over 24 h` : 'none late'}
          {b.emails.replied ? (
            <>
              {' · '}
              <button type="button" className={styles.subButton} onClick={() => onOpenActivity('emails_replied', b.id)}>
                {b.emails.replied} replied
              </button>
            </>
          ) : null}
        </span>
      </>
    ),
    calls: b.calls ? (
      <>
        <Figure onClick={() => onOpenActivity('calls', b.id)} label={`${b.name}: calls`} tone={b.calls.total ? undefined : 'muted'}>
          {b.calls.total}
        </Figure>
        <span className={styles.sub}>
          {b.calls.missed > 0 ? (
            <button type="button" className={clsx(styles.subButton, styles.tone_warning)} onClick={() => onOpenActivity('calls', b.id, 'missed')}>
              {b.calls.missed} missed
            </button>
          ) : (
            'none missed'
          )}
          {b.calls.avgScore !== null ? ` · ${b.calls.avgScore}/10` : ''}
        </span>
      </>
    ) : (
      <span className={styles.sub} title="Choose a range of a year or less to see calls.">
        —
      </span>
    ),
  };
}

function SyncStatus({ b }: { b: BusinessOverviewRow }) {
  const h = healthSummary(b.health);
  return (
    <span className={clsx(styles.sync, styles[`sync_${h.tone}`])} title={h.detail}>
      <span className={styles.dot} aria-hidden />
      {b.locked ? 'Locked — no plan' : h.text}
    </span>
  );
}

function EnterButton({ b, name, entering, onEnter, onOpenCurrent }: Pick<RowProps, 'b' | 'name' | 'entering' | 'onEnter' | 'onOpenCurrent'>) {
  if (b.isCurrent)
    return (
      <Button size="sm" variant="ghost" onClick={onOpenCurrent} title="This account — its own figures are in the other tabs">
        Details
      </Button>
    );
  return (
    <Button size="sm" variant="secondary" loading={entering} onClick={() => onEnter(b)} title={`Switch into ${name} to work there`} rightIcon={<FiArrowRight aria-hidden />}>
      Open
    </Button>
  );
}

function BusinessRow(props: RowProps) {
  const { b, name } = props;
  const f = figuresOf(props);
  return (
    <tr className={clsx(b.locked && styles.locked)}>
      <td>
        <span className={styles.business}>
          <span className={styles.businessName} title={b.name}>
            {name}
          </span>
          <span className={styles.sub}>{b.isMain ? 'Main Account' : 'Sub-account'}</span>
        </span>
      </td>
      <td className={styles.num}>{f.revenue}</td>
      <td className={styles.num}>{f.deals}</td>
      <td className={styles.num}>{f.pipeline}</td>
      <td className={styles.num}>{f.quotes}</td>
      <td className={styles.num}>{f.emails}</td>
      <td className={styles.num}>{f.calls}</td>
      <td>
        <SyncStatus b={b} />
      </td>
      <td className={styles.action}>
        <EnterButton {...props} />
      </td>
    </tr>
  );
}

function BusinessCard(props: RowProps) {
  const { b, name } = props;
  const f = figuresOf(props);
  const cells: [string, ReactNode][] = [
    ['Revenue', f.revenue],
    ['Won / lost', f.deals],
    ['Open pipeline', f.pipeline],
    ['Quotations', f.quotes],
    ['Emails waiting', f.emails],
    ['Calls', f.calls],
  ];
  return (
    <li className={clsx(styles.card, b.locked && styles.locked)}>
      <div className={styles.cardHead}>
        <span className={styles.business}>
          <span className={styles.businessName} title={b.name}>
            {name}
          </span>
          <span className={styles.sub}>{b.isMain ? 'Main Account' : 'Sub-account'}</span>
        </span>
        <EnterButton {...props} />
      </div>
      <div className={styles.cardGrid}>
        {cells.map(([label, content]) => (
          <div key={label} className={styles.cardCell}>
            <span className={styles.cardLabel}>{label}</span>
            {content}
          </div>
        ))}
      </div>
      <SyncStatus b={b} />
    </li>
  );
}

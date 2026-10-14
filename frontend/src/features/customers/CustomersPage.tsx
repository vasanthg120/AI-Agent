import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import toast from 'react-hot-toast';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FiAlertCircle,
  FiAlignJustify,
  FiArrowDown,
  FiCheckSquare,
  FiChevronLeft,
  FiChevronRight,
  FiClock,
  FiColumns,
  FiCpu,
  FiCreditCard,
  FiDownload,
  FiEdit3,
  FiFileText,
  FiFilter,
  FiInbox,
  FiLayers,
  FiLink2,
  FiMail,
  FiMaximize2,
  FiMessageSquare,
  FiMoreHorizontal,
  FiPhone,
  FiRefreshCw,
  FiSearch,
  FiUserCheck,
  FiUsers,
} from 'react-icons/fi';
import type { IconType } from 'react-icons';
import clsx from 'clsx';
import {
  AnimatedNumber,
  Avatar,
  Badge,
  Button,
  DateRangePopup,
  Dropdown,
  EmptyState,
  IconButton,
  Input,
  MultiSelectDropdown,
  PageHeader,
  Skeleton,
  Tabs,
} from '@/components/ui';
import type { DateRange, DropdownItem, MultiSelectOption } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useClickOutside } from '@/hooks/useClickOutside';
import {
  customersService,
  type Customer,
  type CustomerFilterKey,
  type CustomerFilters,
  type CustomerListResponse,
  type CustomerSort,
  type CustomerStats,
  type StageKey,
} from '@/services/customersService';
import { formatRelativeTime } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { CustomerPanel, type CustomerPreview, type PanelTab } from './CustomerPanel';
import type { Job } from '@/services/customerJobsService';
import { JobBoard } from './jobs/JobBoard';
import { jobHeadline, JobPanel, type JobPreview } from './jobs/JobPanel';
import { JobTag } from './jobs/JobTag';
import { StageChip } from './StageChip';
import { TYPE_VARIANT } from './status';
import styles from './customers.module.css';
import jobStyles from './jobs/jobs.module.css';

// The numbers that matter, each one a filter: click to see just those customers.
const TILES: { id: string; label: string; hint: string; icon: IconType; count: (s: CustomerStats) => number }[] = [
  { id: 'all', label: 'All customers', hint: 'Everyone in the selected source', icon: FiUsers, count: (s) => s.total },
  {
    id: 'open_inquiry',
    label: 'Open inquiries',
    hint: 'Enquired, and no order has come of it yet',
    icon: FiInbox,
    count: (s) => s.openInquiries,
  },
  {
    id: 'existing',
    label: 'Existing',
    hint: 'Have ordered at least once',
    icon: FiUserCheck,
    count: (s) => s.existing,
  },
  {
    id: 'quote_pending',
    label: 'Quote pending',
    hint: 'A quotation is with them, awaiting a decision',
    icon: FiFileText,
    count: (s) => s.quotePending,
  },
  {
    id: 'payment_pending',
    label: 'Payment pending',
    hint: 'Money is outstanding or overdue',
    icon: FiCreditCard,
    count: (s) => s.paymentPending,
  },
  {
    id: 'follow_up',
    label: 'Needs follow-up',
    hint: 'A reply is owed, or it is time to chase',
    icon: FiClock,
    count: (s) => s.needsFollowUp,
  },
];

// Every way to narrow the table (the tiles above are shortcuts to six of them).
const VIEWS: { id: string; label: string }[] = [
  { id: 'all', label: 'All customers' },
  { id: 'open_inquiry', label: 'Open inquiries' },
  { id: 'new', label: 'New customers' },
  { id: 'existing', label: 'Existing customers' },
  { id: 'returning', label: 'Returning customers' },
  { id: 'converted', label: 'Converted' },
  { id: 'not_converted', label: 'Not converted' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
  { id: 'quote_pending', label: 'Quote pending' },
  { id: 'payment_pending', label: 'Payment pending' },
  { id: 'payment_overdue', label: 'Payment overdue' },
  { id: 'follow_up', label: 'Needs follow-up' },
];

// The board, left to right: who looks after them · what kind of customer ·
// what happened last · then the six steps of the work, each a coloured chip
// (Inquiry → Quote → Order → Payment → Email → Follow-up) · what to do. The
// customer is always the first column; any of the others can be hidden.
type ColumnId = 'owner' | 'type' | 'activity' | StageKey | 'next';
const STAGE_COLUMNS: StageKey[] = ['inquiry', 'quote', 'order', 'payment', 'email', 'followUp'];
const COLUMNS: { id: ColumnId; label: string; hint: string; sort?: CustomerSort }[] = [
  { id: 'owner', label: 'Owner', hint: 'Who looks after them in your CRM', sort: 'owner' },
  {
    id: 'type',
    label: 'Type',
    hint: 'New: no order yet · Existing: has ordered · Returning: ordered and came back',
    sort: 'type',
  },
  { id: 'activity', label: 'Last activity', hint: 'The latest thing that happened with them', sort: 'activity' },
  { id: 'inquiry', label: 'Inquiry', hint: 'Their latest inquiry, and whether an order has come of it' },
  { id: 'quote', label: 'Quote', hint: 'Their latest quotation and where it stands', sort: 'quotes' },
  { id: 'order', label: 'Order', hint: 'Whether they have ordered, and how much', sort: 'orders' },
  { id: 'payment', label: 'Payment', hint: 'What is paid and what is still owed on their orders', sort: 'payment' },
  { id: 'email', label: 'Email', hint: 'Whether they answered you, or you owe them an answer' },
  {
    id: 'followUp',
    label: 'Follow-up',
    hint: 'Reminders on their emails and your team’s tasks that are still to do',
    sort: 'followUp',
  },
  { id: 'next', label: 'Next step', hint: 'What to do now, and why', sort: 'urgency' },
];

// The board's filters. Owner and channel offer what these customers really have; the rest are fixed lists.
const option = (value: string, label = value): MultiSelectOption => ({ value, label });
const FILTERS: {
  key: CustomerFilterKey;
  label: string;
  options: (offered: CustomerListResponse['filterOptions']) => MultiSelectOption[];
}[] = [
  { key: 'owner', label: 'Owner', options: (o) => [...o.owners.map((v) => option(v)), option('none', 'No owner')] },
  {
    key: 'type',
    label: 'Type',
    options: () => [option('new', 'New'), option('existing', 'Existing'), option('returning', 'Returning')],
  },
  {
    key: 'quote',
    label: 'Quote',
    options: () => [
      option('draft', 'Draft'),
      option('sent', 'Sent'),
      option('accepted', 'Accepted'),
      option('rejected', 'Rejected'),
      option('expired', 'Expired'),
      option('none', 'No quote'),
    ],
  },
  {
    key: 'payment',
    label: 'Payment',
    options: () => [
      option('paid', 'Paid'),
      option('partially_paid', 'Part paid'),
      option('unpaid', 'Unpaid'),
      option('overdue', 'Overdue'),
      option('not_recorded', 'Not recorded'),
      option('nothing_due', 'Nothing due'),
    ],
  },
  {
    key: 'mail',
    label: 'Email',
    // The same words as the Email chip, including the one status only the team can set.
    options: () => [
      option('reply_needed', 'Reply needed'),
      option('follow_up', 'No reply yet'),
      option('not_replied', 'Emailed'),
      option('replied', 'Replied'),
      option('not_contacted', 'Not emailed'),
      option('no_reply_needed', 'No reply needed'),
      option('none', 'No emails'),
    ],
  },
  {
    key: 'channel',
    label: 'Inquiry channel',
    options: (o) => [...o.channels.map((v) => option(v)), option('none', 'Not recorded')],
  },
];

const PAGE_SIZE = 25;
const NONE = <span className={styles.none}>—</span>;

// Where the board has less room, these columns give theirs up: what they say moves into the customer's own
// cell (customers.module.css decides when). Owner and type go first, then the last activity.
const FOLDS: Partial<Record<ColumnId, string>> = { owner: styles.foldA, type: styles.foldA, activity: styles.foldB };

// How the viewer left the board: which columns they hid, and how tall the rows are.
type RowHeight = 'comfortable' | 'compact';
const HIDDEN_KEY = 'haive:customers:hidden-columns';
const HEIGHT_KEY = 'haive:customers:row-height';
function remembered<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is unavailable (private window): the choice simply lasts for this visit.
  }
}

// The Customers page: the customers themselves, and — on its second tab — the
// Job board, the quotations the team is producing. Which tab is open is kept
// in the address bar, so a reload stays where it was. The two panels belong to
// the page, not to a tab: a customer leads to their jobs and a job back to its
// customer, whichever board is behind.
export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'jobs' ? 'jobs' : 'customers';
  // A board is built the first time it is shown and kept from then on: going back to it is instant, and it
  // is as it was left — its search, its filters, its place in the list.
  const visited = useRef(new Set<string>());
  visited.current.add(tab);
  // From the second board on, the one coming into view settles in (the first arrives with the page itself).
  const switched = visited.current.size > 1;
  const [customer, setCustomer] = useState<{
    id: string;
    tab?: PanelTab;
    documentId?: string;
    preview?: CustomerPreview;
  } | null>(null);
  const [job, setJob] = useState<{ id: string; preview?: JobPreview } | null>(null);
  // One panel taking over from the other: the surface stays, only what is on it changes.
  const [handover, setHandover] = useState(false);
  // Which panel is open, for the callbacks below — which must stay the same from one render to the next.
  const panels = useRef({ customer: false, job: false });
  panels.current = { customer: !!customer, job: !!job };

  // The boards are heavy (a table of chips each) and have nothing to do with a panel opening or closing over
  // them: they are memoised, and everything handed to them keeps its identity, so the panel's own motion
  // starts at once instead of waiting for the page behind it to be drawn again.
  const goTo = useCallback((next: string) => setParams(next === 'jobs' ? { tab: 'jobs' } : {}), [setParams]);
  const goToCustomers = useCallback(() => goTo('customers'), [goTo]);
  const openCustomer = useCallback((id: string, panelTab?: PanelTab, preview?: CustomerPreview) => {
    setHandover(false);
    setCustomer({ id, tab: panelTab, preview });
  }, []);
  const openJob = useCallback((id: string, number?: string, row?: Job) => {
    setHandover(panels.current.customer);
    setCustomer(null);
    setJob({ id, preview: number ? { number, ...(row ? { title: row.title, ...jobHeadline(row) } : {}) } : undefined });
  }, []);
  const backToCustomer = useCallback((id: string, documentId?: string, preview?: CustomerPreview) => {
    setHandover(panels.current.job);
    setJob(null);
    setCustomer({ id, documentId, preview });
  }, []);
  const closeCustomer = useCallback(() => {
    setHandover(false);
    setCustomer(null);
  }, []);
  const closeJob = useCallback(() => {
    setHandover(false);
    setJob(null);
  }, []);
  const [customersTabs, jobsTabs] = useMemo(
    () =>
      (['customers', 'jobs'] as const).map((active) => (
        // Each board carries the tabs with its own one chosen: the two are never on show together.
        <div key={active} className={jobStyles.pageTabs}>
          <Tabs
            items={[
              { id: 'customers', label: 'Customers', icon: <FiUsers /> },
              { id: 'jobs', label: 'Job board', icon: <FiLayers /> },
            ]}
            activeId={active}
            onChange={goTo}
          />
        </div>
      )),
    [goTo],
  );
  return (
    <>
      {visited.current.has('customers') && (
        <CustomersBoard
          tabs={customersTabs}
          offstage={tab !== 'customers'}
          switched={switched}
          onOpenCustomer={openCustomer}
          onOpenJob={openJob}
        />
      )}
      {visited.current.has('jobs') && (
        <JobBoard
          tabs={jobsTabs}
          offstage={tab !== 'jobs'}
          switched={switched}
          onOpenJob={openJob}
          onGoToCustomers={goToCustomers}
        />
      )}
      <CustomerPanel
        customerId={customer?.id ?? null}
        preview={customer?.preview}
        initialTab={customer?.tab}
        initialDocumentId={customer?.documentId}
        handover={handover}
        onClose={closeCustomer}
        onOpenJob={openJob}
      />
      <JobPanel
        jobId={job?.id ?? null}
        preview={job?.preview}
        handover={handover}
        onClose={closeJob}
        onOpenCustomer={backToCustomer}
      />
    </>
  );
}

// Customers: one row per customer, built from every connected CRM and the
// mailbox together, shown as a board — each step of the work a coloured chip.
// The data source dropdown lists what this organization has connected
// (Integrations page) and narrows the table to customers known to that system;
// "All sources" is the unified view, with the same customer in two systems
// shown once.
const CustomersBoard = memo(function CustomersBoard({
  tabs,
  offstage,
  switched,
  onOpenCustomer,
  onOpenJob,
}: {
  // The page's own tabs (Customers | Job board), shown under the heading.
  tabs: ReactNode;
  // The other board is on show: this one keeps its state and waits out of sight.
  offstage: boolean;
  // The viewer has moved between the boards: each time this one comes back, it settles in.
  switched: boolean;
  // `preview`: what the row already says about the customer, so their panel opens with a name on it.
  onOpenCustomer: (id: string, tab?: PanelTab, preview?: CustomerPreview) => void;
  onOpenJob: (jobId: string, number?: string) => void;
}) {
  const navigate = useNavigate();
  const frame = clsx(styles.page, switched && styles.switched);
  const queryClient = useQueryClient();
  const [source, setSource] = useState('all');
  const [view, setView] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<CustomerSort>('activity');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  // Only customers with something happening in this period; empty = all time.
  const [period, setPeriod] = useState<DateRange>({});
  const [filters, setFilters] = useState<CustomerFilters>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [hidden, setHidden] = useState<ColumnId[]>(() =>
    remembered<ColumnId[]>(HIDDEN_KEY, []).filter((id) => COLUMNS.some((c) => c.id === id)),
  );
  const [rowHeight, setRowHeight] = useState<RowHeight>(() =>
    remembered<RowHeight>(HEIGHT_KEY, 'comfortable') === 'compact' ? 'compact' : 'comfortable',
  );
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const paged = useRef(false);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Turning the page brings the top of the list back into view.
  useEffect(() => {
    if (paged.current) listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    paged.current = true;
  }, [page]);

  // The chosen days are the viewer's own days: sent as the exact moments they start and end.
  const from = period.dateFrom ? dayjs(period.dateFrom).startOf('day').toISOString() : undefined;
  const to = period.dateTo ? dayjs(period.dateTo).endOf('day').toISOString() : undefined;
  const query = { source, from, to, view, search, sort, direction, filters };
  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['customers', { ...query, page }],
    queryFn: () => customersService.list({ ...query, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const pick = (apply: () => void) => {
    apply();
    setPage(1);
  };
  const sortBy = (column: CustomerSort) =>
    pick(() => {
      if (column === sort) {
        setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSort(column);
        // Names read A→Z; everything else shows the biggest or most recent first.
        setDirection(column === 'name' || column === 'type' || column === 'owner' ? 'asc' : 'desc');
      }
    });

  // "Sync now" pulls from the selected source, or from every connected CRM that can be synced.
  const shown = data?.sources.filter((s) => source === 'all' || s.id === source) ?? [];
  const canSync = shown.some((s) => s.canSync);
  const sync = async () => {
    setSyncing(true);
    try {
      const { results } = await customersService.sync(source);
      const failed = results.filter((r) => !r.ok);
      for (const r of failed) toast.error(`${r.source}: ${r.error ?? 'The sync failed.'}`, { duration: 8_000 });
      if (failed.length < results.length)
        toast.success(failed.length ? 'The other sources are up to date' : 'Customers are up to date');
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setSyncing(false);
    }
  };
  const synced = shown.filter((s) => s.lastSyncAt).map((s) => `${s.label} synced ${formatRelativeTime(s.lastSyncAt!)}`);

  // The board as a spreadsheet: what is on screen now, every page of it.
  const exportBoard = async () => {
    setExporting(true);
    try {
      const file = await customersService.export(query);
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = `customers-${dayjs().format('YYYY-MM-DD')}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setExporting(false);
    }
  };

  const toggleColumn = (id: ColumnId) =>
    setHidden((current) => {
      const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
      remember(HIDDEN_KEY, next);
      return next;
    });
  const showAllColumns = () => {
    setHidden([]);
    remember(HIDDEN_KEY, []);
  };
  const toggleRowHeight = () =>
    setRowHeight((current) => {
      const next = current === 'compact' ? 'comfortable' : 'compact';
      remember(HEIGHT_KEY, next);
      return next;
    });

  const header = (
    <>
      <PageHeader
        icon={FiUsers}
        title="Customers"
        subtitle="Every customer across your connected CRMs and email, in one view."
        meta={
          synced.length > 0 ? (
            <span className={styles.meta} title={synced.join(' · ')}>
              {synced.join(' · ')}
            </span>
          ) : undefined
        }
        actions={
          data && data.sources.length > 0 ? (
            <div className={styles.headerActions}>
              <label className={styles.selectField}>
                <span>Customer data source</span>
                <select value={source} onChange={(e) => pick(() => setSource(e.target.value))}>
                  <option value="all">All sources</option>
                  {data.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} ({s.customers.toLocaleString()})
                    </option>
                  ))}
                </select>
              </label>
              {canSync && (
                <Button
                  type="button"
                  variant="secondary"
                  leftIcon={<FiRefreshCw />}
                  loading={syncing}
                  onClick={() => void sync()}
                >
                  Sync now
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      {tabs}
    </>
  );

  if (isLoading) {
    return (
      <div className={frame} hidden={offstage}>
        {header}
        <div className={styles.tiles}>
          {TILES.map((tile) => (
            <Skeleton key={tile.id} height={76} />
          ))}
        </div>
        <Skeleton height={360} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className={frame} hidden={offstage}>
        {header}
        <EmptyState
          icon={FiAlertCircle}
          title="Couldn’t load customers"
          description={extractErrorMessage(error)}
          action={
            <Button type="button" variant="secondary" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  if (data.sources.length === 0) {
    return (
      <div className={frame} hidden={offstage}>
        {header}
        <EmptyState
          icon={FiLink2}
          title="Connect a CRM to see your customers"
          description="Once a CRM is connected on the Integrations page, its customers appear here automatically."
          action={
            <Button type="button" leftIcon={<FiLink2 />} onClick={() => navigate(ROUTES.settingsIntegrations)}>
              Open Integrations
            </Button>
          }
        />
      </div>
    );
  }

  const { stats, items, total } = data;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const periodSet = !!(period.dateFrom || period.dateTo);
  const filterCount = Object.values(filters).reduce((sum, values) => sum + (values?.length ?? 0), 0);
  const filtered = view !== 'all' || search !== '' || periodSet || filterCount > 0;
  const sourceLabel = data.sources.find((s) => s.id === source)?.label;
  const clearFilters = () => {
    setSearchInput('');
    setPeriod({});
    setFilters({});
    pick(() => setView('all'));
  };
  const columns = COLUMNS.filter((c) => !hidden.includes(c.id));
  const openCustomer = (who: Customer, tab?: PanelTab) =>
    onOpenCustomer(who.id, tab, { name: who.name, company: who.company, owner: who.owner, sources: who.sources });

  return (
    <div className={frame} hidden={offstage}>
      {header}

      {/* What is wrong with a source, together in one place. */}
      {shown.some((s) => s.lastError || !s.connected) && (
        <div className={styles.notices}>
          {shown
            .filter((s) => s.lastError)
            .map((s) => (
              <div key={`error-${s.id}`} className={styles.notice} role="alert">
                <FiAlertCircle aria-hidden />
                <span>
                  The last sync with {s.label} failed: {s.lastError} Showing what the last successful sync brought in.
                </span>
              </div>
            ))}
          {shown
            .filter((s) => !s.connected)
            .map((s) => (
              <div key={`off-${s.id}`} className={styles.notice} role="status">
                <FiAlertCircle aria-hidden />
                <span>
                  {s.label} is disconnected, so nothing new is arriving from it.{' '}
                  <button type="button" className={styles.link} onClick={() => navigate(ROUTES.settingsIntegrations)}>
                    Reconnect it
                  </button>
                  .
                </span>
              </div>
            ))}
        </div>
      )}

      <div className={styles.tiles} role="tablist" aria-label="Filter customers">
        {TILES.map((tile) => {
          const active = view === tile.id;
          const attention = tile.id === 'follow_up' && tile.count(stats) > 0;
          return (
            <button
              key={tile.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={tile.hint}
              className={clsx(styles.tile, active && styles.tileActive, attention && styles.tileAttention)}
              onClick={() => pick(() => setView(tile.id))}
            >
              <span className={styles.tileIcon}>
                <tile.icon aria-hidden />
              </span>
              <span className={styles.tileText}>
                <strong>
                  <AnimatedNumber value={tile.count(stats)} duration={0.45} />
                </strong>
                <span>{tile.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Input
            aria-label="Search customers"
            placeholder="Search name, company, email, phone, quote or invoice number"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            leftIcon={<FiSearch />}
          />
        </div>
        <div className={styles.selectField}>
          <span>Active between</span>
          <DateRangePopup value={period} onChange={(range) => pick(() => setPeriod(range))} ariaLabel="Period" />
        </div>
        <label className={styles.selectField}>
          <span>Show</span>
          <select value={view} onChange={(e) => pick(() => setView(e.target.value))}>
            {VIEWS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {/* The board's own tools: narrow it, choose its columns, set its row height, take it away as a file. */}
        <div className={styles.boardTools}>
          <button
            type="button"
            className={clsx(styles.tool, (filtersOpen || filterCount > 0) && styles.toolOn)}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((value) => !value)}
          >
            <FiFilter aria-hidden /> Filters
            {filterCount > 0 && <span className={styles.toolCount}>{filterCount}</span>}
          </button>
          <ColumnPicker hidden={hidden} onToggle={toggleColumn} onReset={showAllColumns} />
          <button
            type="button"
            className={clsx(styles.tool, styles.tableOnly, rowHeight === 'compact' && styles.toolOn)}
            aria-pressed={rowHeight === 'compact'}
            title="Switch between tall rows with details and short rows that fit more customers"
            onClick={toggleRowHeight}
          >
            <FiAlignJustify aria-hidden /> Compact rows
          </button>
          <button
            type="button"
            className={styles.tool}
            disabled={exporting || total === 0}
            title="Download these customers as a spreadsheet (CSV)"
            onClick={() => void exportBoard()}
          >
            <FiDownload aria-hidden /> {exporting ? 'Exporting…' : 'Export'}
          </button>
          {filtered && (
            <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>
      </div>

      {filtersOpen && (
        <div className={styles.filterBar} role="group" aria-label="Filters">
          {FILTERS.map((filter) => (
            <MultiSelectDropdown
              key={filter.key}
              label={filter.label}
              options={filter.options(data.filterOptions)}
              selected={filters[filter.key] ?? []}
              onChange={(values) => pick(() => setFilters((current) => ({ ...current, [filter.key]: values })))}
            />
          ))}
          {filterCount > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => pick(() => setFilters({}))}>
              Clear filters
            </Button>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={FiUsers}
          title={
            stats.total > 0
              ? 'Nothing matches'
              : periodSet
                ? 'No activity in this period'
                : `No customers${sourceLabel ? ` from ${sourceLabel}` : ''} yet`
          }
          description={
            stats.total > 0
              ? 'Try another filter or a different search.'
              : periodSet
                ? 'No customer had an inquiry, quotation, invoice, payment or email in these dates. Try a wider period.'
                : 'Customers appear here once this source has synced its records.'
          }
          action={
            filtered ? (
              <Button type="button" variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={styles.wrap} ref={listRef}>
          <div className={styles.listHead}>
            <span>
              <strong>{total.toLocaleString()}</strong> {total === 1 ? 'customer' : 'customers'}
              {filtered ? ' in this view' : ''} · click one to see everything about them
            </span>
            <span className={styles.legend} aria-hidden>
              <span>
                <i className={styles.legendDone} /> Done
              </span>
              <span>
                <i className={styles.legendProgress} /> In progress
              </span>
              <span>
                <i className={styles.legendToday} /> Needs attention
              </span>
              <span>
                <i className={styles.legendOverdue} /> Act now
              </span>
              <span>
                <FiEdit3 /> Set by hand
              </span>
            </span>
          </div>

          <div className={styles.tableWrap} aria-busy={isFetching}>
            <table className={clsx(styles.table, rowHeight === 'compact' && styles.compact)}>
              <thead>
                <tr>
                  <HeadCell
                    label="Customer"
                    hint="Who they are, and which of your systems know them"
                    column="name"
                    sort={sort}
                    direction={direction}
                    onSort={sortBy}
                  />
                  {columns.map((column) => (
                    <HeadCell
                      key={column.id}
                      label={column.label}
                      hint={column.hint}
                      column={column.sort}
                      sort={sort}
                      direction={direction}
                      onSort={sortBy}
                      className={STAGE_COLUMNS.includes(column.id as StageKey) ? styles.stageCol : FOLDS[column.id]}
                    />
                  ))}
                  <th scope="col" className={styles.menuCol}>
                    <span className={styles.srOnly}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((customer, index) => (
                  <CustomerRow
                    key={customer.id}
                    customer={customer}
                    index={index}
                    columns={columns.map((c) => c.id)}
                    detailed={rowHeight !== 'compact'}
                    onOpen={(tab) => openCustomer(customer, tab)}
                    onOpenJob={onOpenJob}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* The same customers as cards, where there is no room for the columns. */}
          <div className={styles.cards} role="list" aria-busy={isFetching}>
            {items.map((customer, index) => (
              <CustomerCard
                key={customer.id}
                customer={customer}
                index={index}
                onOpen={() => openCustomer(customer)}
                onOpenJob={onOpenJob}
              />
            ))}
          </div>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className={styles.pagination}>
          <span>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            leftIcon={<FiChevronLeft />}
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            rightIcon={<FiChevronRight />}
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
});

// A column heading: explains itself on hover, and sorts when the column can be sorted.
function HeadCell({
  label,
  hint,
  column,
  sort,
  direction,
  onSort,
  className,
}: {
  label: string;
  hint: string;
  column?: CustomerSort;
  sort: CustomerSort;
  direction: 'asc' | 'desc';
  onSort: (column: CustomerSort) => void;
  className?: string;
}) {
  const sorted = !!column && column === sort;
  return (
    <th
      scope="col"
      title={hint}
      className={className}
      aria-sort={sorted ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      {column ? (
        <button
          type="button"
          className={clsx(
            styles.sortButton,
            sorted && styles.sortActive,
            sorted && direction === 'asc' && styles.sortAscending,
          )}
          onClick={() => onSort(column)}
        >
          {label}
          <FiArrowDown aria-hidden />
        </button>
      ) : (
        label
      )}
    </th>
  );
}

// Which columns the board shows: tick to show, untick to hide. The customer column always stays.
function ColumnPicker({
  hidden,
  onToggle,
  onReset,
}: {
  hidden: ColumnId[];
  onToggle: (id: ColumnId) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  return (
    <div className={clsx(styles.picker, styles.tableOnly)} ref={ref}>
      <button
        type="button"
        className={clsx(styles.tool, (open || hidden.length > 0) && styles.toolOn)}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <FiColumns aria-hidden /> Columns
        {hidden.length > 0 && (
          <span className={styles.toolCount}>
            {COLUMNS.length - hidden.length}/{COLUMNS.length}
          </span>
        )}
      </button>
      {open && (
        <div className={styles.pickerMenu} role="group" aria-label="Show or hide columns">
          {COLUMNS.map((column) => (
            <label key={column.id} className={styles.pickerOption}>
              <input type="checkbox" checked={!hidden.includes(column.id)} onChange={() => onToggle(column.id)} />
              {column.label}
            </label>
          ))}
          {hidden.length > 0 && (
            <button type="button" className={styles.pickerReset} onClick={onReset}>
              Show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const opensOnKey = (onOpen: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onOpen();
  }
};

// Rows and cards arrive one after another; past the first screenful there is nothing to stagger.
const arrival = (index: number) => ({ '--i': Math.min(index, 12) }) as CSSProperties;

// The next step, then why: the one cell that says what to do.
function NextStep({ customer, detailed = true }: { customer: Customer; detailed?: boolean }) {
  return (
    <>
      {customer.nextAction.urgency !== 'none' && (
        <div className={clsx(styles.nextAction, styles[`nextAction_${customer.nextAction.urgency}`])}>
          {customer.nextAction.title}
        </div>
      )}
      {(detailed || customer.nextAction.urgency === 'none') && (
        <div className={styles.insight} title={customer.aiSummary ?? customer.insight}>
          {customer.aiSummary && <FiCpu aria-label="AI summary" className={styles.aiMark} />}
          {customer.aiSummary ?? customer.insight}
        </div>
      )}
    </>
  );
}

// What can be done with a customer straight from their row.
function rowActions(customer: Customer, onOpen: (tab?: PanelTab) => void): DropdownItem[] {
  const items: DropdownItem[] = [{ id: 'open', label: 'Open', icon: <FiMaximize2 />, onSelect: () => onOpen() }];
  if (customer.email)
    items.push({
      id: 'email',
      label: 'Email',
      icon: <FiMail />,
      onSelect: () => window.open(`mailto:${customer.email}`, '_self'),
    });
  if (customer.phone)
    items.push({
      id: 'call',
      label: 'Call',
      icon: <FiPhone />,
      onSelect: () => window.open(`tel:${customer.phone!.replace(/[^+\d]/g, '')}`, '_self'),
    });
  items.push(
    {
      id: 'comment',
      label: 'Add comment',
      icon: <FiMessageSquare />,
      separatorBefore: true,
      onSelect: () => onOpen('comments'),
    },
    { id: 'task', label: 'Add task', icon: <FiCheckSquare />, onSelect: () => onOpen('tasks') },
  );
  return items;
}

function CustomerRow({
  customer,
  index,
  columns,
  detailed,
  onOpen,
  onOpenJob,
}: {
  customer: Customer;
  index: number;
  columns: ColumnId[];
  detailed: boolean;
  onOpen: (tab?: PanelTab) => void;
  onOpenJob: (jobId: string, number?: string) => void;
}) {
  const stage = (key: StageKey) => customer.stages.find((s) => s.key === key);
  const cell = (id: ColumnId) => {
    switch (id) {
      case 'owner':
        return (
          <td key={id} className={clsx(styles.ownerCell, styles.foldA)}>
            {customer.owner ? (
              <span className={styles.owner} title={customer.owner}>
                <Avatar name={customer.owner} size="sm" />
                <span>{customer.owner}</span>
              </span>
            ) : (
              NONE
            )}
          </td>
        );
      case 'type':
        return (
          <td key={id} className={styles.foldA}>
            <Badge variant={TYPE_VARIANT[customer.type]}>{customer.typeLabel}</Badge>
            {detailed && <div className={styles.cellSub}>{customer.active ? 'Active' : 'Inactive'}</div>}
          </td>
        );
      case 'activity':
        return (
          <td key={id} className={clsx(styles.colActivity, styles.foldB)}>
            {customer.lastActivity ? (
              <>
                <div className={styles.cellMain}>{customer.lastActivity.label}</div>
                {detailed && <div className={styles.cellSub}>{formatRelativeTime(customer.lastActivity.at)}</div>}
              </>
            ) : (
              NONE
            )}
          </td>
        );
      case 'next':
        return (
          <td key={id} className={styles.nextCell}>
            <NextStep customer={customer} detailed={detailed} />
          </td>
        );
      default: {
        const step = stage(id);
        return (
          <td key={id} className={styles.stageCol}>
            {step ? <StageChip stage={step} showDetail={detailed} /> : NONE}
          </td>
        );
      }
    }
  };
  return (
    <tr
      tabIndex={0}
      className={clsx(styles.row, styles[`urgency_${customer.nextAction.urgency}`])}
      style={arrival(index)}
      onClick={() => onOpen()}
      onKeyDown={opensOnKey(() => onOpen())}
    >
      <td className={styles.customerCell}>
        <div className={styles.who}>
          <Avatar name={customer.name} size="sm" className={styles.whoAvatar} />
          <div className={styles.whoText}>
            <div className={styles.whoName}>
              <strong>{customer.name}</strong>
              {columns.includes('type') && (
                <Badge variant={TYPE_VARIANT[customer.type]} className={styles.foldedA}>
                  {customer.typeLabel}
                </Badge>
              )}
            </div>
            {customer.company && <div className={styles.cellSub}>{customer.company}</div>}
            {/* What the Owner and Last activity columns say, where those columns have given up their room. */}
            {detailed && columns.includes('owner') && customer.owner && (
              <div className={clsx(styles.cellSub, styles.foldedA)} title={`Owner: ${customer.owner}`}>
                Owner: {customer.owner}
              </div>
            )}
            {detailed && columns.includes('activity') && customer.lastActivity && (
              <div
                className={clsx(styles.cellSub, styles.foldedB)}
                title={`${customer.lastActivity.label} · ${formatRelativeTime(customer.lastActivity.at)}`}
              >
                {customer.lastActivity.label} · {formatRelativeTime(customer.lastActivity.at)}
              </div>
            )}
            {detailed && (
              <div className={styles.sources}>
                {customer.sources.map((label) => (
                  <span key={label} className={styles.source}>
                    {label}
                  </span>
                ))}
                {/* The quotations of theirs that are being produced. */}
                {customer.jobs.slice(0, 2).map((job) => (
                  <JobTag key={job.id} job={job} onOpen={onOpenJob} />
                ))}
                {customer.jobs.length > 2 && (
                  <span className={styles.source} title={customer.jobs.map((job) => `Job ${job.number}`).join(', ')}>
                    +{customer.jobs.length - 2} jobs
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </td>
      {columns.map(cell)}
      {/* The menu acts on its own: a click in this cell does not also open the row. */}
      <td className={styles.menuCol} onClick={(e) => e.stopPropagation()}>
        <Dropdown
          align="right"
          usePortal
          trigger={<IconButton icon={<FiMoreHorizontal />} size="sm" label={`Actions for ${customer.name}`} />}
          items={rowActions(customer, onOpen)}
        />
      </td>
    </tr>
  );
}

function CustomerCard({
  customer,
  index,
  onOpen,
  onOpenJob,
}: {
  customer: Customer;
  index: number;
  onOpen: () => void;
  onOpenJob: (jobId: string, number?: string) => void;
}) {
  const facts = [
    customer.owner ? `Owner: ${customer.owner}` : '',
    customer.lastActivity ? `${customer.lastActivity.label} · ${formatRelativeTime(customer.lastActivity.at)}` : '',
  ].filter(Boolean);
  return (
    <div
      role="listitem"
      tabIndex={0}
      className={clsx(styles.card, styles[`urgency_${customer.nextAction.urgency}`])}
      style={arrival(index)}
      onClick={onOpen}
      onKeyDown={opensOnKey(onOpen)}
    >
      <div className={styles.cardHead}>
        <Avatar name={customer.name} size="sm" />
        <div className={styles.cardName}>
          <strong>{customer.name}</strong>
          {customer.company && <span>{customer.company}</span>}
        </div>
        <Badge variant={TYPE_VARIANT[customer.type]}>{customer.typeLabel}</Badge>
      </div>
      <div className={styles.cardNext}>
        <NextStep customer={customer} />
      </div>
      {/* The same six steps as the board's columns, each named. */}
      <div className={styles.cardStages}>
        {customer.stages.map((step) => (
          <StageChip key={step.key} stage={step} showTitle />
        ))}
      </div>
      {customer.jobs.length > 0 && (
        <div className={styles.sources}>
          {customer.jobs.slice(0, 3).map((job) => (
            <JobTag key={job.id} job={job} onOpen={onOpenJob} />
          ))}
        </div>
      )}
      {facts.length > 0 && <div className={styles.cardFoot}>{facts.join(' · ')}</div>}
    </div>
  );
}

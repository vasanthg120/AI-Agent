import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  FiAlertCircle,
  FiAlertTriangle,
  FiArrowDown,
  FiCheckCircle,
  FiChevronLeft,
  FiChevronRight,
  FiCreditCard,
  FiFilter,
  FiImage,
  FiLayers,
  FiPlayCircle,
  FiSearch,
  FiShoppingCart,
  FiUsers,
} from 'react-icons/fi';
import type { IconType } from 'react-icons';
import clsx from 'clsx';
import { AnimatedNumber, Avatar, Badge, Button, EmptyState, Input, PageHeader, Skeleton } from '@/components/ui';
import { customerJobsService, type Job, type JobSort, type JobStatusKey } from '@/services/customerJobsService';
import { extractErrorMessage } from '@/utils/errors';
import { formatDate } from '../format';
import { StageChip } from '../StageChip';
import styles from '../customers.module.css';
import jobStyles from './jobs.module.css';

// The quick views: the jobs that need something, each one a filter.
const TILES: { id: string; label: string; hint: string; icon: IconType }[] = [
  { id: 'active', label: 'Active jobs', hint: 'Jobs that are not done yet', icon: FiPlayCircle },
  { id: 'overdue', label: 'Overdue', hint: 'Not done, and the due date has passed', icon: FiAlertTriangle },
  {
    id: 'awaiting_payment',
    label: 'Awaiting payment',
    hint: 'Payment is set to waiting for payment or for remittance',
    icon: FiCreditCard,
  },
  { id: 'awaiting_artwork', label: 'Awaiting artwork', hint: 'Artwork is waiting for approval', icon: FiImage },
  { id: 'to_order', label: 'To order', hint: 'Something still has to be ordered', icon: FiShoppingCart },
  { id: 'done', label: 'Done', hint: 'Progress is set to done', icon: FiCheckCircle },
];
const VIEWS = [{ id: 'all', label: 'All jobs' }, ...TILES.map(({ id, label }) => ({ id, label }))];

const PAGE_SIZE = 25;
const NONE = <span className={styles.none}>—</span>;
type StatusFilters = Partial<Record<JobStatusKey, string>>;

const opensOnKey = (onOpen: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onOpen();
  }
};
const arrival = (index: number) => ({ '--i': Math.min(index, 12) }) as CSSProperties;

// The Job board: every quotation the team decided to produce, one row per job,
// with its seven statuses as coloured chips. A job is made from a quotation
// ("Convert to job" on the customer) and is saved in HaiVE only. Statuses are
// changed in the job's panel — a click on a row opens it.
export const JobBoard = memo(function JobBoard({
  tabs,
  offstage,
  switched,
  onOpenJob,
  onGoToCustomers,
}: {
  // The page's own tabs (Customers | Job board), shown under the heading.
  tabs: ReactNode;
  // The other board is on show: this one keeps its state and waits out of sight.
  offstage: boolean;
  // The viewer has moved between the boards: each time this one comes back, it settles in.
  switched: boolean;
  // The row goes with it, so the job's panel opens already saying what the row says.
  onOpenJob: (jobId: string, number?: string, row?: Job) => void;
  onGoToCustomers: () => void;
}) {
  const frame = clsx(styles.page, switched && styles.switched);
  const [view, setView] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  // No column chosen: the newest job first.
  const [sort, setSort] = useState<JobSort | undefined>(undefined);
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [statuses, setStatuses] = useState<StatusFilters>({});
  const [owner, setOwner] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const listRef = useRef<HTMLDivElement>(null);
  const paged = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (paged.current) listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    paged.current = true;
  }, [page]);

  const query = { view, search, sort, direction, owner, statuses };
  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['customer-jobs', 'list', { ...query, page }],
    queryFn: () => customerJobsService.list({ ...query, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const pick = (apply: () => void) => {
    apply();
    setPage(1);
  };
  const sortBy = (column: JobSort) =>
    pick(() => {
      if (column === sort) {
        setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSort(column);
        // Names read A→Z and the nearest due date comes first; numbers and dates show the newest first.
        setDirection(column === 'customer' || column === 'owner' || column === 'due' ? 'asc' : 'desc');
      }
    });

  const header = (
    <>
      <PageHeader
        icon={FiUsers}
        title="Customers"
        subtitle="The quotations your team is producing — each one a job, with its own statuses."
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
          title="Couldn’t load the jobs"
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

  const { items, total, stats, options } = data;
  const everything = stats.all ?? 0;
  if (everything === 0) {
    return (
      <div className={frame} hidden={offstage}>
        {header}
        <EmptyState
          icon={FiLayers}
          title="No jobs yet"
          description="A job starts from a quotation. Open a customer, go to Quotes & orders, open the quotation you are going to produce and press “Convert to job”."
          action={
            <Button type="button" leftIcon={<FiUsers />} onClick={onGoToCustomers}>
              Go to Customers
            </Button>
          }
        />
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filterCount = Object.values(statuses).filter(Boolean).length + (owner ? 1 : 0);
  const filtered = view !== 'all' || search !== '' || filterCount > 0;
  const clearFilters = () => {
    setSearchInput('');
    setStatuses({});
    setOwner('');
    pick(() => setView('all'));
  };
  const head = (label: string, hint: string, column?: JobSort, className?: string) => {
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
            onClick={() => sortBy(column)}
          >
            {label}
            <FiArrowDown aria-hidden />
          </button>
        ) : (
          label
        )}
      </th>
    );
  };

  return (
    <div className={frame} hidden={offstage}>
      {header}

      <div className={styles.tiles} role="tablist" aria-label="Filter jobs">
        {TILES.map((tile) => {
          const active = view === tile.id;
          const count = stats[tile.id] ?? 0;
          return (
            <button
              key={tile.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={tile.hint}
              className={clsx(
                styles.tile,
                active && styles.tileActive,
                tile.id === 'overdue' && count > 0 && styles.tileAttention,
              )}
              // A second click on the chosen tile shows every job again.
              onClick={() => pick(() => setView(active ? 'all' : tile.id))}
            >
              <span className={styles.tileIcon}>
                <tile.icon aria-hidden />
              </span>
              <span className={styles.tileText}>
                <strong>
                  <AnimatedNumber value={count} duration={0.45} />
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
            aria-label="Search jobs"
            placeholder="Search job number, quote number, customer or owner"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            leftIcon={<FiSearch />}
          />
        </div>
        <label className={styles.selectField}>
          <span>Show</span>
          <select value={view} onChange={(e) => pick(() => setView(e.target.value))}>
            {VIEWS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
                {item.id === 'all' ? ` (${everything})` : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={clsx(styles.tool, jobStyles.filterTool, (filtersOpen || filterCount > 0) && styles.toolOn)}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          <FiFilter aria-hidden /> Filters
          {filterCount > 0 && <span className={styles.toolCount}>{filterCount}</span>}
        </button>
        {filtered && (
          <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </div>

      {filtersOpen && (
        <div className={clsx(styles.filterBar, jobStyles.filterBar)} role="group" aria-label="Filters">
          {options.columns.map((column) => (
            <label key={column.key} className={styles.selectField}>
              <span>{column.title}</span>
              <select
                value={statuses[column.key] ?? ''}
                onChange={(e) => pick(() => setStatuses((current) => ({ ...current, [column.key]: e.target.value })))}
              >
                <option value="">Any</option>
                {column.options.map((option) => (
                  <option key={option.status} value={option.status}>
                    {option.label}
                  </option>
                ))}
                <option value="unset">Not set</option>
              </select>
            </label>
          ))}
          {data.owners.length > 0 && (
            <label className={styles.selectField}>
              <span>Owner</span>
              <select value={owner} onChange={(e) => pick(() => setOwner(e.target.value))}>
                <option value="">Anyone</option>
                {data.owners.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={FiLayers}
          title="Nothing matches"
          description="No job fits this view. Try another one, or a different search."
          action={
            <Button type="button" variant="secondary" onClick={clearFilters}>
              Show all jobs
            </Button>
          }
        />
      ) : (
        <div className={styles.wrap} ref={listRef}>
          <div className={styles.listHead}>
            <span>
              <strong>{total.toLocaleString()}</strong> {total === 1 ? 'job' : 'jobs'}
              {filtered ? ' in this view' : ''} · click one to open it and set its statuses
            </span>
            <span className={styles.legend} aria-hidden>
              <span>
                <i className={styles.legendDone} /> Done
              </span>
              <span>
                <i className={styles.legendProgress} /> In progress
              </span>
              <span>
                <i className={styles.legendToday} /> Waiting
              </span>
              <span>
                <i className={styles.legendOverdue} /> Needs attention
              </span>
            </span>
          </div>

          <div className={styles.tableWrap} aria-busy={isFetching}>
            <table className={clsx(styles.table, jobStyles.table)}>
              <thead>
                <tr>
                  {head('Job', 'The job’s number and name', 'number')}
                  {head('Quote', 'The quotation it was made from', undefined, jobStyles.foldA)}
                  {head('Created', 'When the quotation became a job', 'created', jobStyles.foldA)}
                  {head('Due date', 'When the job has to be finished', 'due', jobStyles.foldC)}
                  {head('Owner', 'Who looks after the quotation in your CRM', 'owner', jobStyles.foldA)}
                  {head('Customer', 'Who the job is for', 'customer', jobStyles.foldB)}
                  {options.columns.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      title={`${column.title}: ${column.options.map((o) => o.label).join(' · ')}`}
                      className={jobStyles.chipCol}
                    >
                      {column.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((job, index) => (
                  <tr
                    key={job.id}
                    tabIndex={0}
                    className={clsx(styles.row, job.overdue && styles.urgency_overdue)}
                    style={arrival(index)}
                    aria-label={`Open job ${job.number}`}
                    onClick={() => onOpenJob(job.id, job.number, job)}
                    onKeyDown={opensOnKey(() => onOpenJob(job.id, job.number, job))}
                  >
                    <td className={clsx(styles.customerCell, jobStyles.jobCell)}>
                      <strong>{job.number}</strong>
                      <div className={styles.cellSub}>{job.title}</div>
                      {/* What the other columns say, where they have given up their room. */}
                      {job.customer.name !== job.title && (
                        <div className={clsx(styles.cellSub, jobStyles.foldedB)}>{job.customer.name}</div>
                      )}
                      {job.dueDate && (
                        <div className={clsx(styles.cellSub, jobStyles.foldedC, job.overdue && jobStyles.dueLate)}>
                          Due {formatDate(job.dueDate)}
                          {job.overdue ? ' · overdue' : ''}
                        </div>
                      )}
                      <div className={clsx(styles.cellSub, jobStyles.foldedA)}>
                        {[
                          job.quotationNumber ? `From ${job.quotationNumber}` : '',
                          job.owner ? `Owner: ${job.owner}` : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </td>
                    <td className={clsx(jobStyles.dateCell, jobStyles.foldA)}>{job.quotationNumber ?? NONE}</td>
                    <td className={clsx(jobStyles.dateCell, jobStyles.foldA)}>{formatDate(job.createdAt)}</td>
                    <td className={clsx(jobStyles.dateCell, jobStyles.foldC)}>
                      <DueDate job={job} />
                    </td>
                    <td className={clsx(styles.ownerCell, jobStyles.foldA)}>
                      {job.owner ? (
                        <span className={styles.owner} title={job.owner}>
                          <Avatar name={job.owner} size="sm" />
                          <span>{job.owner}</span>
                        </span>
                      ) : (
                        NONE
                      )}
                    </td>
                    <td className={clsx(jobStyles.customerCol, jobStyles.foldB)}>
                      <div className={styles.cellMain}>{job.customer.company ?? job.customer.name}</div>
                      {job.customer.company && job.customer.company !== job.customer.name && (
                        <div className={styles.cellSub}>{job.customer.name}</div>
                      )}
                    </td>
                    {job.statuses.map((chip) => (
                      <td key={chip.key} className={jobStyles.chipCol}>
                        <StageChip stage={chip} showDetail={false} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* The same jobs as cards, where there is no room for the columns. */}
          <div className={styles.cards} role="list" aria-busy={isFetching}>
            {items.map((job, index) => (
              <div
                key={job.id}
                role="listitem"
                tabIndex={0}
                className={clsx(styles.card, job.overdue && styles.urgency_overdue)}
                style={arrival(index)}
                onClick={() => onOpenJob(job.id, job.number, job)}
                onKeyDown={opensOnKey(() => onOpenJob(job.id, job.number, job))}
              >
                <div className={styles.cardHead}>
                  <div className={styles.cardName}>
                    <strong>
                      {job.number} · {job.title}
                    </strong>
                    <span>
                      {[
                        job.customer.name !== job.title ? job.customer.name : '',
                        job.quotationNumber ? `from ${job.quotationNumber}` : '',
                        job.owner ? `Owner: ${job.owner}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  {job.done ? (
                    <Badge variant="success">Done</Badge>
                  ) : job.overdue ? (
                    <Badge variant="danger">Overdue</Badge>
                  ) : null}
                </div>
                <div className={styles.cardStages}>
                  {job.statuses.map((chip) => (
                    <StageChip key={chip.key} stage={chip} showTitle showDetail={false} />
                  ))}
                </div>
                <div className={styles.cardFoot}>
                  {job.dueDate ? `Due ${formatDate(job.dueDate)}` : 'No due date'} · created {formatDate(job.createdAt)}
                </div>
              </div>
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

// When the job is due: plain while there is time, red and marked once the day has passed.
function DueDate({ job }: { job: Job }) {
  if (!job.dueDate) return NONE;
  return job.overdue ? (
    <span className={jobStyles.overdue}>
      {formatDate(job.dueDate)}
      <Badge variant="danger">Overdue</Badge>
    </span>
  ) : (
    <>{formatDate(job.dueDate)}</>
  );
}

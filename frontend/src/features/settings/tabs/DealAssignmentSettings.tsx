import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiAlertCircle, FiCheck, FiChevronDown, FiLink, FiSearch, FiShuffle, FiUserCheck, FiUsers, FiX } from 'react-icons/fi';
import {
  Avatar,
  Badge,
  Button,
  ChoiceCards,
  EmptyState,
  Input,
  MultiSelectDropdown,
  Skeleton,
  type ChoiceCardItem,
  type MultiSelectOption,
} from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { formatINR } from '@/utils/currency';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { usersService } from '@/services/usersService';
import { dealsService, type AssignmentDealRow, type DealFilters, type ExternalOwnerRow } from '@/services/dealsService';
import { SettingsSection } from '../components/SettingsSection';
import styles from './DealAssignmentSettings.module.css';

const STATUS_VARIANT: Record<AssignmentDealRow['dealStatus'], 'success' | 'danger' | 'neutral'> = {
  won: 'success',
  lost: 'danger',
  open: 'neutral',
};

const STATUS_OPTIONS: MultiSelectOption[] = [
  { value: 'open', label: 'Open' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
];

const PAGE_SIZE = 25;
type View = 'needsOwner' | 'all';

export function DealAssignmentSettings() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('needsOwner');
  const [search, setSearch] = useState('');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOwner, setBulkOwner] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [assigning, setAssigning] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState<Record<string, number>>({});
  const [mappingsOpen, setMappingsOpen] = useState(false);
  const [mappingChoice, setMappingChoice] = useState<Record<string, string>>({});
  const [mappingBusy, setMappingBusy] = useState<string | null>(null);

  // Typing refetches once the user pauses, not on every keystroke.
  const debouncedSearch = useDebouncedValue(search.trim(), 350);

  const filters: DealFilters = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      dealStatus: statuses.length ? (statuses as DealFilters['dealStatus']) : undefined,
      ownerId: view === 'all' && owners.length ? owners : undefined,
    }),
    [debouncedSearch, statuses, owners, view],
  );

  // Any filter change goes back to page 1 and clears the selection.
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [filters, view]);

  const { data: employees = [] } = useQuery({
    queryKey: ['deal-assignment-employees'],
    queryFn: async () => (await usersService.list()).filter((u) => u.roles.includes('manager') || u.roles.includes('consultant')),
  });

  const listKey = ['deal-assignment', view, filters, page] as const;
  // keepPreviousData: while a new page/filter loads, the current rows stay
  // on screen (dimmed) instead of the table flashing to a skeleton.
  const { data, isLoading, isFetching } = useQuery({
    queryKey: listKey,
    queryFn: () => dealsService.listForAssignment(filters, page, PAGE_SIZE, view === 'needsOwner'),
    placeholderData: keepPreviousData,
  });

  // Counts for the two view cards — a one-row query each, sharing search/status.
  const countFilters = { search: filters.search, dealStatus: filters.dealStatus };
  const { data: needsCount } = useQuery({
    queryKey: ['deal-assignment-count', 'needsOwner', countFilters],
    queryFn: async () => (await dealsService.listForAssignment(countFilters, 1, 1, true)).total,
    placeholderData: keepPreviousData,
  });
  const { data: allCount } = useQuery({
    queryKey: ['deal-assignment-count', 'all', countFilters],
    queryFn: async () => (await dealsService.listForAssignment(countFilters, 1, 1, false)).total,
    placeholderData: keepPreviousData,
  });

  const { data: mappings = [] } = useQuery({
    queryKey: ['deal-owner-mappings'],
    queryFn: () => dealsService.listOwnerMappings(),
  });
  const unlinked = mappings.filter((m) => !m.mapping);

  const deals = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const employeeName = (id?: string) => employees.find((e) => e.id === id)?.name;

  const refreshCounts = () => {
    void queryClient.invalidateQueries({ queryKey: ['deal-assignment-count'] });
  };

  // Optimistic: the row changes immediately and flashes; only a failure puts
  // it back. In "Needs an owner", a newly-owned deal stays visible (marked
  // assigned) until the next refresh, rather than jumping out from under the cursor.
  const applyOwner = (dealId: string, ownerId: string | null) => {
    queryClient.setQueryData(listKey, (prev: typeof data) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((d) =>
              d._id === dealId
                ? {
                    ...d,
                    ownerId: ownerId ?? undefined,
                    ownerName: ownerId ? employeeName(ownerId) : undefined,
                    ownershipStatus: ownerId ? 'assigned' : d.externalOwnerRef ? 'pending_mapping' : 'unassigned',
                  }
                : d,
            ),
          }
        : prev,
    );
    setFlash((prev) => ({ ...prev, [dealId]: Date.now() }));
  };

  const handleAssign = async (deal: AssignmentDealRow, ownerId: string) => {
    const previous = queryClient.getQueryData(listKey);
    setAssigning((prev) => ({ ...prev, [deal._id]: true }));
    applyOwner(deal._id, ownerId || null);
    try {
      await dealsService.assign(deal._id, ownerId || null);
      toast.success(ownerId ? `${deal.name} → ${employeeName(ownerId)}` : `${deal.name} unassigned`);
      refreshCounts();
    } catch (err) {
      queryClient.setQueryData(listKey, previous);
      toast.error(extractErrorMessage(err));
    } finally {
      setAssigning((prev) => ({ ...prev, [deal._id]: false }));
    }
  };

  const handleBulkAssign = async () => {
    if (!bulkOwner || selected.size === 0) return;
    setBulkBusy(true);
    const ids = [...selected];
    const results = await Promise.allSettled(ids.map((id) => dealsService.assign(id, bulkOwner)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    ids.forEach((id, i) => results[i].status === 'fulfilled' && applyOwner(id, bulkOwner));
    if (failed === 0) toast.success(`${ids.length} deal${ids.length === 1 ? '' : 's'} assigned to ${employeeName(bulkOwner)}`);
    else toast.error(`${failed} of ${ids.length} couldn't be assigned — try those again`);
    setSelected(new Set());
    setBulkOwner('');
    setBulkBusy(false);
    refreshCounts();
  };

  const handleLinkOwner = async (row: ExternalOwnerRow, ownerId: string) => {
    if (!ownerId) return;
    setMappingBusy(row.externalOwnerRef);
    try {
      const result = await dealsService.upsertOwnerMapping({
        provider: row.provider,
        externalOwnerRef: row.externalOwnerRef,
        externalOwnerLabel: row.externalOwnerLabel,
        ownerId,
      });
      toast.success(
        `${row.externalOwnerLabel ?? 'CRM owner'} linked to ${result.mapping?.ownerName ?? employeeName(ownerId)} — ${result.dealCount} deal${result.dealCount === 1 ? '' : 's'} assigned`,
      );
      void queryClient.invalidateQueries({ queryKey: ['deal-owner-mappings'] });
      void queryClient.invalidateQueries({ queryKey: ['deal-assignment'] });
      refreshCounts();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setMappingBusy(null);
    }
  };

  const allOnPageSelected = deals.length > 0 && deals.every((d) => selected.has(d._id));
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) deals.forEach((d) => next.delete(d._id));
      else deals.forEach((d) => next.add(d._id));
      return next;
    });
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const viewCards: ChoiceCardItem<View>[] = [
    {
      id: 'needsOwner',
      label: 'Needs an owner',
      description: 'Deals nobody in HaiVE owns yet — their numbers count for no one',
      icon: FiAlertCircle,
      count: needsCount,
      tone: needsCount ? 'warning' : 'success',
    },
    { id: 'all', label: 'All deals', description: 'Every deal, with who owns it now', icon: FiUsers, count: allCount, tone: 'neutral' },
  ];

  const employeeOptions: MultiSelectOption[] = employees.map((e) => ({ value: e.id, label: e.name }));

  return (
    <>
      <ChoiceCards ariaLabel="Which deals to show" items={viewCards} activeId={view} onChange={setView} />

      {mappings.length > 0 && (
        <SettingsSection
          icon={<FiLink />}
          title="Link CRM owners"
          description="Deals synced from your CRM carry the CRM's own owner. Link each one to a HaiVE user once, and all of their deals — now and future syncs — are assigned automatically."
          actions={
            unlinked.length > 0 ? <Badge variant="warning">{unlinked.length} not linked</Badge> : <Badge variant="success">All linked</Badge>
          }
        >
          <button type="button" className={styles.mappingToggle} onClick={() => setMappingsOpen((o) => !o)} aria-expanded={mappingsOpen}>
            {mappingsOpen ? 'Hide' : 'Show'} {mappings.length} CRM owner{mappings.length === 1 ? '' : 's'}
            <FiChevronDown className={clsx(styles.chevron, mappingsOpen && styles.chevronOpen)} />
          </button>
          <AnimatePresence initial={false}>
            {mappingsOpen && (
              <motion.div
                className={styles.mappingList}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              >
                {[...unlinked, ...mappings.filter((m) => m.mapping)].map((m) => {
                  const choice = mappingChoice[m.externalOwnerRef] ?? m.mapping?.ownerId ?? '';
                  return (
                    <div key={`${m.provider}:${m.externalOwnerRef}`} className={styles.mappingRow}>
                      <div className={styles.mappingWho}>
                        <span className={styles.mappingName}>{m.externalOwnerLabel ?? m.externalOwnerRef}</span>
                        <span className={styles.mappingMeta}>
                          {m.provider} · {m.dealCount} deal{m.dealCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      {m.mapping ? (
                        <span className={styles.linked}>
                          <FiCheck /> {m.mapping.ownerName ?? 'Linked'}
                        </span>
                      ) : m.suggestedOwnerId && !mappingChoice[m.externalOwnerRef] ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          leftIcon={<FiLink />}
                          loading={mappingBusy === m.externalOwnerRef}
                          onClick={() => void handleLinkOwner(m, m.suggestedOwnerId!)}
                        >
                          Link to {m.suggestedOwnerName}
                        </Button>
                      ) : null}
                      <div className={styles.mappingPick}>
                        <select
                          className={styles.select}
                          value={choice}
                          aria-label={`HaiVE user for ${m.externalOwnerLabel ?? m.externalOwnerRef}`}
                          onChange={(e) => setMappingChoice((prev) => ({ ...prev, [m.externalOwnerRef]: e.target.value }))}
                        >
                          <option value="">{m.mapping ? 'Change to…' : 'Choose a user…'}</option>
                          {employees.map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          size="sm"
                          disabled={!mappingChoice[m.externalOwnerRef] || mappingChoice[m.externalOwnerRef] === m.mapping?.ownerId}
                          loading={mappingBusy === m.externalOwnerRef}
                          onClick={() => void handleLinkOwner(m, mappingChoice[m.externalOwnerRef])}
                        >
                          {m.mapping ? 'Relink' : 'Link'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </SettingsSection>
      )}

      <SettingsSection
        icon={<FiShuffle />}
        title={view === 'needsOwner' ? 'Deals that need an owner' : 'All deals'}
        description="The owner is who a deal counts for — their dashboard, targets and leaderboard all use it. Tick several deals to assign them in one go."
      >
        <div className={styles.toolbar}>
          <div className={styles.searchField}>
            <Input
              leftIcon={<FiSearch />}
              placeholder="Search deals by name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search deals"
            />
          </div>
          <MultiSelectDropdown label="Status" options={STATUS_OPTIONS} selected={statuses} onChange={setStatuses} />
          {view === 'all' && employeeOptions.length > 0 && (
            <MultiSelectDropdown label="Owner" options={employeeOptions} selected={owners} onChange={setOwners} />
          )}
          {(search || statuses.length > 0 || owners.length > 0) && (
            <button
              type="button"
              className={styles.clear}
              onClick={() => {
                setSearch('');
                setStatuses([]);
                setOwners([]);
              }}
            >
              <FiX /> Clear
            </button>
          )}
        </div>

        <AnimatePresence initial={false}>
          {selected.size > 0 && (
            <motion.div
              className={styles.bulkBar}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className={styles.bulkInner}>
                <span className={styles.bulkCount}>
                  <FiUserCheck /> {selected.size} selected
                </span>
                <select className={styles.select} value={bulkOwner} onChange={(e) => setBulkOwner(e.target.value)} aria-label="Assign selected to">
                  <option value="">Assign to…</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
                <Button type="button" size="sm" disabled={!bulkOwner} loading={bulkBusy} onClick={() => void handleBulkAssign()}>
                  Assign {selected.size}
                </Button>
                <button type="button" className={styles.clear} onClick={() => setSelected(new Set())}>
                  Cancel
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {isLoading ? (
          <div className={styles.skeletons}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={52} />
            ))}
          </div>
        ) : deals.length === 0 ? (
          view === 'needsOwner' && !filters.search && !filters.dealStatus ? (
            <EmptyState icon={FiUserCheck} title="Every deal has an owner" description="New deals without one will show up here." />
          ) : (
            <EmptyState icon={FiSearch} title="No deals match" description="Try another search or status." />
          )
        ) : (
          <div className={clsx(styles.tableArea, isFetching && styles.refreshing)}>
            {isFetching && <span className={styles.refreshLine} aria-label="Updating" />}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.checkCol}>
                      <input type="checkbox" checked={allOnPageSelected} onChange={toggleAll} aria-label="Select all on this page" />
                    </th>
                    <th>Deal</th>
                    <th>Customer</th>
                    <th>Status</th>
                    <th className={styles.valueCol}>Value</th>
                    <th>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {deals.map((d) => (
                    <tr
                      key={`${d._id}:${flash[d._id] ?? 0}`}
                      className={clsx(selected.has(d._id) && styles.rowSelected, flash[d._id] && styles.rowFlash)}
                    >
                      <td className={styles.checkCol}>
                        <input
                          type="checkbox"
                          checked={selected.has(d._id)}
                          onChange={() => toggleOne(d._id)}
                          aria-label={`Select ${d.name}`}
                        />
                      </td>
                      <td>
                        <span className={styles.dealName}>{d.name}</span>
                        {d.expectedClosingDate && <span className={styles.dealMeta}>Closes {d.expectedClosingDate}</span>}
                      </td>
                      <td className={styles.customer}>{d.customerName ?? '—'}</td>
                      <td>
                        <Badge variant={STATUS_VARIANT[d.dealStatus]}>{d.dealStatus}</Badge>
                      </td>
                      <td className={styles.valueCol}>{formatINR(d.monetaryValue)}</td>
                      <td>
                        <div className={styles.ownerCell}>
                          {d.ownershipStatus === 'assigned' ? (
                            <Avatar name={d.ownerName ?? '?'} size="sm" />
                          ) : (
                            <span className={clsx(styles.ownerDot, d.ownershipStatus === 'pending_mapping' && styles.ownerDotPending)} />
                          )}
                          <select
                            className={clsx(styles.ownerSelect, d.ownershipStatus !== 'assigned' && styles.ownerSelectEmpty)}
                            value={d.ownerId ?? ''}
                            disabled={assigning[d._id]}
                            onChange={(e) => void handleAssign(d, e.target.value)}
                            aria-label={`Owner of ${d.name}`}
                          >
                            <option value="">{d.ownershipStatus === 'pending_mapping' ? 'Not linked yet' : 'Unassigned'}</option>
                            {d.ownerId && !employees.some((e) => e.id === d.ownerId) && (
                              <option value={d.ownerId}>{d.ownerName ?? 'Unknown user'}</option>
                            )}
                            {employees.map((e) => (
                              <option key={e.id} value={e.id}>
                                {e.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        {/* The CRM does name an owner here — it just isn't linked to a HaiVE user. Never "Unassigned". */}
                        {d.ownershipStatus === 'pending_mapping' && (
                          <span className={styles.crmOwner}>CRM owner: {d.externalOwnerLabel ?? d.externalOwnerRef}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.pagination}>
              <span className={styles.paginationText}>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} deal{total === 1 ? '' : 's'}
              </span>
              {totalPages > 1 && (
                <div className={styles.paginationControls}>
                  <Button type="button" variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <span className={styles.paginationText}>
                    Page {page} of {totalPages}
                  </span>
                  <Button type="button" variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </SettingsSection>
    </>
  );
}

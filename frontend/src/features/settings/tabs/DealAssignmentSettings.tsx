import { useEffect, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { FiSearch } from 'react-icons/fi';
import { Badge, Button, Input, MultiSelectDropdown, Skeleton, type MultiSelectOption } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { formatINR } from '@/utils/currency';
import { usersService, type AdminUser } from '@/services/usersService';
import { dealsService, type AssignmentDealRow, type DealFilters } from '@/services/dealsService';
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

export function DealAssignmentSettings() {
  const [employees, setEmployees] = useState<AdminUser[]>([]);

  const [filters, setFilters] = useState<DealFilters>({});
  const [page, setPage] = useState(1);
  const [deals, setDeals] = useState<AssignmentDealRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState<Record<string, boolean>>({});

  const loadStatic = async () => {
    try {
      const userList = await usersService.list();
      setEmployees(userList.filter((u) => u.roles.includes('manager') || u.roles.includes('consultant')));
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const loadDeals = async () => {
    setLoading(true);
    try {
      const result = await dealsService.listForAssignment(filters, page, PAGE_SIZE);
      setDeals(result.items);
      setTotal(result.total);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatic();
  }, []);

  useEffect(() => {
    void loadDeals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page]);

  // Filters/toggle changes reset to page 1 in the same handler that updates
  // them (not via a separate effect keyed off filters) — batches into one
  // render, avoiding a stale-page fetch immediately followed by a
  // page-1 refetch.
  const updateFilters = (patch: Partial<DealFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  };

  const employeeName = (id?: string) => employees.find((e) => e.id === id)?.name;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleAssign = async (dealId: string, ownerId: string) => {
    setAssigning((prev) => ({ ...prev, [dealId]: true }));
    try {
      await dealsService.assign(dealId, ownerId || null);
      toast.success(ownerId ? `Assigned to ${employeeName(ownerId)}` : 'Unassigned');
      await loadDeals();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setAssigning((prev) => ({ ...prev, [dealId]: false }));
    }
  };

  const ownerCell = (d: AssignmentDealRow) => {
    const badge: ReactNode =
      d.ownershipStatus === 'assigned' ? (
        <Badge variant="success">{d.ownerName ?? 'Unknown user'}</Badge>
      ) : (
        <Badge variant="neutral">Unassigned</Badge>
      );
    return (
      <div className={styles.ownerCell}>
        {badge}
        <select
          className={styles.select}
          value={d.ownerId ?? ''}
          disabled={assigning[d._id]}
          onChange={(e) => void handleAssign(d._id, e.target.value)}
        >
          <option value="">Unassigned</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>
    );
  };

  return (
    <SettingsSection
      title="Deal Assignment"
      description="Assign each deal to the employee who owns it — this is what drives real numbers on that person's individual dashboard."
    >
      <div className={styles.filterBar}>
        <div className={styles.filterRow}>
          <div className={styles.valueField} style={{ width: 240 }}>
            <Input
              leftIcon={<FiSearch />}
              placeholder="Search deals by name"
              value={filters.search ?? ''}
              onChange={(e) => updateFilters({ search: e.target.value || undefined })}
            />
          </div>
          <MultiSelectDropdown
            label="Status"
            options={STATUS_OPTIONS}
            selected={filters.dealStatus ?? []}
            onChange={(v) => updateFilters({ dealStatus: v.length ? (v as DealFilters['dealStatus']) : undefined })}
          />
        </div>
      </div>

      {loading ? (
        <Skeleton height={280} />
      ) : deals.length === 0 ? (
        <div className={styles.emptyState}>No deals match this filter.</div>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Customer / Account</th>
                  <th>Status</th>
                  <th>Deal Owner</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((d) => (
                  <tr key={d._id}>
                    <td>
                      <div className={styles.listItemMain}>
                        <span className={styles.listItemTitle}>{d.name}</span>
                      </div>
                    </td>
                    <td>
                      <div className={styles.listItemMain}>
                        <span className={styles.listItemTitle}>{d.customerName ?? '—'}</span>
                      </div>
                    </td>
                    <td>
                      <Badge variant={STATUS_VARIANT[d.dealStatus]}>{d.dealStatus}</Badge>
                    </td>
                    <td>{ownerCell(d)}</td>
                    <td>{formatINR(d.monetaryValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.paginationRow}>
            <span className={styles.paginationText}>{total} deal{total === 1 ? '' : 's'}</span>
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
        </>
      )}
    </SettingsSection>
  );
}

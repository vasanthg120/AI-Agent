import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiDroplet, FiMoreHorizontal, FiPlus } from 'react-icons/fi';
import { Avatar, Button, Dropdown, EmptyState, IconButton } from '@/components/ui';
import { ConfirmDialog, DataTable, Pagination, TableToolbar } from '@/components/board';
import type { DataTableColumn, DataTableSort } from '@/components/board';
import { decorationsService, type Decoration } from '@/services/decorationsService';
import type { VendorOption } from '@/services/vendorsService';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { extractErrorMessage } from '@/utils/errors';
import tabStyles from '../tabs.module.css';
import styles from './catalog.module.css';

const PAGE_SIZE = 25;
// Deterministic per-decoration color for the name icon — no avatarColor
// field exists on this entity (unlike chat agents/roles), so this is
// computed client-side from the decoration's own id rather than invented
// per-render randomness.
const PALETTE = ['#ed7e2c', '#2563eb', '#16a34a', '#dc2626', '#7c3aed', '#0891b2', '#ca8a04', '#db2777'];
function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function DecorationsTable({
  vendorOptions,
  onAdd,
  onEdit,
}: {
  vendorOptions: VendorOption[];
  onAdd: () => void;
  onEdit: (decoration: Decoration) => void;
}) {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [vendorId, setVendorId] = useState('');
  const [sort, setSort] = useState<DataTableSort>({ key: 'name', direction: 'asc' });
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState<Decoration | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['catalog', 'decorations', { search, vendorId, sort, page }],
    queryFn: () =>
      decorationsService.listFiltered(
        { search: search || undefined, vendorId: vendorId || undefined, sortBy: sort.key as 'name' | 'category', sortDir: sort.direction },
        page,
        PAGE_SIZE,
      ),
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: (id: string) => decorationsService.remove(id),
    onSuccess: () => {
      toast.success('Decoration removed');
      void queryClient.invalidateQueries({ queryKey: ['catalog', 'decorations'] });
      setRemoving(null);
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const vendorName = (id?: string) => vendorOptions.find((v) => v._id === id)?.name ?? '—';

  const columns: DataTableColumn<Decoration>[] = [
    {
      key: 'name',
      header: 'Name',
      alwaysVisible: true,
      sortable: true,
      render: (d) => (
        <span className={styles.nameCell}>
          <Avatar name={d.name} color={colorFor(d._id)} size="sm" />
          <strong>{d.name}</strong>
        </span>
      ),
    },
    { key: 'category', header: 'Category', sortable: true, render: (d) => d.category },
    { key: 'vendor', header: 'Vendor', render: (d) => vendorName(d.vendorId) },
    { key: 'setupCost', header: 'Setup Cost', align: 'right', render: (d) => `$${d.setupCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
    {
      key: 'actions',
      header: '',
      render: (d) => (
        <Dropdown
          align="right"
          usePortal
          trigger={<IconButton icon={<FiMoreHorizontal />} size="sm" label={`Actions for ${d.name}`} />}
          items={[
            { id: 'edit', label: 'Edit', onSelect: () => onEdit(d) },
            { id: 'remove', label: 'Remove', danger: true, separatorBefore: true, onSelect: () => setRemoving(d) },
          ]}
        />
      ),
    },
  ];

  return (
    <>
      <TableToolbar
        searchValue={searchInput}
        onSearchChange={(v) => {
          setSearchInput(v);
          setPage(1);
        }}
        searchPlaceholder="Search decorations"
        filters={
          <select
            aria-label="Vendor"
            className={tabStyles.inlineSelect}
            value={vendorId}
            onChange={(e) => {
              setVendorId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All vendors</option>
            {vendorOptions.map((v) => (
              <option key={v._id} value={v._id}>
                {v.name}
              </option>
            ))}
          </select>
        }
      />

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(d) => d._id}
        loading={isLoading}
        busy={isFetching}
        sort={sort}
        onSortChange={(key) => setSort((s) => ({ key, direction: s.key === key && s.direction === 'asc' ? 'desc' : 'asc' }))}
        emptyState={
          <EmptyState
            icon={FiDroplet}
            title="No Decorations Yet"
            action={
              <Button type="button" leftIcon={<FiPlus />} onClick={onAdd}>
                Add decoration
              </Button>
            }
          />
        }
      />

      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} itemLabel="decorations" onPageChange={setPage} />}

      {removing && (
        <ConfirmDialog
          open
          title="Remove decoration?"
          description={`"${removing.name}" will be permanently removed from the catalog.`}
          confirmLabel="Remove"
          danger
          confirmLoading={remove.isPending}
          onConfirm={() => remove.mutate(removing._id)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}

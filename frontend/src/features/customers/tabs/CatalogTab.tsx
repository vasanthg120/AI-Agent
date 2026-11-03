import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiPackage, FiPlus } from 'react-icons/fi';
import { Badge, Button, Input, PageHeader, Switch } from '@/components/ui';
import { ConfirmDialog, DataTable, Pagination, TableToolbar } from '@/components/board';
import type { DataTableColumn } from '@/components/board';
import { productsService, type CreateProductPayload, type Product } from '@/services/productsService';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { extractErrorMessage } from '@/utils/errors';
import customerStyles from '../customers.module.css';
import styles from './tabs.module.css';

const PAGE_SIZE = 25;
const CURRENCIES = ['USD', 'INR', 'GBP', 'EUR'];

// Hoops-parity — the Catalog board, in-page inside /customers. There was no
// UI for the existing, already-complete Product backend
// (products.controller.ts) before this; this is a straightforward list +
// create + activate/deactivate against that real API, not a shell.
export const CatalogTab = memo(function CatalogTab({ tabs, offstage }: { tabs: ReactNode; offstage: boolean }) {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [isActive, setIsActive] = useState<boolean | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['catalog', 'products', { search, isActive, page }],
    queryFn: () => productsService.listFiltered({ search: search || undefined, isActive }, page, PAGE_SIZE),
    placeholderData: keepPreviousData,
    enabled: !offstage,
  });

  const toggleActive = useMutation({
    mutationFn: (product: Product) => (product.isActive ? productsService.deactivate(product._id) : productsService.activate(product._id)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['catalog', 'products'] }),
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const columns: DataTableColumn<Product>[] = [
    { key: 'name', header: 'Name', alwaysVisible: true, render: (p) => <strong>{p.name}</strong> },
    { key: 'sku', header: 'SKU', render: (p) => p.sku ?? '—' },
    { key: 'description', header: 'Description', render: (p) => p.description ?? '—' },
    {
      key: 'unitPrice',
      header: 'Unit price',
      align: 'right',
      render: (p) => `${p.currency} ${p.unitPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) => <Badge variant={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'Active' : 'Inactive'}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      render: (p) => (
        <Switch
          checked={p.isActive}
          ariaLabel={p.isActive ? `Deactivate ${p.name}` : `Activate ${p.name}`}
          disabled={toggleActive.isPending}
          onChange={() => toggleActive.mutate(p)}
        />
      ),
    },
  ];

  return (
    <div className={customerStyles.page} hidden={offstage}>
      {tabs}
      <PageHeader
        icon={FiPackage}
        title="Catalog"
        subtitle="Every product and service you sell, with its price."
        actions={
          <Button type="button" leftIcon={<FiPlus />} onClick={() => setCreating(true)}>
            Add product
          </Button>
        }
      />

      <TableToolbar
        searchValue={searchInput}
        onSearchChange={(v) => {
          setSearchInput(v);
          setPage(1);
        }}
        searchPlaceholder="Search name, SKU or description"
        filters={
          <select
            aria-label="Status"
            className={styles.inlineSelect}
            value={isActive === undefined ? '' : String(isActive)}
            onChange={(e) => {
              setIsActive(e.target.value === '' ? undefined : e.target.value === 'true');
              setPage(1);
            }}
          >
            <option value="">Any status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        }
      />

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(p) => p._id}
        loading={isLoading}
        busy={isFetching}
        emptyState={<p className={customerStyles.none}>No products match this view.</p>}
      />

      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} itemLabel="products" onPageChange={setPage} />}

      {creating && (
        <CreateProductDialog
          onClose={() => setCreating(false)}
          onCreated={() => void queryClient.invalidateQueries({ queryKey: ['catalog', 'products'] })}
        />
      )}
    </div>
  );
});

function CreateProductDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<CreateProductPayload>({ name: '', unitPrice: 0, currency: 'USD', isActive: true });

  const create = useMutation({
    mutationFn: () => productsService.create(form),
    onSuccess: () => {
      toast.success('Product added');
      onCreated();
      onClose();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  return (
    <ConfirmDialog
      open
      title="Add product"
      confirmLabel="Add product"
      confirmLoading={create.isPending}
      onConfirm={() => create.mutate()}
      onCancel={onClose}
    >
      <div className={styles.form}>
        <Input label="Name" value={form.name} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <Input
          label="SKU"
          value={form.sku ?? ''}
          maxLength={80}
          onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
        />
        <Input
          label="Description"
          value={form.description ?? ''}
          maxLength={500}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
        <div className={styles.formRow}>
          <Input
            label="Unit price"
            type="number"
            min={0}
            step="any"
            value={form.unitPrice}
            onChange={(e) => setForm((f) => ({ ...f, unitPrice: Number(e.target.value) }))}
          />
          <label className={styles.selectField}>
            <span>Currency</span>
            <select value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </ConfirmDialog>
  );
}

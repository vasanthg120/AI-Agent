import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiImage, FiMoreHorizontal, FiPlus } from 'react-icons/fi';
import { Button, Dropdown, EmptyState, IconButton, Skeleton } from '@/components/ui';
import { TableToolbar, Pagination } from '@/components/board';
import { productsService, type Product, type ProductKind } from '@/services/productsService';
import type { VendorOption } from '@/services/vendorsService';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { extractErrorMessage } from '@/utils/errors';
import { useProductImageUrl } from './useProductImageUrl';
import tabStyles from '../tabs.module.css';
import styles from './catalog.module.css';

const PAGE_SIZE = 30;

export function ProductsGrid({
  kind,
  vendorOptions,
  onAdd,
  onEdit,
}: {
  kind: ProductKind;
  vendorOptions: VendorOption[];
  onAdd: () => void;
  onEdit: (product: Product) => void;
}) {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [isActive, setIsActive] = useState<boolean | undefined>(undefined);
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['catalog', 'products', kind, { search, isActive, page }],
    queryFn: () => productsService.listFiltered({ search: search || undefined, isActive, kind }, page, PAGE_SIZE),
    placeholderData: keepPreviousData,
  });

  const toggleActive = useMutation({
    mutationFn: (product: Product) => (product.isActive ? productsService.deactivate(product._id) : productsService.activate(product._id)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['catalog', 'products', kind] }),
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const addLabel = kind === 'prebuilt' ? 'Add pre-built item' : 'Add product';
  const emptyTitle = kind === 'prebuilt' ? 'No Pre-Built Items Yet' : 'No Products Yet';

  return (
    <>
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
            className={tabStyles.inlineSelect}
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

      {isLoading ? (
        <div className={styles.grid}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height={220} />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        <EmptyState
          icon={FiImage}
          title={emptyTitle}
          action={
            <Button type="button" leftIcon={<FiPlus />} onClick={onAdd}>
              {addLabel}
            </Button>
          }
        />
      ) : (
        <div className={styles.grid} aria-busy={isFetching}>
          {data?.items.map((product) => (
            <ProductCard
              key={product._id}
              product={product}
              vendorOptions={vendorOptions}
              onEdit={() => onEdit(product)}
              onToggleActive={() => toggleActive.mutate(product)}
              toggling={toggleActive.isPending}
            />
          ))}
        </div>
      )}

      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} itemLabel={kind === 'prebuilt' ? 'items' : 'products'} onPageChange={setPage} />}
    </>
  );
}

function ProductCard({
  product,
  vendorOptions,
  onEdit,
  onToggleActive,
  toggling,
}: {
  product: Product;
  vendorOptions: VendorOption[];
  onEdit: () => void;
  onToggleActive: () => void;
  toggling: boolean;
}) {
  const imageUrl = useProductImageUrl(product._id, product.imageFileId);
  const vendorName = vendorOptions.find((v) => v._id === product.vendorId)?.name;

  return (
    <div className={styles.card}>
      <div className={styles.cardImage}>{imageUrl ? <img src={imageUrl} alt={product.name} /> : <FiImage aria-hidden />}</div>
      <div className={styles.cardBody}>
        {(vendorName || product.sku) && (
          <span className={styles.cardVendor}>
            {[vendorName, product.sku].filter(Boolean).join(' | ')}
          </span>
        )}
        <span className={styles.cardName}>{product.name}</span>
      </div>
      <Dropdown
        align="right"
        usePortal
        className={styles.cardMenu}
        trigger={<IconButton icon={<FiMoreHorizontal />} size="sm" label={`Actions for ${product.name}`} disabled={toggling} />}
        items={[
          { id: 'edit', label: 'Edit', onSelect: onEdit },
          {
            id: 'toggle',
            label: product.isActive ? 'Deactivate' : 'Activate',
            onSelect: onToggleActive,
            separatorBefore: true,
          },
        ]}
      />
    </div>
  );
}

import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FiChevronDown, FiPackage, FiPlus } from 'react-icons/fi';
import { Button, Dropdown, PageHeader, Tabs } from '@/components/ui';
import type { Product } from '@/services/productsService';
import { vendorsService } from '@/services/vendorsService';
import type { Decoration } from '@/services/decorationsService';
import { AddDecorationDialog } from './catalog/AddDecorationDialog';
import { AddProductDialog } from './catalog/AddProductDialog';
import { DecorationsTable } from './catalog/DecorationsTable';
import { ImportDecorationDialog } from './catalog/ImportDecorationDialog';
import { ProductsGrid } from './catalog/ProductsGrid';
import customerStyles from '../customers.module.css';

const SUB_TABS = [
  { id: 'products', label: 'Products' },
  { id: 'prebuilt', label: 'Pre-Built Items' },
  { id: 'decorations', label: 'Decorations' },
];

type AddDialog = null | 'product' | 'decoration' | 'import';

// Hoops-parity — the Catalog board, in-page inside /customers. Products,
// Pre-Built Items and Decorations are Hoops' own three sub-tabs under one
// "Add to Catalog" dropdown (Add Product / Add Decoration / Import
// Decoration) — demonstrated in the reference video as a single header
// control available regardless of which sub-tab is active, not one scoped
// per tab, so that's reproduced here exactly rather than split three ways.
export const CatalogTab = memo(function CatalogTab({ tabs, offstage }: { tabs: ReactNode; offstage: boolean }) {
  const [subTab, setSubTab] = useState('products');
  const [addDialog, setAddDialog] = useState<AddDialog>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingDecoration, setEditingDecoration] = useState<Decoration | null>(null);

  const vendors = useQuery({
    queryKey: ['vendors', 'picker'],
    queryFn: () => vendorsService.listPicker(),
    enabled: !offstage,
    staleTime: 60_000,
  });
  const vendorOptions = vendors.data ?? [];

  return (
    <div className={customerStyles.page} hidden={offstage}>
      {tabs}
      <PageHeader
        icon={FiPackage}
        title="Catalog"
        subtitle="Every product and service you sell, with its price."
        actions={
          <Dropdown
            align="right"
            trigger={
              <Button type="button" leftIcon={<FiPlus />} rightIcon={<FiChevronDown />}>
                Add to Catalog
              </Button>
            }
            items={[
              { id: 'product', label: subTab === 'prebuilt' ? 'Add Pre-Built Item' : 'Add Product', onSelect: () => setAddDialog('product') },
              { id: 'decoration', label: 'Add Decoration', separatorBefore: true, onSelect: () => setAddDialog('decoration') },
              { id: 'import', label: 'Import Decoration', onSelect: () => setAddDialog('import') },
            ]}
          />
        }
      />

      <Tabs items={SUB_TABS} activeId={subTab} onChange={setSubTab} />

      {subTab === 'products' && (
        <ProductsGrid kind="product" vendorOptions={vendorOptions} onAdd={() => setAddDialog('product')} onEdit={setEditingProduct} />
      )}
      {subTab === 'prebuilt' && (
        <ProductsGrid kind="prebuilt" vendorOptions={vendorOptions} onAdd={() => setAddDialog('product')} onEdit={setEditingProduct} />
      )}
      {subTab === 'decorations' && (
        <DecorationsTable vendorOptions={vendorOptions} onAdd={() => setAddDialog('decoration')} onEdit={setEditingDecoration} />
      )}

      {(addDialog === 'product' || editingProduct) && (
        <AddProductDialog
          product={editingProduct}
          kind={subTab === 'prebuilt' ? 'prebuilt' : 'product'}
          vendorOptions={vendorOptions}
          onClose={() => {
            setAddDialog(null);
            setEditingProduct(null);
          }}
        />
      )}

      {(addDialog === 'decoration' || editingDecoration) && (
        <AddDecorationDialog
          decoration={editingDecoration}
          vendorOptions={vendorOptions}
          onClose={() => {
            setAddDialog(null);
            setEditingDecoration(null);
          }}
        />
      )}

      {addDialog === 'import' && <ImportDecorationDialog vendorOptions={vendorOptions} onClose={() => setAddDialog(null)} />}
    </div>
  );
});

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiPlus, FiSearch } from 'react-icons/fi';
import { Badge, Button, Input, Modal, Skeleton, Switch } from '@/components/ui';
import { formatCurrency } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { productsService, type Product } from '@/services/productsService';
import { ROUTES } from '@/constants/routes';
import styles from './quotes.module.css';

const emptyForm = { name: '', sku: '', description: '', unitPrice: '', currency: 'INR', isActive: true };

// New — minimal product/service master management, matching this app's
// existing list-table-plus-modal CRUD convention (see AdminFeaturesPage.tsx).
// Deliberately no inventory/stock/vendor/price-list UI, matching the Quotes
// in Pipeline V1 plan's explicit scope.
export function ProductsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['quote-products', search],
    queryFn: () => productsService.listFiltered({ search: search || undefined }, 1, 100),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['quote-products'] });

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setModalOpen(true);
  };

  const openEdit = (product: Product) => {
    setEditing(product);
    setForm({
      name: product.name,
      sku: product.sku ?? '',
      description: product.description ?? '',
      unitPrice: String(product.unitPrice),
      currency: product.currency,
      isActive: product.isActive,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    if (!form.name.trim() || form.unitPrice === '' || Number(form.unitPrice) < 0) {
      toast.error('Name and a valid unit price are required.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: form.name.trim(),
        sku: form.sku.trim() || undefined,
        description: form.description.trim() || undefined,
        unitPrice: Number(form.unitPrice),
        currency: form.currency,
        isActive: form.isActive,
      };
      if (editing) {
        await productsService.update(editing._id, payload);
        toast.success('Product updated');
      } else {
        await productsService.create(payload);
        toast.success('Product created');
      }
      setModalOpen(false);
      await invalidate();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (product: Product) => {
    try {
      if (product.isActive) await productsService.deactivate(product._id);
      else await productsService.activate(product._id);
      await invalidate();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.pageTitle}>Products &amp; Services</h1>
          <p className={styles.pageSubtitle}>The catalog quote line items are priced from.</p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" onClick={() => navigate(ROUTES.quotes)}>
            Back to Quotes
          </Button>
          <Button leftIcon={<FiPlus />} onClick={openCreate}>
            New Product
          </Button>
        </div>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.valueField} style={{ width: 280 }}>
          <Input leftIcon={<FiSearch />} placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {isLoading ? (
        <Skeleton height={280} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className={styles.emptyState}>No products yet — create one to start pricing quotes.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>SKU</th>
                <th>Unit price</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((p) => (
                <tr key={p._id}>
                  <td>
                    <div className={styles.listItemMain}>
                      <span className={styles.listItemTitle}>{p.name}</span>
                      {p.description && <span className={styles.listItemMeta}>{p.description}</span>}
                    </div>
                  </td>
                  <td>{p.sku ?? '—'}</td>
                  <td>{formatCurrency(p.unitPrice, p.currency)}</td>
                  <td>
                    <Badge variant={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'active' : 'inactive'}</Badge>
                  </td>
                  <td style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Button size="sm" variant="secondary" onClick={() => openEdit(p)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void toggleActive(p)}>
                      {p.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Product' : 'New Product'}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="SKU (optional)" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
          <Input label="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Input
            label="Unit price"
            type="number"
            min={0}
            value={form.unitPrice}
            onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
          />
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Currency</span>
            <select className={styles.select} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option value="INR">INR</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
            </select>
          </div>
          <Switch checked={form.isActive} onChange={(isActive) => setForm({ ...form, isActive })} label="Active" />
          <Button fullWidth loading={submitting} onClick={() => void submit()}>
            {editing ? 'Save Changes' : 'Create Product'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

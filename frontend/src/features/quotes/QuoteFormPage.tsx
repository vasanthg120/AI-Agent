import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiPlus, FiX } from 'react-icons/fi';
import { Button, IconButton, Input, Skeleton } from '@/components/ui';
import { formatCurrency } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { dealsService } from '@/services/dealsService';
import { productsService } from '@/services/productsService';
import { quotesService, type QuoteLineItemInput } from '@/services/quotesService';
import { ROUTES } from '@/constants/routes';
import styles from './quotes.module.css';

interface FormLineItem extends QuoteLineItemInput {
  key: string;
}

const emptyItem = (): FormLineItem => ({
  key: Math.random().toString(36).slice(2),
  productId: undefined,
  description: '',
  quantity: 1,
  unitPrice: 0,
  discount: 0,
  taxRate: 0,
});

// Client-side mirror of the backend's exact formula (quote-pricing.util.ts)
// — a live preview only. The backend always recomputes authoritatively on
// submit; nothing calculated here is ever sent as a trusted total.
function previewLineTotal(item: FormLineItem): { lineSubtotal: number; lineTotal: number } {
  const lineSubtotal = item.quantity * item.unitPrice;
  const discounted = lineSubtotal - (item.discount ?? 0);
  const tax = discounted * ((item.taxRate ?? 0) / 100);
  return { lineSubtotal, lineTotal: discounted + tax };
}

// Shared create (/quotes/new) and edit (/quotes/:id/edit) form — the first
// native "build a priced quote" UI this app has had. Per the Quotes in
// Pipeline V1 plan: reuses Quote.clientDetails as the customer fields (no
// Customer model exists), Quote.dealId as-is for the optional deal link,
// and the new Product catalog for line-item selection.
export function QuoteFormPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const isEditing = !!id;

  const [companyName, setCompanyName] = useState('');
  const [contactName, setContactName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [dealId, setDealId] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [requestNotes, setRequestNotes] = useState('');
  const [items, setItems] = useState<FormLineItem[]>([emptyItem()]);
  const [saving, setSaving] = useState(false);
  const [blockedSynced, setBlockedSynced] = useState(false);

  const { data: existingQuote, isLoading: loadingQuote } = useQuery({
    queryKey: ['quote-edit', id],
    queryFn: () => quotesService.getOne(id!),
    enabled: isEditing,
  });

  const { data: dealOptions } = useQuery({
    queryKey: ['quote-form-deals'],
    queryFn: () => dealsService.listFiltered({}, 1, 100),
  });

  const { data: productOptions } = useQuery({
    queryKey: ['quote-form-products'],
    queryFn: () => productsService.listFiltered({ isActive: true }, 1, 100),
  });

  useEffect(() => {
    if (!existingQuote) return;
    if (existingQuote.externalId) {
      setBlockedSynced(true);
      return;
    }
    setCompanyName(existingQuote.clientDetails?.companyName ?? '');
    setContactName(existingQuote.clientDetails?.contactName ?? '');
    setEmail(existingQuote.clientDetails?.email ?? '');
    setPhone(existingQuote.clientDetails?.phone ?? '');
    setDealId(existingQuote.dealId ?? '');
    setExpirationDate(existingQuote.expirationDate ?? '');
    setDueDate(existingQuote.dueDate ?? '');
    setCurrency(existingQuote.currency ?? 'INR');
    setItems(
      existingQuote.items.length > 0
        ? existingQuote.items.map((it) => ({ ...it, key: Math.random().toString(36).slice(2) }))
        : [emptyItem()],
    );
  }, [existingQuote]);

  // Never offer a product priced in a different currency than the quote —
  // the proactive half of the currency guard (applyProduct/validate below
  // are the defensive half, for when the quote's currency changes after a
  // product was already picked).
  const productOptionsForCurrency = useMemo(
    () => productOptions?.items.filter((p) => p.currency === currency) ?? [],
    [productOptions, currency],
  );

  const totals = useMemo(() => {
    let subtotal = 0;
    let discountAmount = 0;
    let taxAmount = 0;
    let total = 0;
    for (const item of items) {
      const { lineSubtotal, lineTotal } = previewLineTotal(item);
      subtotal += lineSubtotal;
      discountAmount += item.discount ?? 0;
      taxAmount += lineTotal - (lineSubtotal - (item.discount ?? 0));
      total += lineTotal;
    }
    return { subtotal, discountAmount, taxAmount, total };
  }, [items]);

  const updateItem = (key: string, patch: Partial<FormLineItem>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  };

  const applyProduct = (key: string, productId: string) => {
    if (!productId) {
      updateItem(key, { productId: undefined });
      return;
    }
    const product = productOptions?.items.find((p) => p._id === productId);
    if (!product) return;
    // A quote must never mix currencies — reject outright rather than
    // silently converting or applying the product anyway. The dropdown
    // itself is also filtered to same-currency products (see the <select>
    // below), so this only fires if the quote's currency changed after the
    // dropdown was rendered.
    if (product.currency !== currency) {
      toast.error(`"${product.name}" is priced in ${product.currency}, but this quote is in ${currency} — pick a ${currency} product, or change the quote currency first.`);
      return;
    }
    updateItem(key, { productId, description: product.name, unitPrice: product.unitPrice });
  };

  const removeItem = (key: string) => {
    setItems((prev) => (prev.length > 1 ? prev.filter((it) => it.key !== key) : prev));
  };

  const validate = (): string | null => {
    if (items.length === 0) return 'Add at least one line item.';
    for (const item of items) {
      if (!item.description.trim()) return 'Every line item needs a description.';
      if (!(item.quantity > 0)) return 'Quantity must be greater than zero on every line item.';
      if (item.unitPrice < 0) return 'Unit price cannot be negative.';
      if ((item.discount ?? 0) < 0) return 'Discount cannot be negative.';
      if ((item.discount ?? 0) > item.quantity * item.unitPrice) return 'Discount cannot exceed a line’s subtotal.';
      const taxRate = item.taxRate ?? 0;
      if (taxRate < 0 || taxRate > 100) return 'Tax rate must be between 0 and 100.';
      // Catches the quote currency having changed after a product was
      // already added to a line — applyProduct only guards the moment of
      // selection, not a later currency-dropdown change. Skipped when the
      // referenced product isn't in the currently-loaded active list (e.g.
      // it was deactivated since) — the backend's own missing/inactive
      // checks own that case with their own specific error.
      if (item.productId) {
        const product = productOptions?.items.find((p) => p._id === item.productId);
        if (product && product.currency !== currency) {
          return `"${product.name}" is priced in ${product.currency}, but this quote is in ${currency}.`;
        }
      }
    }
    return null;
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        clientDetails: { companyName: companyName || undefined, contactName: contactName || undefined, email: email || undefined, phone: phone || undefined },
        dealId: dealId || undefined,
        expirationDate: expirationDate || undefined,
        dueDate: dueDate || undefined,
        currency,
        requestNotes: requestNotes || undefined,
        // Only the fields QuoteItemDto actually accepts — lineSubtotal/
        // lineTotal come back from the server on an existing quote's items
        // (pre-filled into this form's state for editing) but must never be
        // sent back; the backend's ValidationPipe (forbidNonWhitelisted)
        // rejects them outright since they're always server-computed.
        items: items.map((item) => ({
          productId: item.productId,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount,
          taxRate: item.taxRate,
        })),
      };
      const saved = isEditing ? await quotesService.update(id!, payload) : await quotesService.create(payload);
      toast.success(isEditing ? 'Quote updated' : 'Quote created');
      navigate(ROUTES.quoteDetail(saved._id));
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isEditing && loadingQuote) return <Skeleton height={400} />;
  if (blockedSynced) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyState}>
          This quote was synced from an external CRM and can’t be edited here — pricing/status fields are owned by that
          sync.
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Button variant="secondary" onClick={() => navigate(ROUTES.quoteDetail(id!))}>
              Back to quote
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.pageTitle}>{isEditing ? 'Edit Quote' : 'Create Quote'}</h1>
          <p className={styles.pageSubtitle}>Price a quote with real line items — totals are calculated automatically.</p>
        </div>
      </div>

      <div className={styles.formSection}>
        <span className={styles.sectionTitle}>Customer</span>
        <div className={styles.fieldGrid}>
          <Input label="Company name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          <Input label="Contact name" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>

      <div className={styles.formSection}>
        <span className={styles.sectionTitle}>Deal &amp; Validity</span>
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Linked deal (optional)</span>
            <select className={styles.select} value={dealId} onChange={(e) => setDealId(e.target.value)}>
              <option value="">No linked deal</option>
              {dealOptions?.items.map((d) => (
                <option key={d._id} value={d._id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <Input label="Valid until" type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} />
          <Input label="Due date (payment)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Currency</span>
            <select className={styles.select} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="INR">INR</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
            </select>
          </div>
        </div>
      </div>

      <div className={styles.formSection}>
        <span className={styles.sectionTitle}>Line items</span>
        <div className={styles.itemsTableWrap}>
          <table className={styles.itemsTable}>
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>Product</th>
                <th style={{ minWidth: 200 }}>Description</th>
                <th style={{ width: 90 }}>Qty</th>
                <th style={{ width: 120 }}>Unit price</th>
                <th style={{ width: 110 }}>Discount</th>
                <th style={{ width: 100 }}>Tax %</th>
                <th style={{ width: 130 }}>Line total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const { lineTotal } = previewLineTotal(item);
                return (
                  <tr key={item.key}>
                    <td>
                      <select value={item.productId ?? ''} onChange={(e) => applyProduct(item.key, e.target.value)}>
                        <option value="">Custom item</option>
                        {productOptionsForCurrency.map((p) => (
                          <option key={p._id} value={p._id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input value={item.description} onChange={(e) => updateItem(item.key, { description: e.target.value })} />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        value={item.quantity}
                        onChange={(e) => updateItem(item.key, { quantity: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        value={item.unitPrice}
                        onChange={(e) => updateItem(item.key, { unitPrice: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        value={item.discount ?? 0}
                        onChange={(e) => updateItem(item.key, { discount: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={item.taxRate ?? 0}
                        onChange={(e) => updateItem(item.key, { taxRate: Number(e.target.value) })}
                      />
                    </td>
                    <td className={styles.itemLineTotal}>{formatCurrency(lineTotal, currency)}</td>
                    <td>
                      <IconButton icon={<FiX />} label="Remove line" size="sm" disabled={items.length === 1} onClick={() => removeItem(item.key)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Button type="button" variant="outline" size="sm" leftIcon={<FiPlus />} onClick={() => setItems((prev) => [...prev, emptyItem()])}>
          Add line item
        </Button>

        <div className={styles.summaryGrid}>
          <div className={styles.summaryRow}>
            <span>Subtotal</span>
            <span>{formatCurrency(totals.subtotal, currency)}</span>
          </div>
          <div className={styles.summaryRow}>
            <span>Discount</span>
            <span>-{formatCurrency(totals.discountAmount, currency)}</span>
          </div>
          <div className={styles.summaryRow}>
            <span>Tax</span>
            <span>{formatCurrency(totals.taxAmount, currency)}</span>
          </div>
          <div className={`${styles.summaryRow} ${styles.total}`}>
            <span>Total</span>
            <span>{formatCurrency(totals.total, currency)}</span>
          </div>
        </div>
      </div>

      <div className={styles.formSection}>
        <span className={styles.sectionTitle}>Notes</span>
        <textarea
          className={styles.itemsTableWrap}
          style={{ width: '100%', minHeight: 100, padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border-strong)', background: 'var(--color-bg-input)', color: 'var(--color-text-primary)' }}
          value={requestNotes}
          onChange={(e) => setRequestNotes(e.target.value)}
        />
      </div>

      <div className={styles.footer}>
        <Button variant="ghost" onClick={() => navigate(ROUTES.quotes)} disabled={saving}>
          Cancel
        </Button>
        <Button loading={saving} onClick={() => void handleSave()}>
          {isEditing ? 'Save Changes' : 'Create Quote'}
        </Button>
      </div>
    </div>
  );
}

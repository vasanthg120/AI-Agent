import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiUploadCloud } from 'react-icons/fi';
import { Button, Input, Modal, StringListEditor } from '@/components/ui';
import { productsService, type CreateProductPayload, type Product, type ProductKind } from '@/services/productsService';
import type { VendorOption } from '@/services/vendorsService';
import { extractErrorMessage } from '@/utils/errors';
import { useProductImageUrl } from './useProductImageUrl';
import tabStyles from '../tabs.module.css';
import styles from './catalog.module.css';

const CURRENCIES = ['INR', 'USD', 'GBP', 'EUR'];

// Hoops' own "Add a Product" form: Name*/Vendor*+Product Code*/Description/
// Primary Image (single file)/Sizes*/Colors*. A Pre-Built Item is the same
// Product record with kind:'prebuilt' (see product.schema.ts's own comment)
// — Hoops' Pre-Built Items cards never show a vendor/code, so that field
// pair is skipped entirely for that kind rather than shown-but-optional.
export function AddProductDialog({
  product,
  kind,
  vendorOptions,
  onClose,
}: {
  product?: Product | null;
  kind: ProductKind;
  vendorOptions: VendorOption[];
  onClose: () => void;
}) {
  const editing = !!product;
  const [form, setForm] = useState<CreateProductPayload>(
    product
      ? {
          name: product.name,
          sku: product.sku ?? '',
          description: product.description ?? '',
          unitPrice: product.unitPrice,
          currency: product.currency,
          vendorId: product.vendorId ?? '',
          sizes: product.sizes,
          colors: product.colors,
          kind,
        }
      : { name: '', unitPrice: 0, currency: 'INR', sku: '', description: '', vendorId: '', sizes: [], colors: [], kind },
  );
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [pickedPreview, setPickedPreview] = useState<string | undefined>();
  const existingImageUrl = useProductImageUrl(product?._id ?? '', product?.imageFileId);
  const imagePreview = pickedPreview ?? existingImageUrl;
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const requiresVendor = kind === 'product';
  const nameValid = form.name.trim().length > 0;
  const vendorValid = !requiresVendor || !!form.vendorId;
  const skuValid = !requiresVendor || !!form.sku?.trim();
  const sizesValid = (form.sizes?.length ?? 0) > 0;
  const colorsValid = (form.colors?.length ?? 0) > 0;
  const canSave = nameValid && vendorValid && skuValid && sizesValid && colorsValid;

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file.');
      return;
    }
    setImageFile(file);
    setPickedPreview(URL.createObjectURL(file));
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload: CreateProductPayload = {
        ...form,
        sku: form.sku?.trim() || undefined,
        description: form.description?.trim() || undefined,
        vendorId: form.vendorId || undefined,
      };
      const saved = editing ? await productsService.update(product!._id, payload) : await productsService.create(payload);
      if (imageFile) await productsService.uploadImage(saved._id, imageFile);
      return saved;
    },
    onSuccess: () => {
      toast.success(editing ? 'Product updated' : kind === 'prebuilt' ? 'Pre-built item added' : 'Product added');
      void queryClient.invalidateQueries({ queryKey: ['catalog', 'products'] });
      void queryClient.invalidateQueries({ queryKey: ['product-image'] });
      onClose();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  return (
    <Modal open onClose={onClose} title={editing ? 'Edit product' : kind === 'prebuilt' ? 'Add a Pre-Built Item' : 'Add a Product'} maxWidth={560}>
      <div className={tabStyles.form}>
        <Input
          label="Name"
          required
          value={form.name}
          maxLength={200}
          error={!nameValid ? 'Required' : undefined}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />

        {requiresVendor && (
          <div className={tabStyles.formRow}>
            <label className={tabStyles.selectField}>
              <span>Vendor *</span>
              <select value={form.vendorId ?? ''} onChange={(e) => setForm((f) => ({ ...f, vendorId: e.target.value }))}>
                <option value="">Select vendor…</option>
                {vendorOptions.map((v) => (
                  <option key={v._id} value={v._id}>
                    {v.name}
                  </option>
                ))}
              </select>
              {!vendorValid && <span className={styles.previewError}>Required</span>}
            </label>
            <Input
              label="Product Code"
              required
              value={form.sku ?? ''}
              maxLength={80}
              error={!skuValid ? 'Required' : undefined}
              onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
            />
          </div>
        )}

        <Input
          label="Description"
          value={form.description ?? ''}
          maxLength={500}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />

        <div>
          <span className={tabStyles.selectField}>Primary Image</span>
          <p className={styles.hint}>You can only select one image for the Product's primary image.</p>
          <div
            className={dragging ? `${styles.dropzone} ${styles.dropzoneActive}` : styles.dropzone}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e: DragEvent) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              setDragging(false);
              pickFile(e.dataTransfer.files[0]);
            }}
          >
            {imagePreview ? (
              <img className={styles.dropzonePreview} src={imagePreview} alt="Primary" />
            ) : (
              <>
                <FiUploadCloud size={28} />
                <strong>Drag and Drop</strong>
                <span className={styles.hint}>your file here or click to upload</span>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
          </div>
        </div>

        <StringListEditor label="Sizes *" items={form.sizes ?? []} onChange={(sizes) => setForm((f) => ({ ...f, sizes }))} addLabel="Add size" />
        {!sizesValid && <span className={styles.previewError}>At least one size is required</span>}

        <StringListEditor label="Colors *" items={form.colors ?? []} onChange={(colors) => setForm((f) => ({ ...f, colors }))} addLabel="Add color" />
        {!colorsValid && <span className={styles.previewError}>At least one color is required</span>}

        <div className={tabStyles.formRow}>
          <Input
            label="Unit price"
            type="number"
            min={0}
            step="any"
            value={form.unitPrice}
            onChange={(e) => setForm((f) => ({ ...f, unitPrice: Number(e.target.value) }))}
          />
          <label className={tabStyles.selectField}>
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

      <div className={styles.wizardActions}>
        <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="button" loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>
          {editing ? 'Save changes' : kind === 'prebuilt' ? 'Add pre-built item' : 'Add product'}
        </Button>
      </div>
    </Modal>
  );
}

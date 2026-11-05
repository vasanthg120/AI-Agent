import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2 } from 'react-icons/fi';
import { Button, IconButton, Input, Modal } from '@/components/ui';
import { decorationsService, type CreateDecorationPayload, type Decoration, type PriceBreak } from '@/services/decorationsService';
import type { VendorOption } from '@/services/vendorsService';
import { extractErrorMessage } from '@/utils/errors';
import tabStyles from '../tabs.module.css';
import styles from './catalog.module.css';

const emptyBreak: PriceBreak = { quantity: 0, price: 0 };

// Hoops' own "Add Decoration" form: Decoration Name*/Vendor+Category*/Setup
// Cost/repeating Quantity*+Price rows with "ADD ANOTHER PRICE BREAK".
export function AddDecorationDialog({
  decoration,
  vendorOptions,
  onClose,
}: {
  decoration?: Decoration | null;
  vendorOptions: VendorOption[];
  onClose: () => void;
}) {
  const editing = !!decoration;
  const [name, setName] = useState(decoration?.name ?? '');
  const [vendorId, setVendorId] = useState(decoration?.vendorId ?? '');
  const [category, setCategory] = useState(decoration?.category ?? '');
  const [setupCost, setSetupCost] = useState(decoration?.setupCost ?? 0);
  const [priceBreaks, setPriceBreaks] = useState<PriceBreak[]>(decoration?.priceBreaks?.length ? decoration.priceBreaks : [{ ...emptyBreak }]);
  const queryClient = useQueryClient();

  const nameValid = name.trim().length > 0;
  const categoryValid = category.trim().length > 0;
  const breaksValid = priceBreaks.length > 0 && priceBreaks.every((b) => b.quantity > 0 && b.price >= 0);
  const canSave = nameValid && categoryValid && breaksValid;

  const updateBreak = (index: number, patch: Partial<PriceBreak>) =>
    setPriceBreaks((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = useMutation({
    mutationFn: () => {
      const payload: CreateDecorationPayload = { name: name.trim(), category: category.trim(), setupCost, priceBreaks, vendorId: vendorId || undefined };
      return editing ? decorationsService.update(decoration!._id, payload) : decorationsService.create(payload);
    },
    onSuccess: () => {
      toast.success(editing ? 'Decoration updated' : 'Decoration added');
      void queryClient.invalidateQueries({ queryKey: ['catalog', 'decorations'] });
      onClose();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  return (
    <Modal open onClose={onClose} title={editing ? 'Edit Decoration' : 'Add Decoration'} maxWidth={520}>
      <div className={tabStyles.form}>
        <Input label="Decoration Name" required value={name} maxLength={200} error={!nameValid ? 'Required' : undefined} onChange={(e) => setName(e.target.value)} />

        <div className={tabStyles.formRow}>
          <label className={tabStyles.selectField}>
            <span>Vendor</span>
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">No vendor (in-house)</option>
              {vendorOptions.map((v) => (
                <option key={v._id} value={v._id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <Input
            label="Category"
            required
            value={category}
            maxLength={100}
            error={!categoryValid ? 'Required' : undefined}
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>

        <Input
          label="Setup Cost"
          type="number"
          min={0}
          step="any"
          value={setupCost}
          onChange={(e) => setSetupCost(Number(e.target.value))}
        />

        <div>
          <span className={tabStyles.selectField}>Price breaks</span>
          <div className={styles.priceBreaks}>
            {priceBreaks.map((row, index) => (
              <div key={index} className={styles.priceBreakRow}>
                <Input
                  label="Quantity"
                  required
                  type="number"
                  min={1}
                  value={row.quantity || ''}
                  error={row.quantity <= 0 ? 'Required' : undefined}
                  onChange={(e) => updateBreak(index, { quantity: Number(e.target.value) })}
                />
                <Input
                  label="Price"
                  type="number"
                  min={0}
                  step="any"
                  value={row.price || ''}
                  onChange={(e) => updateBreak(index, { price: Number(e.target.value) })}
                />
                <IconButton
                  icon={<FiTrash2 />}
                  label="Remove price break"
                  disabled={priceBreaks.length === 1}
                  onClick={() => setPriceBreaks((rows) => rows.filter((_, i) => i !== index))}
                />
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.addPriceBreak}
            leftIcon={<FiPlus />}
            onClick={() => setPriceBreaks((rows) => [...rows, { ...emptyBreak }])}
          >
            Add another price break
          </Button>
        </div>
      </div>

      <div className={styles.wizardActions}>
        <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="button" loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </Modal>
  );
}

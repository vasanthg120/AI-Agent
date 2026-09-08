import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Badge, Button, Input, Modal } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  financeDocumentsService,
  type CustomerQuoteMatch,
  type FinanceDocument,
  type UpdateFinanceDocumentPayload,
} from '@/services/financeDocumentsService';
import financeStyles from '../finance.module.css';
import styles from './FinanceDocumentReviewModal.module.css';

export interface FinanceDocumentReviewModalProps {
  open: boolean;
  document: FinanceDocument | null;
  onClose: () => void;
  onSaved: (doc: FinanceDocument) => void;
  onDeleted: (id: string) => void;
}

// Wider than deal-performance/components/DealFormModal.tsx (which reviewing
// one document is the same bounded/transient task that established Modal
// for) — sectioned into Vendor&Invoice/Amounts&Tax/Bank Details/
// Classification groups, since a finance document has far more correctable
// fields than a deal. Browsing many records is a separate state-swap
// FinanceDocumentListView.tsx, not this modal.
export function FinanceDocumentReviewModal({ open, document, onClose, onSaved, onDeleted }: FinanceDocumentReviewModalProps) {
  const [form, setForm] = useState<UpdateFinanceDocumentPayload>({});
  const [saving, setSaving] = useState(false);
  const [viewingFile, setViewingFile] = useState(false);

  // Vendor Quote <-> Customer Quote linking (Finance AI "Customer Quote No"
  // field) — a separate mini flow from the rest of this form's plain
  // field-edit/save, since it has its own search -> preview -> confirm steps
  // and calls its own dedicated endpoints rather than the generic PATCH.
  const [linkedQuoteNo, setLinkedQuoteNo] = useState<string | undefined>(undefined);
  const [quoteSearchOpen, setQuoteSearchOpen] = useState(false);
  const [quoteNumberInput, setQuoteNumberInput] = useState('');
  const [searchingQuote, setSearchingQuote] = useState(false);
  const [quoteSearchError, setQuoteSearchError] = useState<string | null>(null);
  const [quoteMatches, setQuoteMatches] = useState<CustomerQuoteMatch[] | null>(null);
  const [selectedMatch, setSelectedMatch] = useState<CustomerQuoteMatch | null>(null);
  const [linkingQuote, setLinkingQuote] = useState(false);

  useEffect(() => {
    if (!open || !document) return;
    setLinkedQuoteNo(document.customerQuoteNo);
    setQuoteSearchOpen(false);
    setQuoteNumberInput('');
    setSearchingQuote(false);
    setQuoteSearchError(null);
    setQuoteMatches(null);
    setSelectedMatch(null);
    setForm({
      vendorName: document.vendorName,
      vendorId: document.vendorId,
      invoiceNumber: document.invoiceNumber,
      poNumber: document.poNumber,
      invoiceDate: document.invoiceDate,
      dueDate: document.dueDate,
      paymentDate: document.paymentDate,
      paymentAmount: document.paymentAmount,
      currency: document.currency,
      taxAmount: document.taxAmount,
      taxDetails: document.taxDetails,
      deliveryCharges: document.deliveryCharges,
      isSubscriptionPayment: document.isSubscriptionPayment,
      subscriptionProvider: document.subscriptionProvider,
      subscriptionCharges: document.subscriptionCharges,
      paymentMethod: document.paymentMethod,
      bankDetails: document.bankDetails,
      department: document.department,
      costCenter: document.costCenter,
      paymentStatus: document.paymentStatus,
      expenseCategory: document.expenseCategory,
    });
  }, [open, document]);

  if (!document) return null;

  const set = <K extends keyof UpdateFinanceDocumentPayload>(key: K, value: UpdateFinanceDocumentPayload[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  const setTax = (key: 'gstAmount' | 'vatAmount' | 'taxRatePct' | 'taxType', value: string | number | undefined) =>
    setForm((prev) => ({ ...prev, taxDetails: { ...prev.taxDetails, [key]: value } }));
  const setBank = (key: 'bankName' | 'accountNumber' | 'ifscOrSwift' | 'accountHolderName', value: string | undefined) =>
    setForm((prev) => ({ ...prev, bankDetails: { ...prev.bankDetails, [key]: value } }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await financeDocumentsService.update(document._id, form);
      toast.success('Document updated');
      onSaved(saved);
      onClose();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await financeDocumentsService.remove(document._id);
      toast.success('Document deleted');
      onDeleted(document._id);
      onClose();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const handleViewFile = async () => {
    setViewingFile(true);
    try {
      await financeDocumentsService.viewFile(document._id);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setViewingFile(false);
    }
  };

  const handleSearchQuote = async () => {
    const trimmed = quoteNumberInput.trim();
    if (!trimmed) return;
    setSearchingQuote(true);
    setQuoteSearchError(null);
    setQuoteMatches(null);
    setSelectedMatch(null);
    try {
      const results = await financeDocumentsService.searchCustomerQuote(trimmed);
      setQuoteMatches(results);
      // Exactly one match — show its preview immediately rather than making
      // the user click it from a one-item list. Two or more must always be
      // picked explicitly (never auto-chosen).
      if (results.length === 1) setSelectedMatch(results[0]);
    } catch (err) {
      setQuoteSearchError(extractErrorMessage(err));
    } finally {
      setSearchingQuote(false);
    }
  };

  const handleConfirmLink = async () => {
    if (!selectedMatch) return;
    setLinkingQuote(true);
    try {
      const result = await financeDocumentsService.linkCustomerQuote(document._id, selectedMatch.quoteId);
      toast.success(`Linked to customer quote ${result.linkedQuote.quoteNumber ?? selectedMatch.quoteId}`);
      setLinkedQuoteNo(result.linkedQuote.quoteNumber);
      setQuoteSearchOpen(false);
      setQuoteMatches(null);
      setSelectedMatch(null);
      setQuoteNumberInput('');
      onSaved(result.document);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLinkingQuote(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={document.originalFilename} maxWidth={720}>
      <div className={styles.form}>
        {document.extractionStatus === 'failed' && (
          <div className={financeStyles.emptyState}>Extraction failed: {document.extractionError ?? 'Unknown error'}</div>
        )}
        {document.aiSummary && <div className={financeStyles.card}>{document.aiSummary}</div>}
        {(document.missingFields.length > 0 || document.inconsistencyNotes.length > 0) && (
          <div className={styles.row}>
            {document.missingFields.length > 0 && (
              <div className={financeStyles.flagList}>
                <Badge variant="warning">Missing fields</Badge>
                {document.missingFields.map((f) => (
                  <span key={f}>• {f}</span>
                ))}
              </div>
            )}
            {document.inconsistencyNotes.length > 0 && (
              <div className={financeStyles.flagList}>
                <Badge variant="danger">Inconsistencies</Badge>
                {document.inconsistencyNotes.map((n) => (
                  <span key={n}>• {n}</span>
                ))}
              </div>
            )}
          </div>
        )}

        <span className={financeStyles.reviewSectionTitle}>Vendor & Invoice</span>
        <div className={styles.row}>
          <Input label="Vendor Name" value={form.vendorName ?? ''} onChange={(e) => set('vendorName', e.target.value || undefined)} />
          <Input label="Vendor ID" value={form.vendorId ?? ''} onChange={(e) => set('vendorId', e.target.value || undefined)} />
        </div>
        <div className={styles.row}>
          <Input label="Invoice Number" value={form.invoiceNumber ?? ''} onChange={(e) => set('invoiceNumber', e.target.value || undefined)} />
          <Input label="PO Number" value={form.poNumber ?? ''} onChange={(e) => set('poNumber', e.target.value || undefined)} />
        </div>
        <div className={styles.row}>
          <Input label="Invoice Date" type="date" value={form.invoiceDate ?? ''} onChange={(e) => set('invoiceDate', e.target.value || undefined)} />
          <Input label="Due Date" type="date" value={form.dueDate ?? ''} onChange={(e) => set('dueDate', e.target.value || undefined)} />
        </div>
        <Input label="Payment Date" type="date" value={form.paymentDate ?? ''} onChange={(e) => set('paymentDate', e.target.value || undefined)} />

        <span className={financeStyles.reviewSectionTitle}>Customer Quote Link</span>
        {linkedQuoteNo && !quoteSearchOpen ? (
          <div className={styles.row}>
            <Badge variant="success">Linked to Customer Quote {linkedQuoteNo}</Badge>
            <Button type="button" variant="ghost" size="sm" onClick={() => setQuoteSearchOpen(true)}>
              Change link
            </Button>
          </div>
        ) : (
          <div className={styles.quoteLinkBox}>
            {linkedQuoteNo && (
              <div className={financeStyles.flagList}>
                <Badge variant="warning">Already linked</Badge>
                <span>Currently linked to Customer Quote {linkedQuoteNo} — searching again will replace this link.</span>
              </div>
            )}
            <div className={styles.row}>
              <Input
                label="Customer Quote No"
                placeholder="e.g. IN001"
                value={quoteNumberInput}
                onChange={(e) => {
                  setQuoteNumberInput(e.target.value);
                  setQuoteMatches(null);
                  setSelectedMatch(null);
                  setQuoteSearchError(null);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                loading={searchingQuote}
                disabled={!quoteNumberInput.trim()}
                onClick={() => void handleSearchQuote()}
              >
                Search
              </Button>
            </div>

            {quoteSearchError && <div className={financeStyles.emptyState}>{quoteSearchError}</div>}

            {quoteMatches && quoteMatches.length === 0 && (
              <div className={financeStyles.emptyState}>No customer quote found with number "{quoteNumberInput.trim()}".</div>
            )}

            {quoteMatches && quoteMatches.length > 1 && !selectedMatch && (
              <div className={styles.quoteMatchList}>
                <span>Multiple matches — select the correct one:</span>
                {quoteMatches.map((m) => (
                  <button key={m.quoteId} type="button" className={styles.quoteMatchItem} onClick={() => setSelectedMatch(m)}>
                    <strong>{m.quoteNumber}</strong> — {m.customerName ?? 'Unknown customer'} — {m.currency} {m.quoteAmount.toLocaleString()}
                  </button>
                ))}
              </div>
            )}

            {selectedMatch && (
              <div className={styles.quoteMatchPreview}>
                <div>
                  Customer Quote No: <strong>{selectedMatch.quoteNumber}</strong>
                </div>
                <div>Customer: {selectedMatch.customerName ?? '—'}</div>
                <div>
                  Customer Quote Amount: {selectedMatch.currency} {selectedMatch.quoteAmount.toLocaleString()}
                </div>
                <div>Approval Status: {selectedMatch.clientApprovalStatus}</div>
                <div className={styles.row}>
                  <Button type="button" loading={linkingQuote} onClick={() => void handleConfirmLink()}>
                    Confirm & Link
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setSelectedMatch(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {linkedQuoteNo && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setQuoteSearchOpen(false)}>
                Cancel — keep existing link
              </Button>
            )}
          </div>
        )}

        <span className={financeStyles.reviewSectionTitle}>Amounts & Tax</span>
        <div className={styles.row}>
          <Input label="Payment Amount" type="number" value={form.paymentAmount ?? 0} onChange={(e) => set('paymentAmount', Number(e.target.value))} />
          <Input label="Currency" value={form.currency ?? ''} onChange={(e) => set('currency', e.target.value || undefined)} />
        </div>
        <div className={styles.row}>
          <Input label="Tax Amount" type="number" value={form.taxAmount ?? 0} onChange={(e) => set('taxAmount', Number(e.target.value))} />
          <Input label="Delivery Charges" type="number" value={form.deliveryCharges ?? 0} onChange={(e) => set('deliveryCharges', Number(e.target.value))} />
        </div>
        <div className={styles.row}>
          <Input label="GST Amount" type="number" value={form.taxDetails?.gstAmount ?? ''} onChange={(e) => setTax('gstAmount', e.target.value ? Number(e.target.value) : undefined)} />
          <Input label="VAT Amount" type="number" value={form.taxDetails?.vatAmount ?? ''} onChange={(e) => setTax('vatAmount', e.target.value ? Number(e.target.value) : undefined)} />
        </div>
        <div className={styles.row}>
          <label className={styles.label}>
            Subscription Payment?
            <select
              className={styles.select}
              value={form.isSubscriptionPayment ? 'yes' : 'no'}
              onChange={(e) => set('isSubscriptionPayment', e.target.value === 'yes')}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </label>
          <Input
            label="Subscription Provider"
            value={form.subscriptionProvider ?? ''}
            onChange={(e) => set('subscriptionProvider', e.target.value || undefined)}
          />
        </div>

        <span className={financeStyles.reviewSectionTitle}>Bank Details</span>
        <div className={styles.row}>
          <Input label="Bank Name" value={form.bankDetails?.bankName ?? ''} onChange={(e) => setBank('bankName', e.target.value || undefined)} />
          <Input label="Account Number" value={form.bankDetails?.accountNumber ?? ''} onChange={(e) => setBank('accountNumber', e.target.value || undefined)} />
        </div>
        <Input label="IFSC / SWIFT" value={form.bankDetails?.ifscOrSwift ?? ''} onChange={(e) => setBank('ifscOrSwift', e.target.value || undefined)} />

        <span className={financeStyles.reviewSectionTitle}>Classification</span>
        <div className={styles.row}>
          <label className={styles.label}>
            Payment Status
            <select className={styles.select} value={form.paymentStatus ?? 'pending'} onChange={(e) => set('paymentStatus', e.target.value as UpdateFinanceDocumentPayload['paymentStatus'])}>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.label}>
            Payment Method
            <select className={styles.select} value={form.paymentMethod ?? ''} onChange={(e) => set('paymentMethod', e.target.value || undefined)}>
              <option value="">— Not set —</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={styles.row}>
          <Input label="Department" value={form.department ?? ''} onChange={(e) => set('department', e.target.value || undefined)} />
          <Input label="Cost Center" value={form.costCenter ?? ''} onChange={(e) => set('costCenter', e.target.value || undefined)} />
        </div>
        <Input label="Expense Category" value={form.expenseCategory ?? ''} onChange={(e) => set('expenseCategory', e.target.value || undefined)} />

        <div className={styles.footer}>
          <Button type="button" variant="ghost" loading={viewingFile} onClick={() => void handleViewFile()}>
            View Original File
          </Button>
          <div className={styles.footerActions}>
            <Button type="button" variant="danger" onClick={() => void handleDelete()}>
              Delete
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" loading={saving} onClick={() => void handleSave()}>
              Save Changes
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

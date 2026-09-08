import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiDownload } from 'react-icons/fi';
import { Badge, Modal, Skeleton } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { formatINR as money } from '@/utils/currency';
import { vendorProfitabilityService, type VendorProfitabilityPaymentStatus } from '@/services/vendorProfitabilityService';
import { financeDocumentsService } from '@/services/financeDocumentsService';
import panelStyles from './VendorProfitabilityPanel.module.css';
import styles from './VendorProfitabilityDetailModal.module.css';

function statusBadge(status: VendorProfitabilityPaymentStatus) {
  const variant = status === 'paid' ? 'success' : status === 'partially_paid' ? 'warning' : 'neutral';
  const label = status === 'paid' ? 'Paid' : status === 'partially_paid' ? 'Partially paid' : 'Pending';
  return <Badge variant={variant}>{label}</Badge>;
}

export interface VendorProfitabilityDetailModalProps {
  dealId: string | null;
  onClose: () => void;
}

// Section 10 — "click a vendor quote to see the complete deal". Reuses the
// existing Finance document file-view call (same owner/admin-gated route
// this section's own StatCards already point users at via "Go to Finance
// AI") rather than inventing a second PDF viewer.
export function VendorProfitabilityDetailModal({ dealId, onClose }: VendorProfitabilityDetailModalProps) {
  const [viewingFileId, setViewingFileId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['vendor-profitability-deal-detail', dealId],
    queryFn: () => vendorProfitabilityService.getDealDetail(dealId!),
    enabled: !!dealId,
  });

  const handleViewFile = async (financeDocumentId: string) => {
    setViewingFileId(financeDocumentId);
    try {
      await financeDocumentsService.viewFile(financeDocumentId);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setViewingFileId(null);
    }
  };

  return (
    <Modal open={!!dealId} onClose={onClose} title={data?.dealName ?? 'Deal detail'} maxWidth={760}>
      {isLoading || !data ? (
        <Skeleton height={240} />
      ) : (
        <div className={styles.body}>
          <div className={styles.headerRow}>
            {data.customerQuoteNo && <Badge variant="accent">Customer Quote {data.customerQuoteNo}</Badge>}
            {(data.vendorQuoteNumbers ?? []).map((no) => (
              <Badge key={no} variant="info">
                Vendor Quote {no}
              </Badge>
            ))}
            {data.currencyMismatch && <Badge variant="warning">Currency mismatch — excluded from totals</Badge>}
          </div>

          <div className={panelStyles.divider} />

          <div className={styles.statGrid}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Customer Revenue</span>
              <span className={styles.statValue}>
                {money(data.customerRevenue)} {data.customerRevenueCurrency !== 'INR' ? data.customerRevenueCurrency : ''}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Vendor Cost</span>
              <span className={styles.statValue}>
                {money(data.vendorCost)} {data.vendorCostCurrency !== 'INR' ? data.vendorCostCurrency : ''}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Gross Profit</span>
              <span className={styles.statValue}>{data.currencyMismatch ? '—' : money(data.grossProfit ?? 0)}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Gross Margin</span>
              <span className={styles.statValue}>{data.grossMarginPct !== null ? `${data.grossMarginPct}%` : '—'}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Markup</span>
              <span className={styles.statValue}>{data.markupPct != null ? `${data.markupPct}%` : '—'}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Actual Vendor Cost Paid</span>
              <span className={styles.statValue}>{money(data.actualVendorCostPaid ?? 0)}</span>
            </div>
          </div>

          <div className={styles.headerRow}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Vendor Payment Status</span>
              {data.vendorPaymentStatus ? statusBadge(data.vendorPaymentStatus) : '—'}
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Customer Payment Status</span>
              {data.customerPaymentStatus ? statusBadge(data.customerPaymentStatus) : '—'}
            </div>
          </div>

          <div className={panelStyles.divider} />

          <span className={panelStyles.label}>Vendor Documents</span>
          {data.financeDocuments.length === 0 ? (
            <div className={panelStyles.emptyState}>No linked vendor documents.</div>
          ) : (
            <div className={styles.docList}>
              {data.financeDocuments.map((doc) => (
                <div key={doc.id} className={styles.docRow}>
                  <div className={styles.docMain}>
                    <span className={styles.docTitle}>
                      {doc.vendorName ?? 'Unknown vendor'} — {doc.invoiceNumber ?? doc.originalFilename}
                    </span>
                    <span className={styles.docMeta}>
                      {money(doc.paymentAmount)} {doc.currency !== 'INR' ? doc.currency : ''} · {doc.paymentStatus.replace('_', ' ')}
                      {doc.dueDate ? ` · due ${doc.dueDate}` : ''}
                    </span>
                    {doc.aiSummary && <span className={styles.docSummary}>{doc.aiSummary}</span>}
                  </div>
                  <button
                    type="button"
                    className={panelStyles.learnBtn}
                    disabled={viewingFileId === doc.id}
                    onClick={() => void handleViewFile(doc.id)}
                  >
                    <FiDownload size={13} />
                    {viewingFileId === doc.id ? 'Opening…' : 'View PDF'}
                  </button>
                </div>
              ))}
            </div>
          )}

          <span className={panelStyles.label}>Customer Quotes</span>
          {data.quotes.length === 0 ? (
            <div className={panelStyles.emptyState}>No linked customer quotes.</div>
          ) : (
            <div className={styles.docList}>
              {data.quotes.map((q) => (
                <div key={q.id} className={styles.docRow}>
                  <div className={styles.docMain}>
                    <span className={styles.docTitle}>
                      {q.customerName ?? 'Unknown customer'} — {q.quoteNumber ?? q.id}
                    </span>
                    <span className={styles.docMeta}>
                      {money(q.quoteAmount)} {q.currency !== 'INR' ? q.currency : ''} · {q.clientApprovalStatus} · paid {money(q.paidAmount)}
                    </span>
                    {q.items.length > 0 && (
                      <span className={styles.docMeta}>
                        {q.items.map((item) => `${item.description} x${item.quantity}`).join(', ')}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

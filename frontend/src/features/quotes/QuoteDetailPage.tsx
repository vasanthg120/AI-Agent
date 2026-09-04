import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Skeleton } from '@/components/ui';
import { formatCurrency } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import { dealsService } from '@/services/dealsService';
import { quotesService } from '@/services/quotesService';
import { ROUTES } from '@/constants/routes';
import styles from './quotes.module.css';

const APPROVAL_BADGE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  approved: 'success',
  rejected: 'danger',
  pending: 'warning',
};

// New — view page for one quote: customer, linked deal, line items, pricing
// summary, status, and a read-only payment summary/history (reuses the
// existing, previously frontend-unused GET .../payments route). Recording a
// new payment is intentionally not built here in V1 — see the Quotes in
// Pipeline plan's scope note; this page only surfaces what already exists.
export function QuoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const { data: quote, isLoading, error } = useQuery({
    queryKey: ['quote-detail', id],
    queryFn: () => quotesService.getOne(id!),
    enabled: !!id,
  });

  const { data: deal } = useQuery({
    queryKey: ['quote-detail-deal', quote?.dealId],
    queryFn: () => dealsService.getOne(quote!.dealId!),
    enabled: !!quote?.dealId,
  });

  const { data: payments } = useQuery({
    queryKey: ['quote-detail-payments', id],
    queryFn: () => quotesService.listPayments(id!),
    enabled: !!id,
  });

  if (isLoading) return <Skeleton height={400} />;
  if (error || !quote) return <div className={styles.emptyState}>{error ? extractErrorMessage(error) : 'Quote not found.'}</div>;

  const canEdit = (hasRole(user, 'owner') || hasRole(user, 'admin') || hasRole(user, 'manager')) && !quote.externalId;
  const outstanding = quote.quoteAmount - quote.paidAmount;

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.pageTitle}>{quote.quoteNumber ?? quote.quoteName ?? 'Quote'}</h1>
          <p className={styles.pageSubtitle}>{quote.quoteName}</p>
        </div>
        <div className={styles.headerActions}>
          <Badge variant="neutral">{quote.quoteStatus}</Badge>
          <Badge variant={APPROVAL_BADGE[quote.clientApprovalStatus] ?? 'neutral'}>{quote.clientApprovalStatus}</Badge>
          <Button variant="secondary" onClick={() => navigate(ROUTES.quotes)}>
            Back to list
          </Button>
          {canEdit && <Button onClick={() => navigate(ROUTES.quoteEdit(quote._id))}>Edit</Button>}
        </div>
      </div>

      <div className={styles.detailGrid}>
        <div className={styles.formSection}>
          <span className={styles.sectionTitle}>Line items</span>
          {quote.items.length === 0 ? (
            <div className={styles.emptyState}>
              No priced line items on this quote{quote.externalId ? ' (synced from the external CRM).' : '.'}
            </div>
          ) : (
            <div className={styles.itemsTableWrap}>
              <table className={styles.itemsTable}>
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Qty</th>
                    <th>Unit price</th>
                    <th>Discount</th>
                    <th>Tax %</th>
                    <th>Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.items.map((item, i) => (
                    <tr key={i}>
                      <td>{item.description}</td>
                      <td>{item.quantity}</td>
                      <td>{formatCurrency(item.unitPrice, quote.currency)}</td>
                      <td>{formatCurrency(item.discount, quote.currency)}</td>
                      <td>{item.taxRate}%</td>
                      <td className={styles.itemLineTotal}>{formatCurrency(item.lineTotal, quote.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className={styles.summaryGrid}>
            <div className={styles.summaryRow}>
              <span>Subtotal</span>
              <span>{formatCurrency(quote.subtotal, quote.currency)}</span>
            </div>
            <div className={styles.summaryRow}>
              <span>Discount</span>
              <span>-{formatCurrency(quote.discountAmount, quote.currency)}</span>
            </div>
            <div className={styles.summaryRow}>
              <span>Tax</span>
              <span>{formatCurrency(quote.taxAmount, quote.currency)}</span>
            </div>
            <div className={`${styles.summaryRow} ${styles.total}`}>
              <span>Total</span>
              <span>{formatCurrency(quote.quoteAmount, quote.currency)}</span>
            </div>
          </div>

          <span className={styles.sectionTitle} style={{ marginTop: 'var(--space-3)' }}>
            Payments
          </span>
          <div className={styles.summaryGrid} style={{ marginLeft: 0 }}>
            <div className={styles.summaryRow}>
              <span>Paid</span>
              <span>{formatCurrency(quote.paidAmount, quote.currency)}</span>
            </div>
            <div className={`${styles.summaryRow} ${styles.total}`}>
              <span>Outstanding</span>
              <span>{formatCurrency(outstanding, quote.currency)}</span>
            </div>
          </div>
          {payments && payments.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Method</th>
                    <th>Reference</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p._id}>
                      <td>{p.paymentDate}</td>
                      <td>{formatCurrency(p.amount, quote.currency)}</td>
                      <td>{p.paymentMethod ?? '—'}</td>
                      <td>{p.reference ?? '—'}</td>
                      <td>
                        <Badge variant={p.voided ? 'danger' : 'success'}>{p.voided ? 'voided' : 'recorded'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className={styles.formSection}>
          <span className={styles.sectionTitle}>Customer</span>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Company</span>
            <span className={styles.infoValue}>{quote.clientDetails?.companyName ?? '—'}</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Contact</span>
            <span className={styles.infoValue}>{quote.clientDetails?.contactName ?? '—'}</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Email</span>
            <span className={styles.infoValue}>{quote.clientDetails?.email ?? '—'}</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Phone</span>
            <span className={styles.infoValue}>{quote.clientDetails?.phone ?? '—'}</span>
          </div>

          <span className={styles.sectionTitle} style={{ marginTop: 'var(--space-3)' }}>
            Deal
          </span>
          {deal ? (
            <>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Name</span>
                <span className={styles.infoValue}>{deal.name}</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Status</span>
                <span className={styles.infoValue}>{deal.dealStatus}</span>
              </div>
              {deal.stageId && (
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Stage</span>
                  <span className={styles.infoValue}>{deal.stageId}</span>
                </div>
              )}
            </>
          ) : (
            <div className={styles.infoRow}>
              <span className={styles.infoValue}>No linked deal</span>
            </div>
          )}

          <span className={styles.sectionTitle} style={{ marginTop: 'var(--space-3)' }}>
            Details
          </span>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Valid until</span>
            <span className={styles.infoValue}>{quote.expirationDate ?? '—'}</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Due date</span>
            <span className={styles.infoValue}>{quote.dueDate ?? '—'}</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Source</span>
            <span className={styles.infoValue}>{quote.externalId ? 'External CRM sync' : 'Native (Haive)'}</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Created</span>
            <span className={styles.infoValue}>{new Date(quote.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

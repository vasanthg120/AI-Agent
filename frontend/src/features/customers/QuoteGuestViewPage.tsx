import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FiAlertCircle } from 'react-icons/fi';
import { Skeleton } from '@/components/ui';
import { axiosClient } from '@/api/axiosClient';
import { extractErrorMessage } from '@/utils/errors';
import styles from './quote-guest-view-page.module.css';

// The public landing page behind "Copy Guest View Link" — deliberately
// outside AppLayout/ProtectedRoute (see routes/index.tsx) and never calls
// quotesService.getOne: this hits the backend's separate, unauthenticated
// quote-guest.controller.ts route by token alone, which already returns
// only the narrow, client-safe projection (see that controller's own
// comment) — there's nothing further to restrict here.
interface GuestQuote {
  quoteNumber?: string;
  quoteName?: string;
  quoteStatus: string;
  clientApprovalStatus: string;
  quoteAmount: number;
  currency: string;
  expirationDate?: string;
  dueDate?: string;
  deliveryDate?: string;
  clientDetails?: { companyName?: string; contactName?: string };
  items: { description: string; quantity: number; unitPrice: number; lineTotal: number }[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  paidAmount: number;
}

export function QuoteGuestViewPage() {
  const { token } = useParams<{ token: string }>();
  const query = useQuery({
    queryKey: ['quote-guest', token],
    queryFn: async () => {
      const { data } = await axiosClient.get<GuestQuote>(`/crm/quotes/guest/${token}`);
      return data;
    },
    enabled: !!token,
    retry: false,
  });

  const money = (amount: number, currency: string) => `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        {query.isLoading ? (
          <Skeleton height={320} />
        ) : query.isError || !query.data ? (
          <p className={styles.error}>
            <FiAlertCircle aria-hidden /> {extractErrorMessage(query.error) || 'This link is invalid or has expired.'}
          </p>
        ) : (
          <>
            <header className={styles.header}>
              <h1>{query.data.quoteNumber ?? query.data.quoteName ?? 'Quote'}</h1>
              <span>{query.data.clientDetails?.companyName ?? query.data.clientDetails?.contactName ?? ''}</span>
            </header>

            {query.data.items.length > 0 && (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className={styles.num}>Qty</th>
                    <th className={styles.num}>Rate</th>
                    <th className={styles.num}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((item, i) => (
                    <tr key={i}>
                      <td>{item.description}</td>
                      <td className={styles.num}>{item.quantity.toLocaleString()}</td>
                      <td className={styles.num}>{money(item.unitPrice, query.data!.currency)}</td>
                      <td className={styles.num}>{money(item.lineTotal, query.data!.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <dl className={styles.totals}>
              <div>
                <dt>Subtotal</dt>
                <dd>{money(query.data.subtotal, query.data.currency)}</dd>
              </div>
              <div>
                <dt>Discount</dt>
                <dd>{money(query.data.discountAmount, query.data.currency)}</dd>
              </div>
              <div>
                <dt>Tax</dt>
                <dd>{money(query.data.taxAmount, query.data.currency)}</dd>
              </div>
              <div className={styles.totalMain}>
                <dt>Total</dt>
                <dd>{money(query.data.quoteAmount, query.data.currency)}</dd>
              </div>
            </dl>

            <dl className={styles.meta}>
              {query.data.expirationDate && (
                <div>
                  <dt>Expires</dt>
                  <dd>{query.data.expirationDate}</dd>
                </div>
              )}
              {query.data.dueDate && (
                <div>
                  <dt>Payment deadline</dt>
                  <dd>{query.data.dueDate}</dd>
                </div>
              )}
              {query.data.deliveryDate && (
                <div>
                  <dt>Delivery date</dt>
                  <dd>{query.data.deliveryDate}</dd>
                </div>
              )}
            </dl>
          </>
        )}
      </div>
    </div>
  );
}

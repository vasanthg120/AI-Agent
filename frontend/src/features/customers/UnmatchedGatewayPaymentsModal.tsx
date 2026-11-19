import clsx from 'clsx';
import { Badge, Modal } from '@/components/ui';
import type { GatewayPaymentRecord } from '@/services/customersService';
import { formatDate, formatMoney } from './format';
import { GATEWAY_TRANSACTION_VARIANT } from './status';
import detailStyles from './customer-detail.module.css';

// Square (etc.) transactions stored but matched to nobody on this org's
// Customers board — no email/phone the payment carried matched any
// existing customer, so it's never auto-assigned by guess (per the Square
// integration's own spec: "mark as unmatched, never assign to the first
// customer returned"). Read-only: there's nothing to action here yet beyond
// seeing the queue — a real "assign to this customer" flow is a larger,
// separate feature.
export function UnmatchedGatewayPaymentsModal({ payments, onClose }: { payments: GatewayPaymentRecord[]; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Unmatched Gateway Payments"
      description="These payments came through a connected provider but didn't match any customer's email or phone on file — never guessed, so they're listed here instead."
      maxWidth={760}
    >
      {payments.length === 0 ? (
        <p>Nothing unmatched right now.</p>
      ) : (
        <table className={clsx(detailStyles.docTable, detailStyles.stackTable)}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Provider</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Reference</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td>{formatDate(p.date)}</td>
                <td style={{ textTransform: 'capitalize' }}>{p.provider}</td>
                <td>{formatMoney(p.amount / 100, p.currency)}</td>
                <td>
                  <Badge variant={GATEWAY_TRANSACTION_VARIANT[p.status]}>{p.status.replace(/_/g, ' ')}</Badge>
                </td>
                <td>{p.transactionReference ?? p.orderReference ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

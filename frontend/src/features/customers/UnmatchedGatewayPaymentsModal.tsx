import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Badge, Modal } from '@/components/ui';
import type { GatewayPaymentRecord } from '@/services/customersService';
import { GatewayPaymentDetailModal } from './GatewayPaymentDetailModal';
import { cardLabel, matchesPaymentSearch, minorToMajor, totalsByCurrency } from './gatewayPayments';
import { formatDate, formatMoney } from './format';
import { GATEWAY_TRANSACTION_VARIANT } from './status';
import detailStyles from './customer-detail.module.css';

// Square (etc.) transactions stored but matched to nobody on this org's
// Customers board — never auto-assigned by guess. Rows open the full payment
// details; the open payment is looked up by id in the live `payments` prop, so
// a real-time refresh updates it and never duplicates a row.
export function UnmatchedGatewayPaymentsModal({ payments, onClose }: { payments: GatewayPaymentRecord[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const shown = useMemo(() => payments.filter((p) => matchesPaymentSearch(p, query)), [payments, query]);
  const selected = selectedId ? payments.find((p) => p.id === selectedId) : undefined;
  if (selected) return <GatewayPaymentDetailModal payment={selected} onClose={() => setSelectedId(undefined)} />;
  return (
    <Modal
      open
      onClose={onClose}
      title="Unmatched Gateway Payments"
      description="These payments came through a connected provider but didn't match any customer's email or phone on file — never guessed, so they're listed here instead."
      maxWidth={860}
    >
      {payments.length === 0 ? (
        <p>Nothing unmatched right now.</p>
      ) : (
        <>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by ID, status, card, reference…"
            aria-label="Search payments"
            style={{ width: '100%', marginBottom: 12, padding: '8px 10px' }}
          />
          <div style={{ maxHeight: '55vh', overflow: 'auto' }}>
            {shown.length === 0 ? (
              <p>No payments match “{query}”.</p>
            ) : (
              <table className={clsx(detailStyles.docTable, detailStyles.stackTable)}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Method</th>
                    <th>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id} tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(p.id)} onKeyDown={(e) => e.key === 'Enter' && setSelectedId(p.id)}>
                      <td>{formatDate(p.date)}</td>
                      <td>{formatMoney(minorToMajor(p.amount, p.currency), p.currency)}</td>
                      <td>
                        <Badge variant={GATEWAY_TRANSACTION_VARIANT[p.status]}>{p.status.replace(/_/g, ' ')}</Badge>
                      </td>
                      <td>{cardLabel(p)}</td>
                      <td>{p.transactionReference ?? p.orderReference ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className={detailStyles.muted} style={{ marginTop: 10 }}>
            {totalsByCurrency(shown)
              .map((t) => `${t.currency}: ${formatMoney(minorToMajor(t.net, t.currency), t.currency)} net (${t.count})`)
              .join(' · ')}
          </p>
        </>
      )}
    </Modal>
  );
}

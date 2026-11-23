import { useEffect, useState } from 'react';
import { FiExternalLink } from 'react-icons/fi';
import { Badge, Button, Modal } from '@/components/ui';
import type { GatewayPaymentRecord, SquarePaymentDetails } from '@/services/customersService';
import { squareService } from '@/services/squareService';
import { isSafeReceiptUrl, minorToMajor, netReceived, SOURCE_LABEL } from './gatewayPayments';
import { formatMoney } from './format';
import { GATEWAY_TRANSACTION_VARIANT } from './status';
import detailStyles from './customer-detail.module.css';

const dash = '—';
const dateTime = (iso?: string) => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

type Row = [label: string, value: string | undefined | null];

function Section({ title, rows }: { title: string; rows: Row[] }) {
  // Only fields actually provided are shown — never a placeholder row for a missing one.
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  if (shown.length === 0) return null;
  return (
    <section className={detailStyles.section}>
      <h3>{title}</h3>
      <dl className={detailStyles.named}>
        {shown.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd style={{ overflowWrap: 'anywhere' }}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// Full transaction view for one stored Square payment. `payment` is the live
// row from the customers query, so a socket-driven refetch updates this view
// too. Rows synced before details were stored fetch them once, on open.
export function GatewayPaymentDetailModal({ payment, onClose }: { payment: GatewayPaymentRecord; onClose: () => void }) {
  const [fetched, setFetched] = useState<SquarePaymentDetails>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const needsFetch = !payment.details && payment.provider === 'square';

  useEffect(() => {
    if (!needsFetch) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    squareService
      .getPaymentDetails(payment.id)
      .then((d) => !cancelled && setFetched(d))
      .catch(() => !cancelled && setError('Full details could not be loaded from Square right now.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [needsFetch, payment.id]);

  const d = payment.details ?? fetched;
  const cur = payment.currency;
  const money = (minor?: number, currency = cur) => (minor === undefined ? undefined : formatMoney(minorToMajor(minor, currency), currency));
  const net = netReceived({ ...payment, details: d });
  const feeDates = d?.processingFees?.map((f) => dateTime(f.effectiveAt)).filter(Boolean);
  const card = d?.card;
  const receipt = isSafeReceiptUrl(d?.receiptUrl) ? d?.receiptUrl : undefined;
  const links = payment.links;
  const refunded = d?.refundedMoney?.amount ?? payment.refundedAmount;

  return (
    <Modal open onClose={onClose} title="Payment details" description={payment.id} maxWidth={720}>
      <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        <div className={detailStyles.badges}>
          <Badge variant={GATEWAY_TRANSACTION_VARIANT[payment.status]}>{payment.status.replace(/_/g, ' ')}</Badge>
          {receipt && (
            <Button type="button" size="sm" variant="ghost" leftIcon={<FiExternalLink />} onClick={() => window.open(receipt, '_blank', 'noopener,noreferrer')}>
              View Receipt
            </Button>
          )}
        </div>
        {loading && <p className={detailStyles.muted}>Loading full details from Square…</p>}
        {error && (
          <p role="alert" className={detailStyles.muted}>
            {error}
          </p>
        )}

        <Section
          title="General"
          rows={[
            ['Payment ID', payment.id],
            ['Created', dateTime(payment.date)],
            ['Updated', dateTime(d?.updatedAt)],
            ['Amount', money(payment.amount)],
            ['Currency', cur],
            ['Total amount', money(d?.totalMoney?.amount, d?.totalMoney?.currency)],
            ['Approved amount', money(d?.approvedMoney?.amount, d?.approvedMoney?.currency)],
            ['Refunded amount', refunded > 0 ? money(refunded, d?.refundedMoney?.currency ?? cur) : undefined],
            ['Status', payment.status.replace(/_/g, ' ')],
            ['Payment source', payment.paymentMethodType ? (SOURCE_LABEL[payment.paymentMethodType.toUpperCase()] ?? payment.paymentMethodType) : undefined],
          ]}
        />
        <Section
          title="Card / payment method"
          rows={[
            ['Card brand', card?.brand],
            ['Last four digits', card?.last4],
            ['Card type', card?.cardType],
            ['Entry method', card?.entryMethod],
            ['Card payment status', card?.status],
          ]}
        />
        <Section
          title="Fees and net"
          rows={[
            ['Processing fee', net ? money(net.feeTotal) : undefined],
            ['Fee type', [...new Set(d?.processingFees?.map((f) => f.type).filter(Boolean))].join(', ') || undefined],
            ['Fee date', feeDates?.length ? [...new Set(feeDates)].join(', ') : undefined],
            ['Net received', net ? money(net.net) : undefined],
          ]}
        />
        {!!d?.processingFees?.length && !net && <p className={detailStyles.muted}>Fees are in a different currency from the payment, so no net amount is calculated.</p>}
        <Section
          title="References"
          rows={[
            ['Square order ID', d?.orderId ?? payment.orderReference],
            ['Customer ID', d?.customerId],
            ['Location ID', d?.locationId],
            ['Reference ID', d?.referenceId ?? payment.transactionReference],
            ['Team member', d?.teamMemberId ?? d?.employeeId],
            ['Receipt number', d?.receiptNumber],
          ]}
        />
        <Section
          title="Additional information"
          rows={[
            ['Note', d?.note],
            ['Square product', d?.productName?.replace(/_/g, ' ').toLowerCase()],
            ['Authorized', dateTime(d?.authorizedAt)],
            ['Captured', dateTime(d?.capturedAt)],
            ['Refunds', d?.refundIds?.length ? `${d.refundIds.length} refund${d.refundIds.length === 1 ? '' : 's'} on record` : undefined],
          ]}
        />
        <section className={detailStyles.section}>
          <h3>Linked customer and documents</h3>
          {links ? (
            <dl className={detailStyles.named}>
              <div>
                <dt>Haive customer</dt>
                <dd>{links.customerName ?? dash}</dd>
              </div>
              <div>
                <dt>Hoops customer</dt>
                <dd>{links.crmSources.some((s) => /hoops/i.test(s)) ? (links.customerName ?? dash) : 'Not in Hoops'}</dd>
              </div>
              <div>
                <dt>Quote</dt>
                <dd>{links.quote ? (links.quote.number ?? 'Linked') : 'No linked quote/job'}</dd>
              </div>
              <div>
                <dt>Job</dt>
                <dd>{links.job ? links.job.number : 'No linked quote/job'}</dd>
              </div>
              <div>
                <dt>Invoice</dt>
                <dd>{links.invoice ? (links.invoice.number ?? 'Linked') : dash}</dd>
              </div>
            </dl>
          ) : (
            <p className={detailStyles.muted}>Not matched to a customer — no linked quote/job.</p>
          )}
        </section>
      </div>
    </Modal>
  );
}

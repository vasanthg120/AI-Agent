import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiSearch } from 'react-icons/fi';
import { Badge, Button, Input, Modal, Skeleton } from '@/components/ui';
import { billingAdminService, type AdminPaymentRecord, type AdminRefund } from '@/services/billingAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import { formatCurrency } from '@/utils/currency';
import shared from '../adminShared.module.css';

// Every number here (refundable amount, credit clawback, idempotency) is
// computed server-side by RefundService.refundPayment — this page only
// collects the paymentRecordId/amount/reason and displays what comes back;
// see that service's cumulative-target clawback math for why a naive
// per-refund calculation here would be wrong on a second partial refund.
export function AdminRefundsPage() {
  const [organizationId, setOrganizationId] = useState('');
  const [refunds, setRefunds] = useState<AdminRefund[]>([]);
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [paymentRecordId, setPaymentRecordId] = useState('');
  const [foundPayment, setFoundPayment] = useState<AdminPaymentRecord | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadRefunds = () => {
    setLoading(true);
    billingAdminService
      .listRefunds({ organizationId: organizationId || undefined, limit: 100 })
      .then(setRefunds)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const timeout = setTimeout(loadRefunds, 250);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  const lookupPayment = async () => {
    if (!paymentRecordId.trim()) return;
    setLookingUp(true);
    setLookupError(null);
    setFoundPayment(null);
    try {
      // Reuses the existing admin payments list filtered down to one id —
      // no separate "get one payment" endpoint needed for this lookup.
      const rows = await billingAdminService.listPayments({ limit: 500 });
      const match = rows.find((r) => r._id === paymentRecordId.trim());
      if (!match) {
        setLookupError('No payment found with that id.');
      } else if (match.status !== 'captured' && match.status !== 'partially_refunded') {
        setLookupError(`This payment is "${match.status}" — only captured payments can be refunded.`);
      } else {
        setFoundPayment(match);
      }
    } catch (error) {
      setLookupError(extractErrorMessage(error));
    } finally {
      setLookingUp(false);
    }
  };

  const submitRefund = async () => {
    if (!foundPayment) return;
    setSubmitting(true);
    try {
      const refund = await billingAdminService.createRefund({
        paymentRecordId: foundPayment._id,
        amount: amount ? Number.parseFloat(amount) : undefined,
        reason: reason || undefined,
      });
      if (refund.status === 'succeeded') {
        toast.success(`Refund of ${formatCurrency(refund.amount, refund.currency)} succeeded.`);
      } else {
        toast.error('Refund attempt failed — see the refund history for details.');
      }
      setModalOpen(false);
      setPaymentRecordId('');
      setFoundPayment(null);
      setAmount('');
      setReason('');
      loadRefunds();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const refundableAmount = foundPayment ? Math.round((foundPayment.amount - (foundPayment.refundedAmount ?? 0)) * 100) / 100 : 0;

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Refunds</h1>
          <p className={shared.pageSubtitle}>Refunds route through the original payment gateway and claw back credits automatically.</p>
        </div>
        <Button onClick={() => setModalOpen(true)}>Request Refund</Button>
      </div>

      <Input
        className={shared.searchInput}
        placeholder="Filter by organization id..."
        leftIcon={<FiSearch />}
        value={organizationId}
        onChange={(event) => setOrganizationId(event.target.value)}
      />

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Organization</th>
              <th>Payment</th>
              <th>Amount</th>
              <th>Credits Clawed Back</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6}>
                  <Skeleton height={20} />
                </td>
              </tr>
            )}
            {!loading && refunds.length === 0 && (
              <tr>
                <td colSpan={6} className={shared.emptyState}>
                  No refunds yet.
                </td>
              </tr>
            )}
            {!loading &&
              refunds.map((r) => (
                <tr key={r._id}>
                  <td>{formatFullDate(r.createdAt)}</td>
                  <td className={shared.mono}>{r.organizationId}</td>
                  <td className={shared.mono}>{r.paymentRecordId}</td>
                  <td>
                    {formatCurrency(r.amount, r.currency)}
                    {r.simulated && (
                      <span style={{ marginLeft: 6 }}>
                        <Badge variant="warning">simulated</Badge>
                      </span>
                    )}
                  </td>
                  <td>{r.creditsClawedBack.toLocaleString()} cr</td>
                  <td>
                    <Badge variant={r.status === 'succeeded' ? 'success' : 'danger'}>{r.status}</Badge>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Request a refund" description="Look up a captured payment by its id, then choose the amount to refund.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Input
              placeholder="Payment record id"
              value={paymentRecordId}
              onChange={(event) => {
                setPaymentRecordId(event.target.value);
                setFoundPayment(null);
                setLookupError(null);
              }}
            />
            <Button variant="secondary" loading={lookingUp} onClick={lookupPayment}>
              Look up
            </Button>
          </div>

          {lookupError && <div style={{ color: 'var(--color-danger)', fontSize: 'var(--text-sm)' }}>{lookupError}</div>}

          {foundPayment && (
            <>
              <div style={{ fontSize: 'var(--text-sm)', background: 'var(--color-bg-hover)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
                <div>
                  Organization: <span className={shared.mono}>{foundPayment.organizationId}</span>
                </div>
                <div>
                  Original amount: {formatCurrency(foundPayment.amount, foundPayment.currency)}
                </div>
                <div>Refundable now: {formatCurrency(refundableAmount, foundPayment.currency)}</div>
              </div>
              <Input
                label={`Refund amount (leave blank for full ${formatCurrency(refundableAmount, foundPayment.currency)})`}
                type="number"
                min={0.01}
                max={refundableAmount}
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <Input label="Reason (optional)" value={reason} onChange={(event) => setReason(event.target.value)} />
              <Button fullWidth loading={submitting} onClick={submitRefund}>
                Issue Refund
              </Button>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}

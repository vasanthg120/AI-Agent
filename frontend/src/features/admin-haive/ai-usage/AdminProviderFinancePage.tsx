import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiArrowLeft, FiCheckCircle, FiPlus, FiUpload } from 'react-icons/fi';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Button, Input, Modal, SectionCard, Skeleton, StatTile } from '@/components/ui';
import {
  providerFinanceService,
  type FinanceDashboard,
  type Profitability,
  type ProviderAccountView,
  type ProviderPaymentRow,
} from '@/services/providerFinanceService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import { ADMIN_ROUTES } from '@/constants/routes';
import { AdminPagination } from '../components/AdminPagination';
import shared from '../adminShared.module.css';

const DAYS = 30;
const money = (n: number | null | undefined, currency = 'USD') => (n == null ? '—' : `${currency === 'USD' ? '$' : currency + ' '}${n.toFixed(2)}`);

function AccountCard({ account, onReconciled }: { account: ProviderAccountView; onReconciled: () => void }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [balanceInput, setBalanceInput] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const value = Number.parseFloat(balanceInput);
    if (!Number.isFinite(value) || value < 0) {
      toast.error('Enter a valid non-negative balance.');
      return;
    }
    setSaving(true);
    try {
      await providerFinanceService.reconcile(account.provider, value);
      toast.success(`${account.provider} balance reconciled.`);
      setModalOpen(false);
      onReconciled();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const statusVariant = account.status === 'active' ? 'success' : account.status === 'exhausted' ? 'danger' : account.status === 'degraded' ? 'warning' : 'neutral';

  return (
    <SectionCard title={account.provider.charAt(0).toUpperCase() + account.provider.slice(1)}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Badge variant={statusVariant}>{account.status}</Badge>
        <Badge variant="neutral">{account.accountType}</Badge>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <div>
          <div className={shared.mono} style={{ fontSize: 'var(--text-xs)' }}>
            CONFIRMED BALANCE
          </div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>{money(account.confirmedBalance, account.currency)}</div>
        </div>
        <div>
          <div className={shared.mono} style={{ fontSize: 'var(--text-xs)' }}>
            ESTIMATED BALANCE
          </div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
            {money(account.estimatedBalance, account.currency)}
            {account.estimatedBalance != null && (
              <Badge variant="warning" style={{ marginLeft: 6 }}>
                estimated
              </Badge>
            )}
          </div>
        </div>
      </div>
      <p className={shared.pageSubtitle} style={{ marginBottom: 'var(--space-3)' }}>
        {account.lastReconciledAt ? `Last reconciled ${formatFullDate(account.lastReconciledAt)}` : 'Never reconciled — estimated balance unavailable until an admin confirms one.'}
      </p>
      <Button size="sm" variant="outline" leftIcon={<FiCheckCircle />} onClick={() => { setBalanceInput(''); setModalOpen(true); }}>
        Reconcile Balance
      </Button>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`Reconcile ${account.provider}`}
        description={`Enter the confirmed balance shown in ${account.provider}'s own console right now. Neither Anthropic nor Groq expose a balance API, so this is the only way this figure stays accurate.`}
      >
        <Input label="Confirmed balance" type="number" min={0} step="0.01" value={balanceInput} onChange={(e) => setBalanceInput(e.target.value)} autoFocus />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-5)' }}>
          <Button variant="ghost" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>
          <Button loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </Modal>
    </SectionCard>
  );
}

function RecordPaymentModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [provider, setProvider] = useState('anthropic');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [transactionId, setTransactionId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [creditPurchased, setCreditPurchased] = useState('');
  const [notes, setNotes] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const amountValue = Number.parseFloat(amount);
    if (!Number.isFinite(amountValue) || amountValue <= 0 || !paymentMethod.trim()) {
      toast.error('Enter a valid amount and payment method.');
      return;
    }
    setSaving(true);
    try {
      const payment = await providerFinanceService.recordPayment({
        provider,
        amount: amountValue,
        paymentDate: new Date(paymentDate).toISOString(),
        paymentMethod: paymentMethod.trim(),
        transactionId: transactionId.trim() || undefined,
        invoiceNumber: invoiceNumber.trim() || undefined,
        creditPurchased: creditPurchased ? Number.parseFloat(creditPurchased) : undefined,
        notes: notes.trim() || undefined,
      });
      if (receipt) await providerFinanceService.uploadReceipt(payment._id, receipt);
      toast.success('Payment recorded.');
      onSaved();
      onClose();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record Payment" description="A payment or recharge made to an LLM provider.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <label className={shared.mono} style={{ fontSize: 'var(--text-sm)', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: 4 }}>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ padding: 'var(--space-2)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
            <option value="anthropic">Anthropic</option>
            <option value="groq">Groq</option>
          </select>
        </label>
        <Input label="Amount" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        <Input label="Payment date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
        <Input label="Payment method" placeholder="e.g. Credit card, Wire transfer" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} />
        <Input label="Transaction ID (optional)" value={transactionId} onChange={(e) => setTransactionId(e.target.value)} />
        <Input label="Invoice number (optional)" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
        <Input label="Credit purchased (optional)" type="number" min={0} step="0.01" value={creditPurchased} onChange={(e) => setCreditPurchased(e.target.value)} />
        <Input label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <label className={shared.mono} style={{ fontSize: 'var(--text-sm)', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: 4 }}>
          Receipt / invoice (optional)
          <input type="file" accept="application/pdf,image/*" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function AdminProviderFinancePage() {
  const [dashboard, setDashboard] = useState<FinanceDashboard | null>(null);
  const [profitability, setProfitability] = useState<Profitability | null>(null);
  const [payments, setPayments] = useState<ProviderPaymentRow[]>([]);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [recordModalOpen, setRecordModalOpen] = useState(false);

  const loadDashboard = () => {
    setLoading(true);
    Promise.all([providerFinanceService.getDashboard(DAYS), providerFinanceService.getProfitability(DAYS)])
      .then(([d, p]) => {
        setDashboard(d);
        setProfitability(p);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(loadDashboard, []);

  useEffect(() => {
    providerFinanceService
      .listPayments({ page, pageSize: 25 })
      .then((res) => {
        setPayments(res.items);
        setPaymentsTotal(res.total);
      })
      .catch((error) => toast.error(extractErrorMessage(error)));
  }, [page]);

  return (
    <div className={shared.page}>
      <Link to={ADMIN_ROUTES.aiUsage} className={shared.backLink}>
        <FiArrowLeft size={14} /> AI Usage
      </Link>

      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>LLM Provider Finance</h1>
          <p className={shared.pageSubtitle}>What Haive pays LLM providers, remaining balance, payment history, and profitability.</p>
        </div>
        <Button size="sm" leftIcon={<FiPlus />} onClick={() => setRecordModalOpen(true)}>
          Record Payment
        </Button>
      </div>

      {loading || !dashboard ? (
        <Skeleton height={200} />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 'var(--space-4)' }}>
            <StatTile value={`$${dashboard.totalExpenditureThisYear.toFixed(2)}`} label="Expenditure This Year" />
            <StatTile value={`$${dashboard.totalPaymentsInRange.toFixed(2)}`} label={`Payments (${DAYS}d)`} />
            <StatTile value={`$${dashboard.totalConsumptionThisMonth.toFixed(2)}`} label="Consumption This Month" />
            <StatTile value={dashboard.activeProviderCount} label="Active Providers" />
            <StatTile value={dashboard.lowBalanceProviderCount} label="Low Balance" />
            <StatTile value={dashboard.exhaustedProviderCount} label="Exhausted" />
            <StatTile value={dashboard.lastPaymentDate ? formatFullDate(dashboard.lastPaymentDate) : 'Never'} label="Last Payment" />
            <StatTile value={dashboard.nextExpectedRechargeDateEstimate ? formatFullDate(dashboard.nextExpectedRechargeDateEstimate) : 'Not enough data'} label="Next Recharge (est.)" />
          </div>

          <SectionCard title="Provider Balances">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 'var(--space-4)' }}>
              {dashboard.accounts.map((a) => (
                <AccountCard key={a.provider} account={a} onReconciled={loadDashboard} />
              ))}
            </div>
          </SectionCard>

          {profitability && (
            <SectionCard title="Profitability">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
                <StatTile value={`${profitability.totalRevenueCredits.toLocaleString()} cr`} label="Customer Revenue" />
                <StatTile value={`$${profitability.totalProviderCostUsd.toFixed(2)}`} label="Provider Cost" />
                {profitability.providerCostBreakdown.map((p) => (
                  <StatTile key={p.provider} value={`$${p.costUsd.toFixed(2)}`} label={`${p.provider} cost`} />
                ))}
              </div>
              {profitability.dailyRevenueSeries.length > 0 && (
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={profitability.dailyRevenueSeries}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Area type="monotone" dataKey="revenueCredits" stroke="var(--brand-accent-primary)" fill="var(--brand-accent-primary)" fillOpacity={0.2} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </SectionCard>
          )}
        </>
      )}

      <SectionCard title="Payment History">
        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Transaction ID</th>
                <th>Status</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 && (
                <tr>
                  <td colSpan={7} className={shared.emptyState}>
                    No payments recorded yet.
                  </td>
                </tr>
              )}
              {payments.map((p) => (
                <tr key={p._id}>
                  <td>{p.provider}</td>
                  <td>{formatFullDate(p.paymentDate)}</td>
                  <td>{money(p.amount, p.currency)}</td>
                  <td>{p.paymentMethod}</td>
                  <td className={shared.mono}>{p.transactionId ?? '—'}</td>
                  <td>
                    <Badge variant={p.status === 'confirmed' ? 'success' : p.status === 'disputed' ? 'danger' : 'neutral'}>{p.status}</Badge>
                  </td>
                  <td>
                    {p.receiptFileId ? (
                      <a href={providerFinanceService.receiptDownloadUrl(p._id)} target="_blank" rel="noopener noreferrer">
                        <FiUpload size={12} /> View
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <AdminPagination page={page} limit={25} total={paymentsTotal} onChange={setPage} />
      </SectionCard>

      <RecordPaymentModal
        open={recordModalOpen}
        onClose={() => setRecordModalOpen(false)}
        onSaved={() => {
          loadDashboard();
          providerFinanceService.listPayments({ page: 1, pageSize: 25 }).then((res) => {
            setPayments(res.items);
            setPaymentsTotal(res.total);
            setPage(1);
          });
        }}
      />
    </div>
  );
}

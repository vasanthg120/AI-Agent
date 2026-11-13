import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiArrowLeft, FiKey, FiPlus, FiUpload, FiX } from 'react-icons/fi';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Button, Input, Modal, SectionCard, Skeleton, StatTile } from '@/components/ui';
import {
  providerFinanceService,
  type AlertLogRow,
  type CapabilityStatus,
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

const CAPABILITY_LABELS: Record<string, string> = {
  BALANCE_READ: 'Balance',
  USAGE_COST_READ: 'Usage/Cost',
  INVOICE_HISTORY_READ: 'Invoices',
  PAYMENT_HISTORY_READ: 'Payments',
  AUTO_RECHARGE_READ: 'Auto-Recharge (read)',
  AUTO_RECHARGE_CONFIGURE: 'Auto-Recharge (set)',
  SPEND_LIMIT_READ: 'Spend Limit (read)',
  SPEND_LIMIT_CONFIGURE: 'Spend Limit (set)',
  RATE_LIMIT_READ: 'Rate Limits',
  EXHAUSTION_DETECTION: 'Exhaustion Detection',
};

function capabilityVariant(status: CapabilityStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'SUPPORTED') return 'success';
  if (status === 'CONFIGURATION_REQUIRED' || status === 'PERMISSION_REQUIRED') return 'warning';
  if (status === 'ERROR') return 'danger';
  return 'neutral';
}

function AdminApiKeyControl({ account, onChanged }: { account: ProviderAccountView; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (key.trim().length < 8) {
      toast.error('Enter a valid Admin API key.');
      return;
    }
    setSaving(true);
    try {
      await providerFinanceService.setAdminApiKey(account.provider, key.trim());
      toast.success('Admin API key saved.');
      setOpen(false);
      setKey('');
      onChanged();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    try {
      await providerFinanceService.clearAdminApiKey(account.provider);
      toast.success('Admin API key removed.');
      onChanged();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      {account.hasAdminApiKey ? (
        <>
          <Badge variant="success">Admin API key configured</Badge>
          <Button size="sm" variant="ghost" leftIcon={<FiX />} onClick={() => void clear()}>
            Remove
          </Button>
        </>
      ) : (
        <Button size="sm" variant="outline" leftIcon={<FiKey />} onClick={() => setOpen(true)}>
          Add Admin API Key
        </Button>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${account.provider}: Admin API Key`}
        description="A separate Admin-tier key (not the normal chat-completion key) — required to enable real usage/cost sync and rate-limit reads. Create one in the provider's own console under Settings -> Admin keys."
      >
        <Input label="Admin API key" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-5)' }}>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function AccountCard({ account, onChanged }: { account: ProviderAccountView; onChanged: () => void }) {
  const statusVariant = account.status === 'active' ? 'success' : account.status === 'exhausted' ? 'danger' : account.status === 'degraded' ? 'warning' : 'neutral';
  const pace = account.budgetPacePct;
  const paceVariant = pace == null ? 'neutral' : pace >= 100 ? 'danger' : pace >= 80 ? 'warning' : 'success';
  const sync = account.usageCostSync;

  return (
    <SectionCard title={account.provider.charAt(0).toUpperCase() + account.provider.slice(1)}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Badge variant={account.connected ? 'success' : 'neutral'}>{account.connected ? 'Connected' : 'Not connected'}</Badge>
        <Badge variant={statusVariant} title="Operational health for AI requests">
          {account.status}
        </Badge>
        <Badge variant="neutral">{account.accountType}</Badge>
      </div>

      <div style={{ marginBottom: 'var(--space-3)' }}>
        <div className={shared.mono} style={{ fontSize: 'var(--text-xs)' }}>
          BALANCE
        </div>
        <Badge variant={capabilityVariant(account.balance.status)}>{account.balance.status.replace(/_/g, ' ')}</Badge>
        <p className={shared.pageSubtitle} style={{ marginTop: 4, marginBottom: 0 }}>
          {account.balance.note}
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <div>
          <div className={shared.mono} style={{ fontSize: 'var(--text-xs)' }}>
            CONSUMPTION THIS MONTH
          </div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>{money(account.consumptionThisMonth, account.currency)}</div>
          <div className={shared.pageSubtitle} style={{ fontSize: 'var(--text-xs)' }}>
            {formatFullDate(account.consumptionPeriod.start)} – {formatFullDate(account.consumptionPeriod.end)} ({account.consumptionPeriod.timezone})
          </div>
        </div>
        <div>
          <div className={shared.mono} style={{ fontSize: 'var(--text-xs)' }}>
            BUDGET PACE
          </div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
            {pace == null ? (
              '— (no monthlyBudget set)'
            ) : (
              <>
                {pace.toFixed(0)}% <Badge variant={paceVariant}>{money(account.monthlyBudget, account.currency)} budget</Badge>
              </>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 'var(--space-3)' }}>
        <div className={shared.mono} style={{ fontSize: 'var(--text-xs)' }}>
          FINANCE API AUTHENTICATION
        </div>
        {!account.hasAdminApiKey ? (
          <Badge variant="neutral">No Admin API key configured</Badge>
        ) : sync.lastAttemptSuccessful == null ? (
          <Badge variant="neutral">Not yet attempted</Badge>
        ) : sync.lastAttemptSuccessful ? (
          <Badge variant="success">Authenticated — last sync succeeded</Badge>
        ) : (
          <Badge variant="danger">Authentication/sync failing</Badge>
        )}
      </div>

      {sync.providerReportedCostThisMonth != null && (
        <p className={shared.pageSubtitle} style={{ marginBottom: 'var(--space-3)' }}>
          Provider-reported cost: {money(sync.providerReportedCostThisMonth, account.currency)}
          {sync.costVariancePct != null && ` (${sync.costVariancePct > 0 ? '+' : ''}${sync.costVariancePct.toFixed(1)}% vs. Haive-tracked)`}
        </p>
      )}
      {(sync.lastSuccessAt || sync.lastAttemptedAt) && (
        <p className={shared.pageSubtitle} style={{ marginBottom: 4, fontSize: 'var(--text-xs)' }}>
          {sync.lastSuccessAt && `Last successful sync: ${formatFullDate(sync.lastSuccessAt)}`}
          {sync.lastAttemptedAt && ` — last attempt: ${formatFullDate(sync.lastAttemptedAt)}`}
          {sync.nextScheduledSyncAt && ` — next: ${formatFullDate(sync.nextScheduledSyncAt)}`}
        </p>
      )}
      {sync.lastError && (
        <p className={shared.pageSubtitle} style={{ marginBottom: 'var(--space-3)', color: 'var(--color-danger)' }}>
          Last sync error: {sync.lastError}
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 'var(--space-3)' }}>
        {account.capabilities &&
          Object.entries(account.capabilities).map(([key, entry]) => (
            <Badge key={key} variant={capabilityVariant(entry.status)} title={entry.detail}>
              {CAPABILITY_LABELS[key] ?? key}
            </Badge>
          ))}
      </div>

      <AdminApiKeyControl account={account} onChanged={onChanged} />
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
  const [alerts, setAlerts] = useState<AlertLogRow[]>([]);
  const [payments, setPayments] = useState<ProviderPaymentRow[]>([]);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [recordModalOpen, setRecordModalOpen] = useState(false);

  const loadDashboard = () => {
    setLoading(true);
    Promise.all([providerFinanceService.getDashboard(DAYS), providerFinanceService.getProfitability(DAYS), providerFinanceService.getRecentAlerts(20)])
      .then(([d, p, a]) => {
        setDashboard(d);
        setProfitability(p);
        setAlerts(a);
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
          <p className={shared.pageSubtitle}>What Haive pays LLM providers, budget pace, payment history, and profitability.</p>
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
            <StatTile value={`$${dashboard.totalPaymentsInRange.toFixed(2)}`} label={`Payments (trailing ${DAYS}d)`} />
            <StatTile value={`$${dashboard.totalConsumptionThisMonth.toFixed(2)}`} label="Consumption This Month" />
            <StatTile value={dashboard.activeProviderCount} label="Active Providers" />
            <StatTile value={dashboard.nearOrOverBudgetProviderCount} label="Near/Over Budget" />
            <StatTile value={dashboard.exhaustedProviderCount} label="Exhausted" />
            <StatTile value={dashboard.needsConfigurationProviderCount} label="Needs Configuration" />
            <StatTile value={dashboard.lastPaymentDate ? formatFullDate(dashboard.lastPaymentDate) : 'Never'} label="Last Payment" />
            <StatTile value={dashboard.nextExpectedRechargeDateEstimate ? formatFullDate(dashboard.nextExpectedRechargeDateEstimate) : 'Not enough data'} label="Next Recharge (est.)" />
          </div>
          <p className={shared.pageSubtitle} style={{ fontSize: 'var(--text-xs)' }}>
            &ldquo;Payments (trailing {DAYS}d)&rdquo; covers {formatFullDate(dashboard.periodStart)} – {formatFullDate(dashboard.periodEnd)}. &ldquo;Consumption This Month&rdquo; is calendar
            month-to-date ({dashboard.accounts[0] ? `${formatFullDate(dashboard.accounts[0].consumptionPeriod.start)} – ${formatFullDate(dashboard.accounts[0].consumptionPeriod.end)}` : ''}) — a
            deliberately different, shorter window, so a lower figure here than in Profitability below is expected, not a discrepancy.
          </p>

          <SectionCard title="Provider Accounts">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-4)' }}>
              {dashboard.accounts.map((a) => (
                <AccountCard key={a.provider} account={a} onChanged={loadDashboard} />
              ))}
            </div>
          </SectionCard>

          {profitability && (
            <SectionCard title="Profitability">
              <p className={shared.pageSubtitle} style={{ fontSize: 'var(--text-xs)', marginBottom: 'var(--space-3)' }}>
                {formatFullDate(profitability.periodStart)} – {formatFullDate(profitability.periodEnd)} · reported in {profitability.reportingCurrency} (revenue converted from Credits, never
                added to USD directly)
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
                <StatTile value={`${profitability.totalRevenueCredits.toLocaleString()} cr`} label="Customer Revenue (Credits)" />
                <StatTile value={`$${profitability.totalRevenueUsd.toFixed(2)}`} label="Customer Revenue (USD)" />
                <StatTile value={`$${profitability.totalProviderCostUsd.toFixed(2)}`} label="Provider Cost" />
                <StatTile value={`$${profitability.grossProfitUsd.toFixed(2)}`} label="Gross Profit" />
                <StatTile value={profitability.grossMarginPct == null ? '—' : `${profitability.grossMarginPct.toFixed(1)}%`} label="Gross Margin" />
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

          <SectionCard title="Recent Alerts">
            {alerts.length === 0 ? (
              <p className={shared.emptyState}>No alerts fired yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {alerts.map((a) => (
                  <li key={a._id} style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--space-2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                      <strong>{a.title}</strong>
                      <span className={shared.mono} style={{ fontSize: 'var(--text-xs)' }}>
                        {formatFullDate(a.createdAt)}
                      </span>
                    </div>
                    <p className={shared.pageSubtitle} style={{ margin: 0, whiteSpace: 'pre-line' }}>
                      {a.message}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
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

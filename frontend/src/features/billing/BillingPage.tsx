import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import {
  FiArrowRight,
  FiCheckCircle,
  FiChevronDown,
  FiChevronUp,
  FiCreditCard,
  FiDatabase,
  FiDownload,
  FiFileText,
  FiPieChart,
  FiSliders,
  FiZap,
} from 'react-icons/fi';
import { Badge, Button, SectionCard, Skeleton, StatTile } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { billingService } from '@/services/billingService';
import type {
  BillingInvoiceSummary,
  CustomerTransaction,
  EntitlementAccess,
  PaymentMethod,
  PublicPlan,
  SubscriptionSummary,
  UsageSummary,
  WalletSummary,
} from '@/services/billingService';
import { useAuthStore } from '@/stores/authStore';
import { formatCurrency } from '@/utils/currency';
import { formatFullDate } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { hasRole } from '@/utils/roles';
import { AutoPaySettingsCard } from './components/AutoPaySettingsCard';
import { CurrentPlanCard } from './components/CurrentPlanCard';
import { PlanPriceCard } from './components/PlanPriceCard';
import { TransactionHistoryTable } from './components/TransactionHistoryTable';
import { WalletBalanceCard } from './components/WalletBalanceCard';
import styles from './BillingPage.module.css';

const INVOICE_TYPE_LABEL: Record<BillingInvoiceSummary['type'], string> = {
  purchase: 'Credit purchase',
  autopay: 'Auto Recharge',
  subscription_checkout: 'Subscription',
  subscription_renewal: 'Subscription renewal',
};

// The customer-facing Command Center for Haive Credits — separate from the
// admin-only /command-center page (which shows raw provider/cost internals
// this page must never surface). Balance/usage/history are visible to
// every real role; Auto Recharge configuration and purchasing are further
// restricted to owner/admin below, mirroring Finance's role split.
//
// Restructured around WalletBalanceCard as the one hero (available credits +
// low-balance/exhausted banners, previously duplicated on CurrentPlanCard
// too), a plan-comparison row (current plan alongside one upgrade
// suggestion, reusing PricingPage.tsx's own PlanPriceCard rather than a
// second copy of that markup), and a real Billing History section — the
// backend/service layer for invoices (billingService.listInvoices, GET
// /billing/invoices/:id/pdf) already existed and was simply never rendered
// anywhere before this.
export function BillingPage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const canManageBilling = hasRole(user, 'owner') || hasRole(user, 'admin');

  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionSummary | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [transactions, setTransactions] = useState<CustomerTransaction[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [entitlements, setEntitlements] = useState<EntitlementAccess[]>([]);
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [invoices, setInvoices] = useState<BillingInvoiceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUsage, setShowUsage] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [downloadingInvoiceId, setDownloadingInvoiceId] = useState<string | null>(null);

  const loadAll = () => {
    Promise.all([
      billingService.getWallet(),
      billingService.getSubscription(),
      billingService.getUsageSummary(),
      billingService.listTransactions(50),
      canManageBilling ? billingService.listPaymentMethods() : Promise.resolve([]),
      billingService.getEntitlements(),
      billingService.listPlans(),
      billingService.listInvoices(25),
    ])
      .then(([w, sub, u, t, m, ent, p, inv]) => {
        setWallet(w);
        setSubscription(sub);
        setUsage(u);
        setTransactions(t);
        setPaymentMethods(m);
        setEntitlements(ent);
        setPlans(p);
        setInvoices(inv);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDownloadInvoice = async (invoice: BillingInvoiceSummary) => {
    setDownloadingInvoiceId(invoice._id);
    try {
      await billingService.downloadInvoicePdf(invoice._id, invoice.invoiceNumber);
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setDownloadingInvoiceId(null);
    }
  };

  if (loading || !wallet || !usage) {
    return (
      <div className={styles.page}>
        <Skeleton height={100} />
        <Skeleton height={220} />
        <Skeleton height={160} />
      </div>
    );
  }

  // One upgrade suggestion alongside the current plan — prefers a
  // recommended plan, then whatever's next after the current one, never the
  // plan already active. The full comparison (every plan, every cycle)
  // stays on PricingPage; this is a shortcut, not a replacement for it.
  const upgradeCandidate = plans.find((p) => p.id !== subscription?.plan?.id && p.recommended) ?? plans.find((p) => p.id !== subscription?.plan?.id);
  const upgradePrice = upgradeCandidate?.prices.find((pr) => pr.billingCycle !== 'one_time') ?? upgradeCandidate?.prices[0];

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Billing</h1>
        <p className={styles.pageSubtitle}>Your plan, Haive Credits, and Auto Recharge — all in one place.</p>
      </div>

      <WalletBalanceCard
        wallet={wallet}
        onEnableAutoPay={() => {
          if (!canManageBilling) {
            toast.error('Only an owner or admin can manage Auto Recharge.');
            return;
          }
          document.getElementById('auto-recharge-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
        onViewPlans={() => navigate(ROUTES.pricing)}
      />

      <div className={styles.planRow}>
        <CurrentPlanCard wallet={wallet} subscription={subscription} onUpgrade={() => navigate(ROUTES.pricing)} />
        {upgradeCandidate && (
          <PlanPriceCard
            plan={upgradeCandidate}
            price={upgradePrice}
            cycleLabel={upgradePrice?.billingCycle ?? ''}
            ctaLabel={subscription ? 'Switch Plan' : 'Get Started'}
            ctaDisabled={false}
            onSelect={() => navigate(ROUTES.pricing)}
          />
        )}
      </div>

      <button type="button" className={styles.viewAllPlansLink} onClick={() => navigate(ROUTES.pricing)}>
        View all plans <FiArrowRight size={14} />
      </button>

      {entitlements.length > 0 && (
        <SectionCard title="Usage & Access" icon={FiCheckCircle}>
          <div>
            {entitlements.map((e) => (
              <div key={e.key} className={styles.entitlementRow}>
                <div className={styles.entitlementHeader}>
                  <span className={styles.entitlementLabel}>
                    <span className={styles.entitlementIconBadge}>
                      {e.type === 'boolean' ? <FiCheckCircle size={13} /> : <FiSliders size={13} />}
                    </span>
                    {e.name}
                  </span>
                  {e.type === 'boolean' ? (
                    <Badge variant={e.allowed ? 'success' : 'neutral'}>{e.allowed ? 'Included' : 'Not included'}</Badge>
                  ) : e.limit === undefined ? (
                    <Badge variant="accent">Unlimited</Badge>
                  ) : (
                    <span className={styles.creditsRowValue}>
                      {(e.used ?? 0).toLocaleString()} <span className={styles.muted}>/ {e.limit.toLocaleString()}</span>
                    </span>
                  )}
                </div>
                {e.type === 'numeric' && e.limit !== undefined && (
                  <div className={styles.entitlementProgressTrack}>
                    <div
                      className={styles.entitlementProgressFill}
                      style={{
                        width: `${Math.min(100, ((e.used ?? 0) / e.limit) * 100)}%`,
                        background: e.allowed ? 'var(--color-accent, var(--brand-accent-primary))' : 'var(--color-danger)',
                      }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {canManageBilling && (
        <div id="auto-recharge-section">
          <SectionCard title="Payment Method & Auto Recharge" icon={FiZap}>
            <AutoPaySettingsCard
              autoPay={wallet.autoPay}
              autoRechargePolicy={wallet.autoRechargePolicy}
              paymentMethods={paymentMethods}
              onChanged={loadAll}
            />
          </SectionCard>
        </div>
      )}

      <SectionCard title="Billing History" icon={FiFileText}>
        {invoices.length === 0 ? (
          <p className={styles.muted}>No invoices yet.</p>
        ) : (
          <div className={styles.invoiceList}>
            {invoices.map((invoice) => (
              <div key={invoice._id} className={styles.invoiceRow}>
                <div className={styles.invoiceMain}>
                  <span className={styles.invoiceIconBadge}>
                    <FiFileText size={16} />
                  </span>
                  <div className={styles.invoiceText}>
                    <span className={styles.invoiceNumber}>{invoice.invoiceNumber}</span>
                    <span className={styles.muted}>
                      {INVOICE_TYPE_LABEL[invoice.type]} &middot; {formatFullDate(invoice.issuedAt)}
                    </span>
                  </div>
                </div>
                <div className={styles.invoiceMeta}>
                  <span className={styles.invoiceAmount}>{formatCurrency(invoice.total, invoice.currencyCode)}</span>
                  <Badge variant={invoice.status === 'paid' ? 'success' : 'neutral'}>{invoice.status}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<FiDownload />}
                    loading={downloadingInvoiceId === invoice._id}
                    onClick={() => void handleDownloadInvoice(invoice)}
                  >
                    Download
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <button
        type="button"
        className={`${styles.disclosureToggle} ${showUsage ? styles.disclosureToggleOpen : ''}`}
        onClick={() => setShowUsage((v) => !v)}
      >
        <span className={styles.disclosureToggleIcon}>{showUsage ? <FiChevronUp /> : <FiChevronDown />}</span>
        Usage details
      </button>
      {showUsage && (
        <div className={styles.statGrid}>
          <StatTile icon={FiDatabase} value={usage.creditsUsedTotal.toLocaleString()} label="Credits Used" />
          <StatTile icon={FiPieChart} value={usage.aiRequestCount.toLocaleString()} label="AI Requests" />
          <StatTile value={usage.totalInputTokens.toLocaleString()} label="Input Tokens" />
          <StatTile value={usage.totalOutputTokens.toLocaleString()} label="Output Tokens" />
          <StatTile value={usage.totalTokens.toLocaleString()} label="Total Tokens" />
          <StatTile value={usage.totalPurchasedCredits.toLocaleString()} label="Total Purchased" />
          <StatTile value={usage.usageTodayCredits.toLocaleString()} label="Usage Today" />
          <StatTile value={usage.usageThisMonthCredits.toLocaleString()} label="Usage This Month" />
        </div>
      )}

      <button
        type="button"
        className={`${styles.disclosureToggle} ${showHistory ? styles.disclosureToggleOpen : ''}`}
        onClick={() => setShowHistory((v) => !v)}
      >
        <span className={styles.disclosureToggleIcon}>{showHistory ? <FiChevronUp /> : <FiChevronDown />}</span>
        Transaction history
      </button>
      {showHistory && (
        <SectionCard title="Transaction History" icon={FiCreditCard}>
          <TransactionHistoryTable transactions={transactions} />
        </SectionCard>
      )}
    </div>
  );
}

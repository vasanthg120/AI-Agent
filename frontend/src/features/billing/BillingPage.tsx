import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { FiCheckCircle, FiChevronDown, FiChevronUp, FiCreditCard, FiDatabase, FiPieChart, FiZap } from 'react-icons/fi';
import { Badge, SectionCard, StatTile } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { billingService } from '@/services/billingService';
import type {
  CustomerTransaction,
  EntitlementAccess,
  PaymentMethod,
  SubscriptionSummary,
  UsageSummary,
  WalletSummary,
} from '@/services/billingService';
import { useAuthStore } from '@/stores/authStore';
import { extractErrorMessage } from '@/utils/errors';
import { hasRole } from '@/utils/roles';
import { AutoPaySettingsCard } from './components/AutoPaySettingsCard';
import { CurrentPlanCard } from './components/CurrentPlanCard';
import { TransactionHistoryTable } from './components/TransactionHistoryTable';
import styles from './BillingPage.module.css';

// The customer-facing Command Center for Haive Credits — separate from the
// admin-only /command-center page (which shows raw provider/cost internals
// this page must never surface). Balance/usage/history are visible to
// every real role; Auto Recharge configuration and purchasing are further
// restricted to owner/admin below, mirroring Finance's role split.
//
// Deliberately a single flat page now (no Overview/History/Auto Recharge
// tabs) — the Current Plan card is the primary view; usage stats and
// transaction history are still fully available, just tucked behind
// disclosures rather than being the default view, so nothing is removed.
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
  const [loading, setLoading] = useState(true);
  const [showUsage, setShowUsage] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const loadAll = () => {
    Promise.all([
      billingService.getWallet(),
      billingService.getSubscription(),
      billingService.getUsageSummary(),
      billingService.listTransactions(50),
      canManageBilling ? billingService.listPaymentMethods() : Promise.resolve([]),
      billingService.getEntitlements(),
    ])
      .then(([w, sub, u, t, m, ent]) => {
        setWallet(w);
        setSubscription(sub);
        setUsage(u);
        setTransactions(t);
        setPaymentMethods(m);
        setEntitlements(ent);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading || !wallet || !usage) {
    return <div className={styles.page}>Loading...</div>;
  }

  return (
    <div className={styles.page}>
      <CurrentPlanCard
        wallet={wallet}
        subscription={subscription}
        onUpgrade={() => navigate(ROUTES.pricing)}
        onAddCredits={() => navigate(ROUTES.addCredits)}
      />

      {entitlements.length > 0 && (
        <SectionCard title="Usage & Access" icon={FiCheckCircle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {entitlements.map((e) => (
              <div key={e.key} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <span>{e.name}</span>
                  {e.type === 'boolean' ? (
                    <Badge variant={e.allowed ? 'success' : 'neutral'}>{e.allowed ? 'Included' : 'Not included'}</Badge>
                  ) : e.limit === undefined ? (
                    <span className={styles.muted}>Unlimited</span>
                  ) : (
                    <span className={styles.muted}>
                      {(e.used ?? 0).toLocaleString()} / {e.limit.toLocaleString()}
                    </span>
                  )}
                </div>
                {e.type === 'numeric' && e.limit !== undefined && (
                  <div style={{ height: 6, borderRadius: 999, background: 'var(--color-bg-subtle)', overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.min(100, ((e.used ?? 0) / e.limit) * 100)}%`,
                        background: e.allowed ? 'var(--color-accent)' : 'var(--color-danger)',
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
        <SectionCard title="Payment Method & Auto Recharge" icon={FiZap}>
          <AutoPaySettingsCard
            autoPay={wallet.autoPay}
            autoRechargePolicy={wallet.autoRechargePolicy}
            paymentMethods={paymentMethods}
            onChanged={loadAll}
            onRequirePurchase={() => navigate(ROUTES.addCredits)}
          />
        </SectionCard>
      )}

      <button type="button" className={styles.secondaryLink} onClick={() => setShowUsage((v) => !v)}>
        {showUsage ? <FiChevronUp /> : <FiChevronDown />} Usage details
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

      <button type="button" className={styles.secondaryLink} onClick={() => setShowHistory((v) => !v)}>
        {showHistory ? <FiChevronUp /> : <FiChevronDown />} Transaction history
      </button>
      {showHistory && (
        <SectionCard title="Transaction History" icon={FiCreditCard}>
          <TransactionHistoryTable transactions={transactions} />
        </SectionCard>
      )}

    </div>
  );
}

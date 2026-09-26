import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  FiActivity,
  FiAlertCircle,
  FiArchive,
  FiCheckCircle,
  FiCpu,
  FiCreditCard,
  FiDollarSign,
  FiRefreshCw,
  FiRepeat,
  FiUsers,
} from 'react-icons/fi';
import { Button, SectionCard, Skeleton, StatTile } from '@/components/ui';
import { billingAdminService, type AdminAnalytics, type AdminDashboard } from '@/services/billingAdminService';
import { aiUsageAdminService, type AnthropicUsageSummary } from '@/services/aiUsageAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatNumber } from '@/utils/format';
import { ADMIN_ROUTES } from '@/constants/routes';
import { AdminRangeControl } from './AdminRangeControl';
import { AdminLineChart } from './components/AdminLineChart';
import styles from './AdminDashboardPage.module.css';

// Compact summary only — the full breakdown (charts, model/org tables,
// request history) lives on its own page (AdminAiUsagePage.tsx) per the
// "don't overload the dashboard" guidance. Fetches independently of the
// billing dashboard's own days window so a billing-endpoint failure never
// blanks this card, and vice versa.
function AiProviderUsageCard({ days }: { days: number }) {
  const [summary, setSummary] = useState<AnthropicUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    aiUsageAdminService
      .getSummary(days)
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }, [days]);

  return (
    <SectionCard glass title="AI Provider Usage" icon={FiCpu} action={<Link to={ADMIN_ROUTES.aiUsage}><Button variant="ghost" size="sm">View Usage →</Button></Link>}>
      {loading ? (
        <Skeleton height={72} />
      ) : !summary?.connected ? (
        <p className={styles.subtitle} style={{ margin: 0 }}>
          Anthropic is not connected yet.
        </p>
      ) : (
        <div className={styles.aiUsageRow}>
          <div>
            <div className={styles.aiUsageValue}>{summary.budget ? `$${summary.budget.amount.toFixed(2)}` : '—'}</div>
            <div className={styles.aiUsageLabel}>Budget</div>
          </div>
          <div>
            <div className={styles.aiUsageValue}>${summary.usage.cost.toFixed(2)}</div>
            <div className={styles.aiUsageLabel}>Used</div>
          </div>
          <div>
            <div className={styles.aiUsageValue}>{summary.usage.remaining != null ? `$${summary.usage.remaining.toFixed(2)}` : '—'}</div>
            <div className={styles.aiUsageLabel}>Remaining</div>
          </div>
          <div>
            <div className={styles.aiUsageValue}>{formatNumber(summary.tokens.total)}</div>
            <div className={styles.aiUsageLabel}>Tokens</div>
          </div>
          <div>
            <div className={styles.aiUsageValue}>{summary.requests.total.toLocaleString()}</div>
            <div className={styles.aiUsageLabel}>Requests</div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

export function AdminDashboardPage() {
  const [days, setDays] = useState(30);
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([billingAdminService.getDashboard(days), billingAdminService.getAnalytics(days)])
      .then(([d, a]) => {
        setDashboard(d);
        setAnalytics(a);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  }, [days]);

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <span className={styles.liveBadge}>
          <span className={styles.liveDot} />
          Live Platform Data
        </span>
        <div className={styles.topRow}>
          <div>
            <h1 className={styles.title}>Dashboard</h1>
            <p className={styles.subtitle}>Platform-wide activity across every organization.</p>
          </div>
          <AdminRangeControl days={days} onChange={setDays} />
        </div>
      </div>

      {loading || !dashboard ? (
        <div className={styles.statsGrid}>
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} height={92} />
          ))}
        </div>
      ) : (
        <div className={styles.statsGrid}>
          <StatTile glass icon={FiUsers} value={dashboard.totalOrganizations.toLocaleString()} label="Total Organizations" />
          <StatTile glass icon={FiCheckCircle} value={dashboard.activeOrganizations.toLocaleString()} label="Active Organizations" />
          <StatTile glass icon={FiUsers} value={dashboard.totalUsers.toLocaleString()} label="Total Users" />
          <StatTile glass icon={FiRepeat} value={dashboard.activeSubscriptions.toLocaleString()} label="Active Subscriptions" />
          <StatTile glass icon={FiDollarSign} value={`$${dashboard.revenueUsd.toFixed(2)}`} label="Total Revenue" />
          <StatTile glass icon={FiCheckCircle} value={dashboard.successfulPaymentsCount.toLocaleString()} label="Successful Payments" />
          <StatTile glass icon={FiAlertCircle} value={dashboard.failedPaymentsCount.toLocaleString()} label="Failed Payments" />
          <StatTile glass icon={FiRefreshCw} value={dashboard.refundedPaymentsCount.toLocaleString()} label="Refunded Payments" />
          <StatTile glass icon={FiCreditCard} value={dashboard.creditsSold.toLocaleString()} label="Credits Sold" />
          <StatTile glass icon={FiActivity} value={dashboard.creditsUsed.toLocaleString()} label="Credits Consumed" />
          <StatTile glass icon={FiArchive} value={dashboard.creditsOutstanding.toLocaleString()} label="Credits Outstanding" />
          <StatTile
            glass
            icon={FiRefreshCw}
            value={dashboard.autoRechargeEventsInPeriod.toLocaleString()}
            label="Auto-Recharge Events"
            trend={{ direction: 'up', label: `${dashboard.autoRechargeEnabledWallets} wallets enabled` }}
          />
        </div>
      )}

      <AiProviderUsageCard days={days} />

      <div className={styles.chartsGrid}>
        <SectionCard glass title="Revenue Over Time" icon={FiDollarSign}>
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.revenueSeries} color="#5b8def" valueFormatter={(v) => `$${v.toFixed(0)}`} />}
        </SectionCard>
        <SectionCard glass title="Credit Usage Over Time" icon={FiActivity}>
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.creditUsageSeries} color="#4ade80" />}
        </SectionCard>
        <SectionCard glass title="New Organizations Over Time" icon={FiUsers}>
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.newOrganizationsSeries} color="#fbbf24" />}
        </SectionCard>
        <SectionCard glass title="Subscription Growth" icon={FiRepeat}>
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.subscriptionGrowthSeries} color="#a78bfa" />}
        </SectionCard>
      </div>
    </div>
  );
}

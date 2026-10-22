import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import toast from 'react-hot-toast';
import {
  FiActivity,
  FiAlertCircle,
  FiArchive,
  FiCalendar,
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
import { useAdminAuthStore } from '@/stores/adminAuthStore';
import { extractErrorMessage } from '@/utils/errors';
import { formatNumber } from '@/utils/format';
import { ADMIN_ROUTES } from '@/constants/routes';
import { AdminRangeControl } from './AdminRangeControl';
import { AdminLineChart } from './components/AdminLineChart';
import styles from './AdminDashboardPage.module.css';

// Same time-of-day greeting the customer dashboard's hero uses (see
// DashboardHeroHeader.tsx's own greeting()) — copied rather than imported
// since that component lives in a different feature folder and pulls in
// unrelated deal/store-filter dependencies this page has no use for.
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

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
  const admin = useAdminAuthStore((state) => state.admin);
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
            <h1 className={styles.title}>
              {greeting()}
              {admin?.name ? `, ${admin.name}` : ''} 👋
            </h1>
            <p className={styles.subtitle}>Here's what's happening across the platform today.</p>
          </div>
          {/* Read-only — reflects the exact window AdminRangeControl's
              `days` is already querying, not a second control. Adding a
              clickable/editable date picker here would duplicate what that
              control already does and risk the two drifting out of sync. */}
          <span className={styles.dateRangeBadge}>
            <FiCalendar size={13} />
            {dayjs().subtract(days - 1, 'day').format('MMM D, YYYY')} – {dayjs().format('MMM D, YYYY')}
          </span>
        </div>

        <div className={styles.toolbar}>
          <span className={styles.toolbarLabel}>Reporting period</span>
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
          {/* Sparklines reuse the exact same per-day series already fetched
              for this page's own "Over Time" charts below (analytics state,
              loaded alongside `dashboard` above) — no new API calls, no
              invented numbers. Only tiles with a real matching series get
              one; the other six render exactly as before (StatTile's
              sparkline prop is optional/additive). */}
          <StatTile
            glass
            icon={FiUsers}
            value={dashboard.totalOrganizations.toLocaleString()}
            label="Total Organizations"
            sparkline={analytics?.newOrganizationsSeries.map((p) => p.value)}
            sparklineColor="#5b8def"
          />
          <StatTile glass icon={FiCheckCircle} value={dashboard.activeOrganizations.toLocaleString()} label="Active Organizations" />
          <StatTile glass icon={FiUsers} value={dashboard.totalUsers.toLocaleString()} label="Total Users" />
          <StatTile
            glass
            icon={FiRepeat}
            value={dashboard.activeSubscriptions.toLocaleString()}
            label="Active Subscriptions"
            sparkline={analytics?.subscriptionGrowthSeries.map((p) => p.value)}
            sparklineColor="#a78bfa"
          />
          <StatTile
            glass
            icon={FiDollarSign}
            value={`$${dashboard.revenueUsd.toFixed(2)}`}
            label="Total Revenue"
            sparkline={analytics?.revenueSeries.map((p) => p.value)}
            sparklineColor="#5b8def"
          />
          <StatTile
            glass
            icon={FiCheckCircle}
            value={dashboard.successfulPaymentsCount.toLocaleString()}
            label="Successful Payments"
            sparkline={analytics?.paymentSuccessSeries.map((p) => p.value)}
            sparklineColor="#16a34a"
          />
          <StatTile
            glass
            icon={FiAlertCircle}
            value={dashboard.failedPaymentsCount.toLocaleString()}
            label="Failed Payments"
            sparkline={analytics?.paymentFailureSeries.map((p) => p.value)}
            sparklineColor="#f87171"
          />
          <StatTile glass icon={FiRefreshCw} value={dashboard.refundedPaymentsCount.toLocaleString()} label="Refunded Payments" />
          <StatTile glass icon={FiCreditCard} value={dashboard.creditsSold.toLocaleString()} label="Credits Sold" />
          <StatTile
            glass
            icon={FiActivity}
            value={dashboard.creditsUsed.toLocaleString()}
            label="Credits Consumed"
            sparkline={analytics?.creditUsageSeries.map((p) => p.value)}
            sparklineColor="#d97706"
          />
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
        {/* #16a34a/#d97706, not the original #4ade80/#fbbf24 — both failed
            dataviz's validate_palette.js (outside the lightness band, under
            3:1 contrast against the card's white surface), which is exactly
            the washed-out look these two charts had. Same green/amber hue
            family, just a deeper, validated shade. */}
        <SectionCard glass title="Credit Usage Over Time" icon={FiActivity}>
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.creditUsageSeries} color="#16a34a" />}
        </SectionCard>
        <SectionCard glass title="New Organizations Over Time" icon={FiUsers}>
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.newOrganizationsSeries} color="#d97706" />}
        </SectionCard>
        <SectionCard glass title="Subscription Growth" icon={FiRepeat}>
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.subscriptionGrowthSeries} color="#a78bfa" />}
        </SectionCard>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { SectionCard, Skeleton, StatTile } from '@/components/ui';
import { billingAdminService, type AdminAnalytics, type SubscriptionMetrics } from '@/services/billingAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { AdminRangeControl } from './AdminRangeControl';
import { AdminLineChart } from './components/AdminLineChart';
import shared from './adminShared.module.css';

const PIE_COLORS = ['#5b8def', '#4ade80', '#fbbf24', '#a78bfa', '#f87171', '#38bdf8'];

export function AdminAnalyticsPage() {
  const [days, setDays] = useState(30);
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [metrics, setMetrics] = useState<SubscriptionMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([billingAdminService.getAnalytics(days), billingAdminService.getSubscriptionMetrics(days)])
      .then(([a, m]) => {
        setAnalytics(a);
        setMetrics(m);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  }, [days]);

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Analytics</h1>
          <p className={shared.pageSubtitle}>Revenue, credits, subscriptions, and churn — all computed live from the ledger and subscription events.</p>
        </div>
        <AdminRangeControl days={days} onChange={setDays} />
      </div>

      {loading || !metrics ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 'var(--space-4)' }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height={92} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 'var(--space-4)' }}>
          <StatTile value={`$${metrics.mrrUsd.toFixed(2)}`} label="MRR" />
          <StatTile value={`$${metrics.arrUsd.toFixed(2)}`} label="ARR" />
          <StatTile value={metrics.activeCount} label="Active Subscriptions" />
          <StatTile value={metrics.trialingCount} label="Trialing" />
          <StatTile value={`${metrics.churnRatePct}%`} label="Churn Rate" />
          <StatTile value={metrics.newSubscriptionsInPeriod} label="New in Period" />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 'var(--space-5)' }}>
        <SectionCard title="Revenue">
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.revenueSeries} color="#5b8def" valueFormatter={(v) => `$${v.toFixed(0)}`} />}
        </SectionCard>
        <SectionCard title="Credits Sold vs Consumed">
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.creditUsageSeries} color="#4ade80" />}
        </SectionCard>
        <SectionCard title="Payments Succeeded">
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.paymentSuccessSeries} color="#4ade80" />}
        </SectionCard>
        <SectionCard title="Payments Failed">
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.paymentFailureSeries} color="#f87171" />}
        </SectionCard>
        <SectionCard title="Subscription Growth">
          {loading || !analytics ? <Skeleton height={220} /> : <AdminLineChart data={analytics.subscriptionGrowthSeries} color="#a78bfa" />}
        </SectionCard>
        <SectionCard title="Plan Distribution">
          {loading || !analytics ? (
            <Skeleton height={220} />
          ) : analytics.planDistribution.length === 0 ? (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
              No active subscriptions yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={analytics.planDistribution} dataKey="count" nameKey="planName" cx="50%" cy="50%" outerRadius={80} label={(entry) => `${entry.planName}: ${entry.count}`}>
                  {analytics.planDistribution.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)' }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

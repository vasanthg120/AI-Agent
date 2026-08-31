import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { FiCheck, FiHelpCircle } from 'react-icons/fi';
import { Badge, Button, Card, SectionCard, Spinner, Tabs } from '@/components/ui';
import { billingService } from '@/services/billingService';
import type { BillingCycle, BillingPageConfig, PaymentMethod, PlanPrice, PublicPlan, SubscriptionSummary } from '@/services/billingService';
import { extractErrorMessage } from '@/utils/errors';
import { formatCurrency } from '@/utils/currency';
import { SubscriptionCheckoutModal } from './components/SubscriptionCheckoutModal';
import { useBillingTheme } from './useBillingTheme';
import styles from './PricingPage.module.css';

const CYCLE_LABELS: Record<BillingCycle, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  one_time: 'One-time',
};
const CYCLE_ORDER: BillingCycle[] = ['weekly', 'monthly', 'quarterly', 'yearly'];

function orderPlans(plans: PublicPlan[], displayedPlanIds: string[]): PublicPlan[] {
  if (displayedPlanIds.length === 0) return plans;
  const byId = new Map(plans.map((p) => [p.id, p]));
  const ordered = displayedPlanIds.map((id) => byId.get(id)).filter((p): p is PublicPlan => Boolean(p));
  // Any plan not explicitly curated still shows, appended after the curated
  // order, so a newly-created plan is never silently invisible just because
  // the admin hasn't touched the page config yet.
  const remaining = plans.filter((p) => !displayedPlanIds.includes(p.id));
  return [...ordered, ...remaining];
}

// Fully admin-driven public pricing/plans page — every string, plan, price,
// and FAQ entry comes from GET /billing/page-config + GET /billing/plans,
// nothing hardcoded (see the spec's own "no hardcoded plan/price/copy"
// requirement). Separate from BillingPage.tsx, which is the logged-in
// wallet/usage dashboard for an org that's already subscribed/purchasing —
// this is the "browse and subscribe" surface.
export function PricingPage() {
  const { style: themeStyle } = useBillingTheme();
  const [pageConfig, setPageConfig] = useState<BillingPageConfig | null>(null);
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [subscription, setSubscription] = useState<SubscriptionSummary | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCycle, setSelectedCycle] = useState<BillingCycle | null>(null);
  const [checkoutTarget, setCheckoutTarget] = useState<{ plan: PublicPlan; price: PlanPrice } | null>(null);

  const loadAll = () => {
    Promise.all([billingService.getPageConfig(), billingService.listPlans(), billingService.getSubscription(), billingService.listPaymentMethods()])
      .then(([config, planList, sub, methods]) => {
        setPageConfig(config);
        setPlans(orderPlans(planList, config.displayedPlanIds));
        setSubscription(sub);
        setPaymentMethods(methods);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const availableCycles = useMemo(() => {
    const found = new Set<BillingCycle>();
    for (const plan of plans) {
      for (const price of plan.prices) {
        if (price.billingCycle !== 'one_time') found.add(price.billingCycle);
      }
    }
    return CYCLE_ORDER.filter((c) => found.has(c));
  }, [plans]);

  const activeCycle = selectedCycle && availableCycles.includes(selectedCycle) ? selectedCycle : (availableCycles[0] ?? null);

  const priceForPlan = (plan: PublicPlan): PlanPrice | undefined => {
    const recurring = plan.prices.filter((p) => p.billingCycle !== 'one_time');
    return recurring.find((p) => p.billingCycle === activeCycle) ?? recurring[0];
  };

  if (loading) {
    return (
      <div className={styles.page} style={themeStyle}>
        <div className={styles.loadingState}>
          <Spinner size={28} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page} style={themeStyle}>
      <div className={styles.hero}>
        {pageConfig?.heroHeadline && <h1 className={styles.heroHeadline}>{pageConfig.heroHeadline}</h1>}
        {pageConfig?.heroSubtext && <p className={styles.heroSubtext}>{pageConfig.heroSubtext}</p>}
      </div>

      {subscription && (
        <div className={styles.subscribedBanner}>
          <span>
            You&apos;re currently on the <strong>{subscription.plan?.name ?? 'Unknown'}</strong> plan
            {subscription.cancelAtPeriodEnd ? ' (canceling at period end)' : ''}.
          </span>
          <Badge variant={subscription.status === 'past_due' ? 'warning' : 'success'}>{subscription.status}</Badge>
        </div>
      )}

      {availableCycles.length > 1 && (
        <div className={styles.cycleToggle}>
          <Tabs
            items={availableCycles.map((c) => ({ id: c, label: CYCLE_LABELS[c] }))}
            activeId={activeCycle ?? availableCycles[0]}
            onChange={(id) => setSelectedCycle(id as BillingCycle)}
          />
        </div>
      )}

      {plans.length === 0 ? (
        <Card className={styles.emptyState}>No plans are published yet. Check back soon.</Card>
      ) : (
        <div className={styles.planGrid}>
          {plans.map((plan) => {
            const price = priceForPlan(plan);
            const isCurrentPlan = subscription?.plan?.id === plan.id;
            // Already subscribed to a DIFFERENT plan — clicking this now
            // switches to it (BillingSubscriptionsService.checkout allows a
            // different plan through and supersedes the old subscription on
            // activation), not a first-time subscribe, so the CTA reads
            // "Switch Plan" instead of the generic first-subscribe copy.
            const isSwitch = Boolean(subscription) && !isCurrentPlan;
            return (
              <Card
                key={plan.id}
                className={styles.planCard}
                style={plan.planColor ? ({ '--plan-accent': plan.planColor } as React.CSSProperties) : undefined}
              >
                {plan.badgeText && (
                  <Badge variant={plan.recommended ? 'success' : 'neutral'} className={styles.planBadge}>
                    {plan.badgeText}
                  </Badge>
                )}
                <div className={styles.planName}>{plan.name}</div>
                {plan.shortDescription && <div className={styles.planDescription}>{plan.shortDescription}</div>}

                {price ? (
                  <>
                    <div className={styles.planPrice}>
                      <span className={styles.planPriceAmount}>{formatCurrency(price.amount, price.currencyCode)}</span>
                      <span className={styles.planPriceCycle}>/ {CYCLE_LABELS[price.billingCycle]}</span>
                    </div>
                    <div className={styles.muted}>{price.creditsGranted.toLocaleString()} Haive Credits included</div>
                  </>
                ) : (
                  <div className={styles.planPrice}>
                    <span className={styles.muted}>Pricing coming soon</span>
                  </div>
                )}

                {plan.features.filter((f) => f.enabled).length > 0 && (
                  <ul className={styles.featureList}>
                    {plan.features
                      .filter((f) => f.enabled)
                      .map((f) => (
                        <li key={f.featureKey}>
                          <FiCheck /> {f.valueOverride ?? f.name ?? f.featureKey}
                        </li>
                      ))}
                  </ul>
                )}

                <Button
                  className={styles.planCta}
                  disabled={!price || isCurrentPlan}
                  onClick={() => price && setCheckoutTarget({ plan, price })}
                >
                  {isCurrentPlan ? 'Current Plan' : isSwitch ? 'Switch Plan' : (pageConfig?.ctaButtonText ?? 'Get Started')}
                </Button>
              </Card>
            );
          })}
        </div>
      )}

      {pageConfig && pageConfig.faqEntries.length > 0 && (
        <SectionCard title="Frequently Asked Questions" icon={FiHelpCircle}>
          <div className={styles.faqList}>
            {pageConfig.faqEntries.map((faq, index) => (
              <div key={index} className={styles.faqEntry}>
                <div className={styles.faqQuestion}>{faq.question}</div>
                <div className={styles.faqAnswer}>{faq.answer}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {checkoutTarget && (
        <SubscriptionCheckoutModal
          open={Boolean(checkoutTarget)}
          onClose={() => setCheckoutTarget(null)}
          plan={checkoutTarget.plan}
          price={checkoutTarget.price}
          paymentMethods={paymentMethods}
          onPaymentMethodsChanged={loadAll}
          onSubscribed={loadAll}
        />
      )}
    </div>
  );
}

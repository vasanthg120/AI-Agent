import { FiCheck } from 'react-icons/fi';
import { Badge, Button, Card } from '@/components/ui';
import type { PlanPrice, PublicPlan } from '@/services/billingService';
import { formatCurrency } from '@/utils/currency';
import styles from '../PricingPage.module.css';

export interface PlanPriceCardProps {
  plan: PublicPlan;
  price: PlanPrice | undefined;
  cycleLabel: string;
  ctaLabel: string;
  ctaDisabled: boolean;
  onSelect: () => void;
}

// Extracted from PricingPage.tsx's own per-plan card JSX (was inlined in its
// planGrid.map) so BillingPage.tsx's redesigned plan row can show a current
// plan alongside an upgrade option without duplicating this markup — both
// pages import the same PricingPage.module.css classes, which already fall
// back to Haive's own --color-accent/etc. tokens when no admin billing theme
// (useBillingTheme, PricingPage-only) is active.
export function PlanPriceCard({ plan, price, cycleLabel, ctaLabel, ctaDisabled, onSelect }: PlanPriceCardProps) {
  return (
    <Card className={styles.planCard} style={plan.planColor ? ({ '--plan-accent': plan.planColor } as React.CSSProperties) : undefined}>
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
            <span className={styles.planPriceCycle}>/ {cycleLabel}</span>
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

      <Button className={styles.planCta} disabled={!price || ctaDisabled} onClick={onSelect}>
        {ctaLabel}
      </Button>
    </Card>
  );
}

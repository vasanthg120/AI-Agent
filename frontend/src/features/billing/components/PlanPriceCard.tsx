import { FiArrowRight, FiCheck } from 'react-icons/fi';
import clsx from 'clsx';
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
//
// `plan.recommended` drives the highlighted "featured" card treatment
// (solid accent background, inverted CTA) — the same flag admins already set
// in AdminPlansPage.tsx's Publish step, not a hardcoded "middle card" guess.
export function PlanPriceCard({ plan, price, cycleLabel, ctaLabel, ctaDisabled, onSelect }: PlanPriceCardProps) {
  const enabledFeatures = plan.features.filter((f) => f.enabled);

  return (
    <Card
      className={clsx(styles.planCard, plan.recommended && styles.planCardFeatured)}
      style={plan.planColor ? ({ '--plan-accent': plan.planColor } as React.CSSProperties) : undefined}
    >
      {plan.badgeText && (
        <Badge variant={plan.recommended ? 'success' : 'neutral'} className={styles.planBadge}>
          {plan.badgeText}
        </Badge>
      )}

      <div className={styles.planHeader}>
        <span className={styles.planIconCircle}>{plan.icon || plan.name.charAt(0).toUpperCase()}</span>
        <span className={styles.planName}>{plan.name}</span>
      </div>
      {plan.shortDescription && <div className={styles.planDescription}>{plan.shortDescription}</div>}

      {price ? (
        <>
          <div className={styles.planPrice}>
            <span className={styles.planPriceAmount}>{formatCurrency(price.amount, price.currencyCode)}</span>
            <span className={styles.planPriceCycle}>/{cycleLabel}</span>
          </div>
          <div className={styles.planPriceCaption}>{price.creditsGranted.toLocaleString()} Haive Credits included</div>
        </>
      ) : (
        <div className={styles.planPrice}>
          <span className={styles.planPriceCaption}>Pricing coming soon</span>
        </div>
      )}

      <Button
        className={styles.planCta}
        variant={plan.recommended ? 'secondary' : 'primary'}
        disabled={!price || ctaDisabled}
        onClick={onSelect}
        rightIcon={
          <span className={styles.planCtaArrow}>
            <FiArrowRight size={12} />
          </span>
        }
      >
        {ctaLabel}
      </Button>

      {enabledFeatures.length > 0 && (
        <>
          <div className={styles.benefitsLabel}>Benefits</div>
          <ul className={styles.featureList}>
            {enabledFeatures.map((f) => (
              <li key={f.featureKey}>
                <span className={styles.featureCheck}>
                  <FiCheck size={11} />
                </span>
                {f.valueOverride ?? f.name ?? f.featureKey}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

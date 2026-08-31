import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Card, Spinner } from '@/components/ui';
import { billingService } from '@/services/billingService';
import type { CreditPackage, PaymentMethod } from '@/services/billingService';
import { extractErrorMessage } from '@/utils/errors';
import { CreditPackageGrid } from './components/CreditPackageGrid';
import { RazorpayCheckoutModal } from './components/RazorpayCheckoutModal';
import styles from './PricingPage.module.css';

// Standalone "Add Credits" page — deliberately separate from /pricing
// (plans), per the request. The package grid renders directly on the page
// (matching the wireframe); clicking a package opens RazorpayCheckoutModal
// straight to its order-review/payment screen via initialPackage, reusing
// the exact same purchase/confirm flow BillingPage used to trigger inline.
export function AddCreditsPage() {
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPackage, setSelectedPackage] = useState<CreditPackage | null>(null);

  const loadAll = () => {
    Promise.all([billingService.listPackages(), billingService.listPaymentMethods()])
      .then(([p, m]) => {
        setPackages(p);
        setPaymentMethods(m);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAll();
  }, []);

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loadingState}>
          <Spinner size={28} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <h1 className={styles.heroHeadline}>Add Credits</h1>
        <p className={styles.heroSubtext}>Buy credits whenever you need them.</p>
      </div>

      {packages.length === 0 ? (
        <Card className={styles.emptyState}>No credit packages are available yet. Check back soon.</Card>
      ) : (
        <CreditPackageGrid packages={packages} purchasingKey={null} onPurchase={(key) => setSelectedPackage(packages.find((p) => p.key === key) ?? null)} />
      )}

      {selectedPackage && (
        <RazorpayCheckoutModal
          key={selectedPackage.key}
          open
          initialPackage={selectedPackage}
          onClose={() => setSelectedPackage(null)}
          packages={packages}
          paymentMethods={paymentMethods}
          onPaymentMethodsChanged={loadAll}
          onPurchased={loadAll}
        />
      )}
    </div>
  );
}

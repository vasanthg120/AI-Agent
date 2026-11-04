import { SubscriptionLockScreen } from '@/features/sub-accounts/SubscriptionLockScreen';

/** A sub-account without a live subscription: HaiVE's own lock screen (loaded only when needed). */
export function LockedScreen() {
  return <SubscriptionLockScreen outsideApp homeDestination="/dialer/" />;
}

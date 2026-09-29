import clsx from 'clsx';
import { PROVIDER_LABEL, type CallingProvider } from '@/services/callingService';
import styles from './ProviderPill.module.css';

// Which carrier a call or line goes through — small, colour-coded, so a mixed
// Plivo/Twilio call log reads at a glance.
export function ProviderPill({ provider }: { provider: CallingProvider }) {
  return <span className={clsx(styles.pill, styles[provider])}>{PROVIDER_LABEL[provider]}</span>;
}

import { useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGroup, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiArrowRight, FiCheckCircle, FiCircle, FiGlobe, FiPhoneCall } from 'react-icons/fi';
import { Skeleton } from '@/components/ui';
import { CallStatus } from '@/features/calling/CallStatus';
import { Flag } from '@/features/calling/Flag';
import { ProviderPill } from '@/features/calling/ProviderPill';
import {
  callingService,
  countryOfNumber,
  flagPrefix,
  formatInternational,
  type CallingCall,
  type CallingProvider,
} from '@/services/callingService';
import { formatDuration, isCallActive, plivoService } from '@/services/plivoService';
import { twilioService } from '@/services/twilioService';
import { extractErrorMessage } from '@/utils/errors';
import { SettingsSection } from '../components/SettingsSection';
import { PlivoSetup } from './calling/PlivoSetup';
import { TwilioSetup } from './calling/TwilioSetup';
import styles from './CallingSettings.module.css';

const TAB_STORAGE_KEY = 'haive-calling-settings-provider';

function readStoredTab(): CallingProvider {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) === 'twilio' ? 'twilio' : 'plivo';
  } catch {
    return 'plivo';
  }
}

interface ProviderCardInfo {
  id: CallingProvider;
  name: string;
  scope: string;
  flag: ReactNode;
  connected?: boolean;
  // The provider's status couldn't be loaded (e.g. the server is older than this page).
  failed?: boolean;
  lines?: number;
}

// Settings -> Calling. Two carriers, one experience: Plivo for Indian numbers,
// Twilio for the rest of the world. Every call either way is recorded and lands
// in Call Library with a transcript, summary and AI Coach report.
export function CallingSettings() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<CallingProvider>(readStoredTab);
  const [retrying, setRetrying] = useState<string | null>(null);

  // Both are also used by the setup panels below (same query keys, one request each).
  const { data: plivo, isError: plivoFailed } = useQuery({
    queryKey: ['plivo', 'config'],
    queryFn: plivoService.getConfig,
  });
  const { data: twilio, isError: twilioFailed } = useQuery({
    queryKey: ['twilio', 'config'],
    queryFn: twilioService.getConfig,
  });
  const anyConnected = plivo?.connected || twilio?.connected;
  const { data: calls } = useQuery({
    queryKey: ['calling', 'calls', 'org'],
    queryFn: () => callingService.listCalls('org'),
    enabled: !!anyConnected,
    refetchInterval: (query) => (query.state.data?.some(isCallActive) ? 8_000 : false),
  });

  const chooseTab = (next: CallingProvider) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // Non-fatal.
    }
  };

  const handleRetry = async (call: CallingCall) => {
    setRetrying(call.id);
    try {
      await callingService.retryImport(call);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setRetrying(null);
      await queryClient.invalidateQueries({ queryKey: ['calling', 'calls'] });
    }
  };

  const cards: ProviderCardInfo[] = [
    {
      id: 'plivo',
      name: 'Plivo',
      scope: 'Indian numbers (+91)',
      flag: <Flag iso="IN" size="lg" />,
      connected: plivo?.connected,
      failed: plivoFailed,
      lines: plivo?.lines.filter((l) => l.active).length,
    },
    {
      id: 'twilio',
      name: 'Twilio',
      scope: 'International numbers',
      flag: <FiGlobe className={styles.globe} />,
      connected: twilio?.connected,
      failed: twilioFailed,
      lines: twilio?.lines.filter((l) => l.active).length,
    },
  ];
  const both = plivo?.connected && twilio?.connected;

  return (
    <div className={styles.page}>
      <SettingsSection
        icon={<FiPhoneCall />}
        title="Phone calling"
        description="Place and receive real phone calls from HaiVE. Each call is recorded, then transcribed, summarized and coached in Call Library."
      >
        <LayoutGroup id="calling-providers">
          <div className={styles.providers} role="tablist" aria-label="Phone provider">
            {cards.map((card) => {
              const active = tab === card.id;
              const loading = card.connected === undefined && !card.failed;
              return (
                <button
                  key={card.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={clsx(styles.provider, active && styles.providerActive)}
                  onClick={() => chooseTab(card.id)}
                >
                  {active && (
                    <motion.span
                      layoutId="provider-highlight"
                      className={styles.providerHighlight}
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className={styles.providerTop}>
                    <span className={styles.providerFlag} aria-hidden>
                      {card.flag}
                    </span>
                    {loading ? (
                      <Skeleton height={18} width={90} />
                    ) : card.failed ? (
                      <span className={styles.providerState}>
                        <FiCircle aria-hidden /> Status unavailable
                      </span>
                    ) : card.connected ? (
                      <span className={clsx(styles.providerState, styles.providerOn)}>
                        <FiCheckCircle aria-hidden />{' '}
                        {card.lines ? `${card.lines} live number${card.lines === 1 ? '' : 's'}` : 'Connected'}
                      </span>
                    ) : (
                      <span className={styles.providerState}>
                        <FiCircle aria-hidden /> Not connected
                      </span>
                    )}
                  </span>
                  <span className={styles.providerName}>{card.name}</span>
                  <span className={styles.providerScope}>{card.scope}</span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>

        <div className={styles.routing}>
          <FiGlobe aria-hidden />
          <span>
            {both ? (
              <>
                Calls are routed automatically: {flagPrefix('IN')}
                <strong>+91</strong> <FiArrowRight className={styles.inlineIcon} aria-hidden /> Plivo, every other
                country <FiArrowRight className={styles.inlineIcon} aria-hidden /> Twilio. People can still pick the
                other route for a single call.
              </>
            ) : plivo?.connected ? (
              <>Only Plivo is connected, so it carries every call. Connect Twilio for reliable international calling.</>
            ) : twilio?.connected ? (
              <>
                Only Twilio is connected, so it carries every call, Indian numbers included. Connect Plivo to call
                Indian numbers from an Indian number.
              </>
            ) : (
              <>
                Connect one provider to start. With both, Indian numbers go through Plivo and every other country
                through Twilio.
              </>
            )}
          </span>
        </div>
      </SettingsSection>

      <>
        <motion.div
          key={tab}
          className={styles.page}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
        >
          {tab === 'plivo' ? <PlivoSetup /> : <TwilioSetup />}
        </motion.div>
      </>

      {anyConnected && (
        <SettingsSection
          icon={<FiPhoneCall />}
          title="Recent calls"
          description="Every call through your Plivo and Twilio numbers, and where its recording is on its way to Call Library."
        >
          {!calls ? (
            <Skeleton height={96} />
          ) : calls.length === 0 ? (
            <p className={styles.hint}>No calls yet. Place one from Call Copilot, or call one of your numbers.</p>
          ) : (
            <ul className={styles.callList}>
              {calls.map((call) => {
                const country = countryOfNumber(call.customerNumber);
                return (
                  <li key={`${call.provider}-${call.id}`} className={styles.callItem}>
                    <div className={styles.callMain}>
                      <span className={styles.callTitle}>
                        {country ? flagPrefix(country.iso) : ''}
                        {call.direction === 'outbound' ? 'Called' : 'Received from'}{' '}
                        {formatInternational(call.customerNumber)}
                      </span>
                      <span className={styles.callMeta}>
                        <ProviderPill provider={call.provider} />{' '}
                        {new Date(call.createdAt).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                        {formatDuration(call.durationSeconds) ? ` · ${formatDuration(call.durationSeconds)}` : ''}
                        {` · via ${formatInternational(call.businessNumber)}`}
                      </span>
                    </div>
                    <CallStatus call={call} onRetry={(c) => void handleRetry(c)} retrying={retrying === call.id} />
                  </li>
                );
              })}
            </ul>
          )}
        </SettingsSection>
      )}
    </div>
  );
}

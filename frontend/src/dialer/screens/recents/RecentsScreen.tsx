import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CallingCall } from '@/services/callingService';
import { CallDetailsSheet } from '../../components/CallDetailsSheet';
import { CallRow } from '../../components/CallRow';
import { FiAlertTriangle, FiClock } from '../../components/icons';
import { ActionButton, StateScreen } from '../../components/StateScreen';
import { ScreenLoading } from '../../layout/DialerLayout';
import { useDialerAccess } from '../../lib/access';
import { dayGroup } from '../../lib/callText';
import { usePlaceCall } from '../../lib/placeCall';
import { useCalls } from '../../lib/useCalls';
import styles from './RecentsScreen.module.css';

const GROUPS = ['Today', 'Yesterday', 'Earlier'] as const;

/** My calls, newest first, by day: tap to call again, ⓘ or swipe for the details. */
export function RecentsScreen() {
  const { canPlace } = useDialerAccess();
  const navigate = useNavigate();
  const { calls, isLoading, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useCalls();
  const { place, placing } = usePlaceCall();
  const [details, setDetails] = useState<CallingCall | null>(null);
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const now = new Date();
    return GROUPS.map((label) => ({ label, calls: calls.filter((call) => dayGroup(call.createdAt, now) === label) })).filter((g) => g.calls.length > 0);
  }, [calls]);

  const callAgain = async (call: CallingCall) => {
    setError(null);
    setPlacingId(call.id);
    const result = await place({ digits: call.customerNumber, customerName: call.customerName, dealId: call.dealId });
    setPlacingId(null);
    if (!result.ok && result.message) {
      setDetails(null);
      setError(result.message);
    }
  };

  if (isLoading) return <ScreenLoading />;
  if (isError && calls.length === 0) {
    return (
      <StateScreen icon={<FiAlertTriangle />} tone="warning" title="Couldn’t load your calls" actions={<ActionButton onClick={() => void refetch()}>Try again</ActionButton>}>
        <p>HaiVE didn’t answer. Check your connection and try again.</p>
      </StateScreen>
    );
  }
  if (calls.length === 0) {
    return (
      <StateScreen icon={<FiClock />} title="No calls yet" actions={canPlace ? <ActionButton onClick={() => navigate('/')}>Open the keypad</ActionButton> : undefined}>
        <p>Calls you place from the Dialer or from HaiVE show up here, with their scores once the reports are ready.</p>
      </StateScreen>
    );
  }

  return (
    <div className={styles.screen}>
      <h1 className="sr-only">Recents</h1>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.label} aria-labelledby={`recents-${group.label}`}>
          <h2 id={`recents-${group.label}`} className={styles.group}>
            {group.label}
          </h2>
          <ul className={styles.list}>
            {group.calls.map((call) => (
              <CallRow
                key={call.id}
                call={call}
                primaryLabel={canPlace ? 'Call again' : 'Open'}
                busy={placingId === call.id}
                onPrimary={() => (canPlace ? void callAgain(call) : setDetails(call))}
                onDetails={() => setDetails(call)}
              />
            ))}
          </ul>
        </section>
      ))}
      {hasNextPage && (
        <button type="button" className={styles.more} onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? 'Loading…' : 'Show older calls'}
        </button>
      )}
      <CallDetailsSheet call={details} onClose={() => setDetails(null)} canPlace={canPlace} onCall={(call) => void callAgain(call)} placing={placing} />
    </div>
  );
}

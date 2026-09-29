import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiGlobe, FiPhoneCall, FiPhoneIncoming, FiPhoneOutgoing, FiSettings, FiShield } from 'react-icons/fi';
import { Button, Skeleton } from '@/components/ui';
import { CallProgress } from '@/features/calling/CallProgress';
import { CallStatus } from '@/features/calling/CallStatus';
import { PhoneNumberField } from '@/features/calling/PhoneNumberField';
import { ProviderPill } from '@/features/calling/ProviderPill';
import { ROUTES } from '@/constants/routes';
import {
  callingService,
  chooseProvider,
  countryOfNumber,
  flagPrefix,
  formatInternational,
  PROVIDER_LABEL,
  COUNTRIES,
  type CallingCall,
  type CallingProvider,
} from '@/services/callingService';
import { plivoService, isCallActive } from '@/services/plivoService';
import { useAuthStore } from '@/stores/authStore';
import { extractErrorMessage } from '@/utils/errors';
import { ROW_IN, staggerChildren } from '../motion';
import { CustomerPicker, type SelectedCustomer } from './CustomerPicker';
import { LinkLineToMe } from './LinkLineToMe';
import styles from './PhoneCallCard.module.css';

const RECENT_LIMIT = 5;
// The call just placed stays pinned at the top (as a live tracker) this long.
const TRACK_FOR_MS = 30 * 60_000;
const COUNTRY_STORAGE_KEY = 'haive-call-country';

function readStoredCountry(fallbackDialCode: string): string {
  try {
    const stored = localStorage.getItem(COUNTRY_STORAGE_KEY);
    if (stored && COUNTRIES.some((c) => c.iso === stored)) return stored;
  } catch {
    // Storage can be blocked — fall back to the home country.
  }
  return COUNTRIES.find((c) => c.dialCode === fallbackDialCode)?.iso ?? 'IN';
}

function StateBlock({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={styles.state}>
      <span className={styles.stateIcon} aria-hidden>
        <FiPhoneCall />
      </span>
      <div className={styles.stateBody}>
        <div className={styles.stateTitle}>{title}</div>
        {children && <div className={styles.stateText}>{children}</div>}
        {actions}
      </div>
    </div>
  );
}

// Place a real phone call from Call Copilot, to any country. HaiVE rings the
// agent's own phone first; when they answer it dials the customer and records
// the conversation, which then lands in Call Library with a transcript, summary
// and AI Coach report. Indian numbers go out through Plivo, international ones
// through Twilio — the route is shown before the call, and can be changed.
export function PhoneCallCard({ onOpenLibrary }: { onOpenLibrary: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const [customer, setCustomer] = useState<SelectedCustomer | null>(null);
  const [number, setNumber] = useState('');
  const [fieldKey, setFieldKey] = useState(0);
  const [override, setOverride] = useState<CallingProvider | null>(null);
  const [calling, setCalling] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [trackedId, setTrackedId] = useState<string | null>(null);

  const { data: overview } = useQuery({
    queryKey: ['calling', 'overview'],
    queryFn: callingService.getOverview,
    staleTime: 30_000,
  });
  const { data: calls } = useQuery({
    queryKey: ['calling', 'calls', 'mine'],
    queryFn: () => callingService.listCalls('mine'),
    enabled:
      overview?.canCall === true ||
      overview?.providers.plivo.connected === true ||
      overview?.providers.twilio.connected === true,
    refetchInterval: (query) => (query.state.data?.some(isCallActive) ? 4_000 : false),
  });
  // Only needed for the "link a Plivo number to yourself" shortcut.
  const needsPlivoShortcut =
    !!overview && !overview.canCall && overview.canManage && overview.providers.plivo.connected;
  const { data: plivoConfig } = useQuery({
    queryKey: ['plivo', 'config'],
    queryFn: plivoService.getConfig,
    enabled: needsPlivoShortcut,
    staleTime: 30_000,
  });

  const available = useMemo<CallingProvider[]>(
    () => (overview ? (['plivo', 'twilio'] as const).filter((p) => overview.providers[p].ready) : []),
    [overview],
  );
  const route =
    overview && number ? chooseProvider(number, available, overview.domesticCountryCode, override ?? undefined) : null;
  const autoRoute = overview && number ? chooseProvider(number, available, overview.domesticCountryCode) : null;
  const international = !!overview && !!number && !number.startsWith(overview.domesticCountryCode);

  if (!overview) {
    return (
      <div className={styles.loading} aria-busy>
        <Skeleton height={20} width="40%" />
        <Skeleton height={44} />
        <Skeleton height={44} />
      </div>
    );
  }

  const anyConnected = overview.providers.plivo.connected || overview.providers.twilio.connected;
  if (!anyConnected) {
    return (
      <StateBlock
        title="Phone calls aren't set up yet"
        actions={
          overview.canManage ? (
            <div className={styles.stateActions}>
              <Button
                type="button"
                variant="secondary"
                leftIcon={<FiSettings />}
                onClick={() => navigate(ROUTES.settingsCalling)}
              >
                Set up calling
              </Button>
            </div>
          ) : undefined
        }
      >
        {overview.canManage
          ? 'Connect Plivo (Indian numbers) or Twilio (international numbers) to place and receive calls here. Every call is recorded, then transcribed, summarized and coached automatically.'
          : 'An administrator needs to connect a phone provider in Settings → Calling before you can place calls from here.'}
      </StateBlock>
    );
  }

  if (!overview.canCall) {
    return (
      <div className={styles.stack}>
        <StateBlock
          title="No phone line is linked to you yet"
          actions={
            overview.canManage ? (
              <div className={styles.stateActions}>
                <Button
                  type="button"
                  variant="secondary"
                  leftIcon={<FiSettings />}
                  onClick={() => navigate(ROUTES.settingsCalling)}
                >
                  Open calling settings
                </Button>
              </div>
            ) : undefined
          }
        >
          {overview.canManage
            ? 'A call goes out over a Plivo or Twilio number linked to you, and rings your own phone first. Link a number to yourself in Settings → Calling.'
            : 'Calling is set up, but no number is linked to you yet. Ask an administrator to link a Plivo or Twilio number to you.'}
        </StateBlock>
        {needsPlivoShortcut && user && plivoConfig && plivoConfig.lines.length > 0 && (
          <LinkLineToMe
            lines={plivoConfig.lines}
            userId={user.id}
            defaultCountryCode={plivoConfig.defaultCountryCode}
            onOpenSettings={() => navigate(ROUTES.settingsCalling)}
          />
        )}
      </div>
    );
  }

  const routeLine = route ? overview.providers[route].line : null;
  const destination = number ? countryOfNumber(number) : null;

  const handleCall = async () => {
    if (!number || !route) return;
    setCalling(true);
    try {
      const call = await callingService.startCall(`+${number}`, {
        dealId: customer?.dealId,
        provider: override ?? undefined,
      });
      setTrackedId(call.id);
      toast.success(
        routeLine
          ? `Calling your phone (${formatInternational(routeLine.agentPhone)}). Answer it and you'll be connected.`
          : "Calling your phone. Answer it and you'll be connected.",
        { duration: 6_000 },
      );
      setNumber('');
      setOverride(null);
      setFieldKey((k) => k + 1);
      await queryClient.invalidateQueries({ queryKey: ['calling', 'calls'] });
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setCalling(false);
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

  const all = calls ?? [];
  // The call to follow live: the one just placed, or failing that the newest
  // outbound call that is still happening.
  const tracked =
    all.find((c) => c.id === trackedId) ??
    (trackedId === null
      ? all.find((c) => isCallActive(c) && Date.now() - new Date(c.createdAt).getTime() < TRACK_FOR_MS)
      : undefined);
  const recent = all.filter((c) => c.id !== tracked?.id).slice(0, RECENT_LIMIT);

  return (
    <div className={recent.length > 0 ? styles.split : styles.single}>
      <div className={styles.main}>
        <AnimatePresence initial={false}>
          {tracked && (
            <CallProgress
              key={tracked.id}
              call={tracked}
              onOpenLibrary={onOpenLibrary}
              onDismiss={() => setTrackedId('')}
            />
          )}
        </AnimatePresence>

        <p className={styles.lead}>
          HaiVE rings your phone first — answer it and you&apos;re connected to the customer. The call is recorded, and
          its summary and AI Coach report appear in Call Library once it ends.
        </p>

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void handleCall();
          }}
        >
          <PhoneNumberField
            key={fieldKey}
            label="Customer's phone number"
            defaultCountry={readStoredCountry(overview.domesticCountryCode)}
            disabled={calling}
            hint="Pick the country, or paste a full number starting with + and the country is picked for you."
            onChange={(digits, country) => {
              setNumber(digits);
              try {
                localStorage.setItem(COUNTRY_STORAGE_KEY, country.iso);
              } catch {
                // Non-fatal.
              }
            }}
          />

          <AnimatePresence initial={false}>
            {number && (
              <motion.div
                key="route"
                className={styles.route}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22 }}
              >
                <div className={styles.routeInner}>
                  <span className={styles.routeIcon} aria-hidden>
                    {international ? <FiGlobe /> : <FiPhoneCall />}
                  </span>
                  <div className={styles.routeBody}>
                    {route && routeLine ? (
                      <>
                        <span className={styles.routeTitle}>
                          {international ? 'International call' : 'Domestic call'} · goes out via{' '}
                          {PROVIDER_LABEL[route]}
                        </span>
                        <span className={styles.routeMeta}>
                          Customer sees {formatInternational(routeLine.businessNumber)} · your phone{' '}
                          {formatInternational(routeLine.agentPhone)} rings first
                        </span>
                      </>
                    ) : (
                      <span className={styles.routeTitle}>No line available for this route.</span>
                    )}
                    {route === 'plivo' && international && !available.includes('twilio') && (
                      <span className={styles.routeWarn}>
                        International calls from an Indian number may be restricted. Link a Twilio number for reliable
                        international calling.
                      </span>
                    )}
                  </div>
                  {available.length > 1 && (
                    <div className={styles.routeSwitch} role="radiogroup" aria-label="Route">
                      {available.map((p) => {
                        const selected = (override ?? autoRoute) === p;
                        return (
                          <button
                            key={p}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={clsx(styles.routeOption, selected && styles.routeOptionOn)}
                            onClick={() => setOverride(p === autoRoute ? null : p)}
                          >
                            {PROVIDER_LABEL[p]}
                            {p === autoRoute && <span className={styles.recommended}>Best</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <span className={styles.consent}>
                  <FiShield aria-hidden /> Let the customer know the call is recorded where the law requires it.
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          <CustomerPicker value={customer} onChange={setCustomer} disabled={calling} />
          <div className={styles.actions}>
            <Button type="submit" size="lg" leftIcon={<FiPhoneCall />} loading={calling} disabled={!number || !route}>
              {number && destination
                ? `Call ${flagPrefix(destination.iso)}${formatInternational(number)}`
                : 'Call customer'}
            </Button>
          </div>
        </form>
      </div>

      {recent.length > 0 && (
        <div className={styles.recent}>
          <div className={styles.recentTitle}>Recent calls</div>
          <motion.ul className={styles.callList} variants={staggerChildren(0.05)} initial="hidden" animate="show">
            {recent.map((call) => {
              const country = countryOfNumber(call.customerNumber);
              return (
                <motion.li key={`${call.provider}-${call.id}`} className={styles.callItem} variants={ROW_IN}>
                  <span className={styles.callAvatar} aria-hidden>
                    {call.direction === 'outbound' ? <FiPhoneOutgoing /> : <FiPhoneIncoming />}
                  </span>
                  <div className={styles.callBody}>
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
                      </span>
                    </div>
                    <CallStatus
                      call={call}
                      onRetry={(c) => void handleRetry(c)}
                      retrying={retrying === call.id}
                      onOpenLibrary={onOpenLibrary}
                    />
                  </div>
                </motion.li>
              );
            })}
          </motion.ul>
        </div>
      )}
    </div>
  );
}

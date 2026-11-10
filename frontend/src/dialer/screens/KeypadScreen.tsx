import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Flag } from '@/features/calling/Flag';
import { callingService, chooseProvider, type CallingProvider, type Country } from '@/services/callingService';
import { FiChevronDown, FiClipboard, FiDelete, FiLock, FiPhone, FiX } from '../components/icons';
import { CountrySheet } from '../components/CountrySheet';
import { ReadinessCard, type NotReady } from '../components/ReadinessCard';
import { ActionButton, StateScreen } from '../components/StateScreen';
import { InstallCard } from '../layout/InstallBits';
import { useDialerAccess } from '../lib/access';
import { cleanEntry, countryOfEntry, dialableProblem, entryFromPaste, entryHint, formatEntry, formatNumber, numberToCall, startingCountry } from '../lib/dialRules';
import { haptic } from '../lib/haptics';
import { usePlaceCall } from '../lib/placeCall';
import { useLongPress } from '../lib/useLongPress';
import styles from './KeypadScreen.module.css';

// Shared with the Call Copilot page's call card: the country last called.
const COUNTRY_STORAGE_KEY = 'haive-call-country';
const MAX_ENTRY = 20;

const KEYS: [string, string, string][] = [
  ['1', '', '1'],
  ['2', 'ABC', '2'],
  ['3', 'DEF', '3'],
  ['4', 'GHI', '4'],
  ['5', 'JKL', '5'],
  ['6', 'MNO', '6'],
  ['7', 'PQRS', '7'],
  ['8', 'TUV', '8'],
  ['9', 'WXYZ', '9'],
  ['*', '', 'Star'],
  ['0', '+', '0. Hold for plus'],
  ['#', '', 'Pound'],
];

/** What Contacts and Recents hand over: a number to check before calling. */
export interface KeypadHandOff {
  number?: string;
  customerName?: string;
  dealId?: string;
}

function storedCountry(): string | null {
  try {
    return localStorage.getItem(COUNTRY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function Key({ value, letters, label, onPress, onLongPress }: { value: string; letters: string; label: string; onPress: () => void; onLongPress?: () => void }) {
  const press = useLongPress(onPress, onLongPress ?? onPress);
  return (
    <button type="button" className={styles.key} aria-label={label} {...press}>
      <span className={styles.digit} aria-hidden>
        {value}
      </span>
      <span className={styles.letters} aria-hidden>
        {letters}
      </span>
    </button>
  );
}

export function KeypadScreen() {
  const { canPlace } = useDialerAccess();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const handOff = (location.state ?? null) as KeypadHandOff | null;

  const overviewQuery = useQuery({
    queryKey: ['dialer', 'overview'],
    queryFn: () => callingService.getOverview(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const overview = overviewQuery.data;

  const [country, setCountry] = useState<Country>(() => startingCountry(storedCountry(), '91'));
  const [text, setText] = useState(() => (handOff?.number ? cleanEntry(handOff.number) : ''));
  const [linked, setLinked] = useState<{ name?: string; dealId?: string } | null>(() =>
    handOff?.customerName || handOff?.dealId ? { name: handOff.customerName, dealId: handOff.dealId } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [countryOpen, setCountryOpen] = useState(false);
  const [ignoreOffline, setIgnoreOffline] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const { place, placing } = usePlaceCall();

  // Before anything was ever called here, start on the business's own country.
  useEffect(() => {
    if (overview && !storedCountry()) setCountry(startingCountry(null, overview.domesticCountryCode));
  }, [overview]);

  const shownCountry = countryOfEntry(text, country);
  const digits = numberToCall(text, country);
  const hint = error ? { tone: 'error' as const, text: error } : entryHint(text, country);

  const ready = useMemo<CallingProvider[]>(() => (overview ? (['plivo', 'twilio'] as const).filter((p) => overview.providers[p].ready) : []), [overview]);
  const route = overview ? chooseProvider(digits ?? overview.domesticCountryCode, ready, overview.domesticCountryCode) : null;
  const line = overview && route ? overview.providers[route].line : null;

  let notReady: NotReady | null = null;
  if (!overview) notReady = overviewQuery.isError ? 'error' : null;
  else if (!overview.providers.plivo.connected && !overview.providers.twilio.connected) notReady = 'no_provider';
  else if (!overview.canCall) {
    const hasLine = (['plivo', 'twilio'] as const).some((p) => overview.providers[p].connected && overview.providers[p].line);
    notReady = hasLine ? 'not_configured' : 'no_line';
  } else if (!ignoreOffline && ready.every((p) => overview.providers[p].reachability === 'unreachable')) notReady = 'offline';

  const type = useCallback((key: string) => {
    haptic('key');
    setError(null);
    setText((current) => cleanEntry(current + key).slice(0, MAX_ENTRY));
  }, []);
  const backspace = useCallback(() => {
    haptic('key');
    setError(null);
    setText((current) => current.slice(0, -1));
  }, []);
  const clear = useCallback(() => {
    haptic('key');
    setError(null);
    setText('');
    setLinked(null);
  }, []);
  const paste = useCallback(
    (raw: string) => {
      const entry = entryFromPaste(raw, country);
      if (!entry) return setError('There’s no phone number on the clipboard.');
      setError(null);
      setText(entry.slice(0, MAX_ENTRY));
    },
    [country],
  );
  const pasteFromClipboard = async () => {
    try {
      paste(await navigator.clipboard.readText());
    } catch {
      setError('Couldn’t read the clipboard. Press and hold the number field, then Paste.');
    }
  };

  const call = async () => {
    if (!canPlace || placing) return;
    if (!digits) {
      haptic('error');
      return setError('Type a number first.');
    }
    const problem = /[*#]/.test(text) ? 'Phone numbers can’t include * or #.' : dialableProblem(digits);
    if (problem) {
      haptic('error');
      return setError(problem);
    }
    try {
      localStorage.setItem(COUNTRY_STORAGE_KEY, shownCountry.iso);
    } catch {
      // Storage blocked: the country is just not remembered.
    }
    const result = await place({ digits, customerName: linked?.name, dealId: linked?.dealId });
    if (result.ok || !result.message) return;
    setError(result.message);
    if (result.code === 'call_in_progress') {
      // Take them to the call that is already being set up.
      const calls = await callingService.listCalls().catch(() => []);
      const live = calls.find((c) => c.outcome && ['ringing_agent', 'connecting_customer', 'in_call'].includes(c.outcome.stage));
      if (live) navigate(`/call/${live.provider}/${live.id}`, { state: { call: live } });
    }
  };

  // A hardware keyboard (tablet, laptop): digits, Backspace, Escape to clear, Enter to call.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [role="dialog"]') || event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^[\d*#+]$/.test(event.key)) {
        event.preventDefault();
        type(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        backspace();
      } else if (event.key === 'Escape' || event.key === 'Delete') clear();
      // Enter on a focused key or button is that button's own press (keyboard and
      // switch users); only with nothing in particular focused does it mean "call".
      else if (event.key === 'Enter' && !target?.closest('button, a')) void call();
    };
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea')) return;
      paste(event.clipboardData?.getData('text') ?? '');
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('paste', onPaste);
    };
  });

  const recheck = async () => {
    setRechecking(true);
    try {
      queryClient.setQueryData(['dialer', 'overview'], await callingService.recheckOverview());
    } catch {
      await overviewQuery.refetch();
    } finally {
      setRechecking(false);
    }
  };

  // Someone who may see calls but not place them: say so, rather than a keypad that can't call.
  if (!canPlace) {
    return (
      <StateScreen
        icon={<FiLock />}
        title="You can see calls, not place them"
        actions={<ActionButton onClick={() => navigate('/recents')}>See your calls</ActionButton>}
      >
        <p>Placing calls isn’t part of your access. Your calls, their scores and reports are in Recents and Calls &amp; Scores.</p>
        <p>To place calls, ask an administrator to tick “Create” for Call Copilot on your account in Settings → Users.</p>
      </StateScreen>
    );
  }

  if (notReady) {
    return (
      <ReadinessCard
        reason={notReady}
        canManage={overview?.canManage ?? false}
        onRecheck={() => void recheck()}
        rechecking={rechecking}
        onTryAnyway={notReady === 'offline' ? () => setIgnoreOffline(true) : undefined}
      />
    );
  }

  const formatted = formatEntry(text, country);
  const size = formatted.length > 17 ? styles.numberSmall : formatted.length > 13 ? styles.numberMedium : '';

  return (
    <div className={styles.screen}>
      <h1 className="sr-only">Keypad</h1>
      <InstallCard />

      <div className={styles.line} aria-live="polite">
        {!overview ? (
          <span className={styles.lineMuted}>Checking your phone line…</span>
        ) : line ? (
          <>
            <span>
              Calls go out on <strong>{formatNumber(line.businessNumber)}</strong>
            </span>
            <span className={styles.lineMuted}>Your phone ({formatNumber(line.agentPhone)}) rings first, then we connect the customer.</span>
          </>
        ) : null}
      </div>

      <div className={styles.display}>
        {linked?.name && (
          <div className={styles.linked}>
            <span>
              Calling <strong>{linked.name}</strong>
            </span>
            <button type="button" className={styles.unlink} onClick={() => setLinked(null)} aria-label={`Don’t link this call to ${linked.name}`}>
              <FiX />
            </button>
          </div>
        )}
        <div className={styles.numberRow}>
          <button
            type="button"
            className={styles.country}
            onClick={() => setCountryOpen(true)}
            disabled={text.startsWith('+')}
            aria-label={`Country: ${shownCountry.name}, plus ${shownCountry.dialCode}.${text.startsWith('+') ? ' Set by the number.' : ' Change country.'}`}
          >
            <Flag iso={shownCountry.iso} size="sm" />
            <span>+{shownCountry.dialCode}</span>
            {!text.startsWith('+') && <FiChevronDown />}
          </button>
          <input
            className={`${styles.number} ${size}`}
            type="tel"
            inputMode="none"
            autoComplete="off"
            aria-label="Phone number"
            aria-describedby="keypad-hint"
            aria-invalid={hint?.tone === 'error' || undefined}
            placeholder="Enter a number"
            value={formatted}
            onChange={(event) => {
              setError(null);
              setText(cleanEntry(event.target.value).slice(0, MAX_ENTRY));
            }}
            onPaste={(event) => {
              event.preventDefault();
              paste(event.clipboardData.getData('text'));
            }}
          />
        </div>
        <p id="keypad-hint" className={`${styles.hint} ${hint?.tone === 'error' ? styles.hintError : ''}`} role="status">
          {hint?.text ?? ' '}
        </p>
      </div>

      <div className={styles.keys} role="group" aria-label="Keypad">
        {KEYS.map(([value, letters, label]) => (
          <Key
            key={value}
            value={value}
            letters={letters}
            label={label}
            onPress={() => type(value)}
            onLongPress={value === '0' ? () => (text === '' ? type('+') : type('0')) : undefined}
          />
        ))}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.side} onClick={() => void pasteFromClipboard()} aria-label="Paste a number">
          <FiClipboard />
        </button>
        <button
          type="button"
          className={styles.call}
          onClick={() => void call()}
          disabled={!canPlace || placing}
          aria-busy={placing || undefined}
          aria-label={placing ? 'Calling…' : digits ? `Call ${formatted}` : 'Call'}
        >
          <FiPhone />
        </button>
        <BackspaceButton visible={text.length > 0} onPress={backspace} onLongPress={clear} />
      </div>

      <CountrySheet open={countryOpen} onClose={() => setCountryOpen(false)} selected={country} onSelect={setCountry} />
    </div>
  );
}

function BackspaceButton({ visible, onPress, onLongPress }: { visible: boolean; onPress: () => void; onLongPress: () => void }) {
  const press = useLongPress(onPress, onLongPress);
  return (
    <button
      type="button"
      className={styles.side}
      aria-label="Delete. Hold to clear"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
      tabIndex={visible ? 0 : -1}
      {...press}
    >
      <FiDelete />
    </button>
  );
}

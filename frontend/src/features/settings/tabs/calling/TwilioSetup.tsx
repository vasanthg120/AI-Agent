import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiAlertCircle,
  FiCheckCircle,
  FiChevronDown,
  FiGlobe,
  FiHash,
  FiLink,
  FiRefreshCw,
  FiTrash2,
  FiUserPlus,
} from 'react-icons/fi';
import { Badge, Button, CopyableText, Input, Skeleton, Switch } from '@/components/ui';
import { PhoneNumberField } from '@/features/calling/PhoneNumberField';
import { Flag } from '@/features/calling/Flag';
import { countryOfNumber, formatInternational } from '@/services/callingService';
import { twilioService, isTrialAccount, type TwilioLine, type TwilioNumber } from '@/services/twilioService';
import { usersService } from '@/services/usersService';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { extractErrorMessage } from '@/utils/errors';
import { SettingsSection } from '../../components/SettingsSection';
import styles from './TwilioSetup.module.css';

const SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const TOKEN_PATTERN = /^[0-9a-fA-F]{32}$/;

interface AssignDraft {
  userId: string;
  agentPhone: string;
  languageCode: string;
  announceRecording: boolean;
}

const EMPTY_DRAFT: AssignDraft = { userId: '', agentPhone: '', languageCode: 'en', announceRecording: true };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Settings -> Calling -> Twilio (international numbers). Unlike Plivo there is
// no console step: once the account is connected HaiVE lists its numbers and,
// when one is assigned to a person, points that number's calls at itself.
export function TwilioSetup() {
  const queryClient = useQueryClient();
  const {
    data: config,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['twilio', 'config'],
    queryFn: twilioService.getConfig,
  });
  const connected = config?.connected === true;
  const {
    data: numbers,
    isFetching: loadingNumbers,
    error: numbersError,
    refetch: refetchNumbers,
  } = useQuery({
    queryKey: ['twilio', 'numbers'],
    queryFn: twilioService.listNumbers,
    enabled: connected,
    retry: false,
  });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: usersService.list, enabled: connected });

  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [openNumber, setOpenNumber] = useState<string | null>(null);
  const [draft, setDraft] = useState<AssignDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [showUrls, setShowUrls] = useState(false);

  const refreshAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['twilio'] }),
      queryClient.invalidateQueries({ queryKey: ['calling'] }),
    ]);

  const sidValid = SID_PATTERN.test(accountSid.trim());
  const tokenValid = TOKEN_PATTERN.test(authToken.trim());

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await twilioService.connect(accountSid.trim(), authToken.trim());
      setAccountSid('');
      setAuthToken('');
      toast.success('Twilio connected');
      await refreshAll();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Twilio? International calls will stop until it is connected again.')) return;
    try {
      await twilioService.disconnect();
      toast.success('Twilio disconnected');
      await refreshAll();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const run = async (key: string, action: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await action();
      toast.success(message);
      await refreshAll();
      return true;
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const openAssign = (n: TwilioNumber) => {
    setDraft(EMPTY_DRAFT);
    setOpenNumber((current) => (current === n.sid ? null : n.sid));
  };

  const handleAssign = async (n: TwilioNumber) => {
    const ok = await run(
      `assign-${n.sid}`,
      () => twilioService.saveLine({ twilioNumber: n.number, ...draft }),
      `${formatInternational(n.number)} is ready — it now rings ${users?.find((u) => u.id === draft.userId)?.name ?? 'them'}.`,
    );
    if (ok) setOpenNumber(null);
  };

  const saveLine = (
    line: TwilioLine,
    patch: Partial<Pick<TwilioLine, 'active' | 'announceRecording'>>,
    message: string,
  ) =>
    run(
      `line-${line.id}`,
      () =>
        twilioService.saveLine({
          twilioNumber: line.twilioNumber,
          userId: line.userId,
          agentPhone: line.agentPhone,
          languageCode: line.languageCode,
          announceRecording: patch.announceRecording ?? line.announceRecording,
          active: patch.active ?? line.active,
        }),
      message,
    );

  const handleRemove = (line: TwilioLine) => {
    if (
      !window.confirm(
        `Stop using ${formatInternational(line.twilioNumber)} in HaiVE? Its calls will no longer be recorded here.`,
      )
    )
      return;
    void run(`line-${line.id}`, () => twilioService.deleteLine(line.id), 'Number removed from HaiVE');
  };

  if (isLoading) {
    return (
      <SettingsSection icon={<FiGlobe />} title="Twilio" description="International numbers.">
        <Skeleton height={64} />
        <Skeleton height={64} />
      </SettingsSection>
    );
  }
  if (isError || !config) {
    return (
      <SettingsSection icon={<FiGlobe />} title="Twilio" description="International numbers.">
        <div className={styles.errorState} role="alert">
          <span>Couldn't load Twilio settings. {extractErrorMessage(error)}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      </SettingsSection>
    );
  }

  const trial = isTrialAccount(config);
  const lineByNumber = new Map(config.lines.map((l) => [l.twilioNumber, l]));
  const orphanLines = numbers ? config.lines.filter((l) => !numbers.some((n) => n.number === l.twilioNumber)) : [];

  return (
    <>
      <SettingsSection
        icon={<FiLink />}
        title="1. Connect Twilio"
        description="Twilio carries your international calls and records them. Copy the Account SID and Auth Token from the Account Info box on the Twilio console home page."
      >
        {connected ? (
          <div className={styles.stack}>
            <div className={styles.connectedRow}>
              <span className={styles.connectedLabel}>
                <FiCheckCircle aria-hidden /> Connected
                {config.account?.friendlyName ? (
                  <>
                    {' '}
                    to <strong>{config.account.friendlyName}</strong>
                  </>
                ) : null}{' '}
                <code>{config.accountSidMasked}</code>
                {config.account?.type && (
                  <Badge variant={trial ? 'warning' : 'success'}>{trial ? 'Trial account' : 'Full account'}</Badge>
                )}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleDisconnect()}>
                Disconnect
              </Button>
            </div>
            {trial && (
              <div className={styles.warning} role="status">
                <FiAlertCircle aria-hidden />
                <div>
                  <strong>Trial accounts can only call verified numbers.</strong>
                  <p>
                    Add each phone you want to call — including the agents' own phones — under{' '}
                    <strong>Phone Numbers → Verified Caller IDs</strong> in the Twilio console, or upgrade the account
                    to call anyone. Trial calls also begin with a short Twilio message.
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void handleConnect();
            }}
          >
            <div className={styles.fieldGrid}>
              <Input
                label="Account SID"
                value={accountSid}
                onChange={(e) => setAccountSid(e.target.value)}
                placeholder="AC followed by 32 letters and digits"
                autoComplete="off"
                error={accountSid.trim() && !sidValid ? 'Starts with "AC", 34 characters in total.' : undefined}
              />
              <Input
                label="Auth Token"
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="32 letters and digits"
                autoComplete="new-password"
                error={authToken.trim() && !tokenValid ? 'The Auth Token is 32 letters and digits.' : undefined}
              />
            </div>
            <div className={styles.actions}>
              <Button type="submit" loading={connecting} disabled={!sidValid || !tokenValid}>
                Connect Twilio
              </Button>
            </div>
            <p className={styles.hint}>
              HaiVE checks the pair with Twilio before saving it, then stores the token encrypted — it is never shown
              again.
            </p>
          </form>
        )}
      </SettingsSection>

      {connected && (
        <SettingsSection
          icon={<FiGlobe />}
          title="2. Let Twilio reach HaiVE"
          description="Twilio tells HaiVE when a call is answered and when its recording is ready."
        >
          {!config.publicUrlConfigured || !config.webhookUrls ? (
            <div className={styles.warning} role="status">
              <FiAlertCircle aria-hidden />
              <div>
                <strong>This server has no public address yet.</strong>
                <p>
                  Set <code>TWILIO_PUBLIC_BASE_URL</code> (or <code>CALLING_PUBLIC_BASE_URL</code> for both providers)
                  in <code>backend/.env</code> to the address Twilio can reach — your API domain in production, or an{' '}
                  <code>ngrok http 3000</code> address while testing. If Plivo is already set up with{' '}
                  <code>PLIVO_PUBLIC_BASE_URL</code>, Twilio uses that same address. Restart the backend afterwards.
                </p>
              </div>
            </div>
          ) : (
            <div className={styles.stack}>
              <div className={styles.success}>
                <FiCheckCircle aria-hidden />
                <span>
                  Reachable at <code>{hostOf(config.webhookUrls.voice)}</code>. Nothing to set up in the Twilio console
                  — HaiVE points each number you assign below at itself.
                </span>
              </div>
              <button
                type="button"
                className={styles.disclosure}
                aria-expanded={showUrls}
                onClick={() => setShowUrls((v) => !v)}
              >
                <FiChevronDown className={clsx(styles.chevron, showUrls && styles.chevronOpen)} aria-hidden /> Show
                webhook addresses
              </button>
              <AnimatePresence initial={false}>
                {showUrls && (
                  <motion.div
                    className={styles.urls}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className={styles.urlBlock}>
                      <span className={styles.urlLabel}>A call comes in (Voice URL, POST)</span>
                      <CopyableText value={config.webhookUrls.voice} />
                    </div>
                    <div className={styles.urlBlock}>
                      <span className={styles.urlLabel}>Call status changes (Status callback, POST)</span>
                      <CopyableText value={config.webhookUrls.status} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </SettingsSection>
      )}

      {connected && (
        <SettingsSection
          icon={<FiHash />}
          title="3. Assign your Twilio numbers"
          description="Each number rings one person's own phone. Customers who call it reach that person, and when that person calls an international customer from HaiVE, the customer sees this number."
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leftIcon={<FiRefreshCw />}
              loading={loadingNumbers}
              onClick={() => void refetchNumbers()}
            >
              Refresh
            </Button>
          }
        >
          {numbersError ? (
            <div className={styles.errorState} role="alert">
              <span>{extractErrorMessage(numbersError)}</span>
            </div>
          ) : !numbers ? (
            <Skeleton height={120} />
          ) : numbers.length === 0 ? (
            <div className={styles.empty}>
              <strong>No numbers on this Twilio account yet.</strong>
              <span>
                Buy one in the Twilio console (<strong>Phone Numbers → Buy a number</strong>) in the country your
                customers are in, then press Refresh.
              </span>
            </div>
          ) : (
            <ul className={styles.numbers}>
              {numbers.map((n) => {
                const line = lineByNumber.get(n.number);
                const country = countryOfNumber(n.number);
                const open = openNumber === n.sid;
                const pointsElsewhere = !!n.voiceUrl && !n.pointsToHaive;
                return (
                  <li key={n.sid} className={clsx(styles.number, line?.active && styles.numberLive)}>
                    <div className={styles.numberRow}>
                      <span className={styles.flag} aria-hidden>
                        {country ? <Flag iso={country.iso} size="lg" /> : '🌐'}
                      </span>
                      <div className={styles.numberMain}>
                        <span className={styles.numberValue}>{formatInternational(n.number)}</span>
                        <span className={styles.numberMeta}>
                          {n.friendlyName !== `+${n.number}` ? `${n.friendlyName} · ` : ''}
                          {country?.name ?? 'International'}
                        </span>
                      </div>

                      {!n.voiceCapable ? (
                        <Badge variant="neutral">No voice</Badge>
                      ) : line ? (
                        <div className={styles.lineControls}>
                          <span className={styles.ringsWho}>
                            Rings <strong>{line.userName}</strong> · {formatInternational(line.agentPhone)}
                          </span>
                          {line.active && !n.pointsToHaive ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              loading={busy === `fix-${n.sid}`}
                              onClick={() =>
                                void run(
                                  `fix-${n.sid}`,
                                  () => twilioService.configureNumber(n.sid),
                                  'Number points to HaiVE again',
                                )
                              }
                            >
                              Reconnect to HaiVE
                            </Button>
                          ) : null}
                          <Switch
                            checked={line.active}
                            onChange={(checked) =>
                              void saveLine(
                                line,
                                { active: checked },
                                checked ? 'Number turned on' : 'Number turned off',
                              )
                            }
                            ariaLabel={`${formatInternational(n.number)} on`}
                          />
                          <button
                            type="button"
                            className={styles.iconButton}
                            aria-label={`Stop using ${formatInternational(n.number)}`}
                            onClick={() => handleRemove(line)}
                          >
                            <FiTrash2 />
                          </button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant={open ? 'ghost' : 'secondary'}
                          leftIcon={<FiUserPlus />}
                          onClick={() => openAssign(n)}
                        >
                          {open ? 'Cancel' : 'Assign to a person'}
                        </Button>
                      )}
                    </div>

                    {line && (
                      <div className={styles.lineFooter}>
                        {line.active ? (
                          n.pointsToHaive ? (
                            <Badge variant="success" dot>
                              Live in HaiVE
                            </Badge>
                          ) : (
                            <Badge variant="warning" dot>
                              Calls go to {n.voiceUrl ? hostOf(n.voiceUrl) : 'nowhere'} — not recorded
                            </Badge>
                          )
                        ) : (
                          <Badge variant="neutral">Off</Badge>
                        )}
                        <label className={styles.inlineToggle}>
                          <Switch
                            checked={line.announceRecording}
                            onChange={(checked) =>
                              void saveLine(
                                line,
                                { announceRecording: checked },
                                checked ? 'Recording notice on' : 'Recording notice off',
                              )
                            }
                            ariaLabel="Tell callers the call is recorded"
                          />
                          Tell customers the call is recorded
                        </label>
                      </div>
                    )}

                    <AnimatePresence initial={false}>
                      {open && !line && (
                        <motion.form
                          className={styles.assign}
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.22 }}
                          onSubmit={(e) => {
                            e.preventDefault();
                            void handleAssign(n);
                          }}
                        >
                          <div className={styles.assignInner}>
                            {pointsElsewhere && (
                              <p className={styles.note}>
                                <FiAlertCircle aria-hidden /> Calls to this number currently go to{' '}
                                <code>{hostOf(n.voiceUrl)}</code>. Assigning it sends them to HaiVE instead.
                              </p>
                            )}
                            <div className={styles.fieldGrid}>
                              <div className={styles.selectField}>
                                <label htmlFor={`tw-user-${n.sid}`}>Person who takes the calls</label>
                                <select
                                  id={`tw-user-${n.sid}`}
                                  className={styles.select}
                                  value={draft.userId}
                                  onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
                                >
                                  <option value="">Choose a person…</option>
                                  {(users ?? [])
                                    .filter((u) => u.active)
                                    .map((u) => (
                                      <option key={u.id} value={u.id}>
                                        {u.name}
                                      </option>
                                    ))}
                                </select>
                              </div>
                              <PhoneNumberField
                                label="Their own phone"
                                defaultCountry={country?.iso ?? 'IN'}
                                hint="The phone Twilio rings for every call on this number."
                                onChange={(digits) =>
                                  setDraft((d) => ({ ...d, agentPhone: digits ? `+${digits}` : '' }))
                                }
                              />
                              <div className={styles.selectField}>
                                <label htmlFor={`tw-lang-${n.sid}`}>Language of the calls</label>
                                <select
                                  id={`tw-lang-${n.sid}`}
                                  className={styles.select}
                                  value={draft.languageCode}
                                  onChange={(e) => setDraft({ ...draft, languageCode: e.target.value })}
                                >
                                  {VOICE_LANGUAGES.map((l) => (
                                    <option key={l.code} value={l.code}>
                                      {l.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                            <label className={styles.inlineToggle}>
                              <Switch
                                checked={draft.announceRecording}
                                onChange={(checked) => setDraft({ ...draft, announceRecording: checked })}
                                ariaLabel="Tell customers the call is recorded"
                              />
                              Tell customers the call is recorded (recommended — required in many countries)
                            </label>
                            <div className={styles.actions}>
                              <Button
                                type="submit"
                                loading={busy === `assign-${n.sid}`}
                                disabled={!draft.userId || !draft.agentPhone}
                              >
                                Assign and go live
                              </Button>
                            </div>
                          </div>
                        </motion.form>
                      )}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ul>
          )}

          {orphanLines.length > 0 && (
            <div className={styles.orphans}>
              <strong>No longer on this Twilio account</strong>
              {orphanLines.map((line) => (
                <div key={line.id} className={styles.orphan}>
                  <span>
                    {formatInternational(line.twilioNumber)} · {line.userName}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    leftIcon={<FiTrash2 />}
                    onClick={() => handleRemove(line)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      )}

      {!connected && (
        <p className={styles.hint}>Once Twilio is connected, your Twilio numbers appear here, ready to assign.</p>
      )}
    </>
  );
}

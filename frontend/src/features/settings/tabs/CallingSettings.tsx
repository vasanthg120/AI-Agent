import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiAlertCircle, FiCheckCircle, FiGlobe, FiLink, FiPhone, FiPhoneCall, FiTrash2 } from 'react-icons/fi';
import { Badge, Button, CopyableText, Input, Skeleton, Switch } from '@/components/ui';
import { CallStatus } from '@/features/calling/CallStatus';
import {
  plivoService,
  formatDuration,
  formatPhone,
  isCallActive,
  type PlivoCall,
  type PlivoConfig,
  type PlivoLine,
} from '@/services/plivoService';
import { usersService } from '@/services/usersService';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { extractErrorMessage } from '@/utils/errors';
import { SettingsSection } from '../components/SettingsSection';
import styles from './CallingSettings.module.css';

const EMPTY_LINE = { plivoNumber: '', userId: '', agentPhone: '', languageCode: 'en' };

// Settings -> Calling. Phone calls placed or received through Plivo are recorded
// and land in Call Library with a transcript, summary and AI Coach report. The
// steps below are in the order they have to happen: Plivo can't be told where to
// send a recording until this server is reachable, and a number can't ring anyone
// until it is linked to a person and their phone.
export function CallingSettings() {
  const queryClient = useQueryClient();
  const {
    data: config,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({ queryKey: ['plivo', 'config'], queryFn: plivoService.getConfig });
  const connected = config?.connected === true;

  const { data: calls } = useQuery({
    queryKey: ['plivo', 'calls', 'org'],
    queryFn: () => plivoService.listCalls('org'),
    enabled: connected,
    refetchInterval: (query) => (query.state.data?.some(isCallActive) ? 8_000 : false),
  });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: usersService.list, enabled: connected });

  const [authId, setAuthId] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [line, setLine] = useState(EMPTY_LINE);
  const [savingLine, setSavingLine] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  const refreshConfig = () => queryClient.invalidateQueries({ queryKey: ['plivo', 'config'] });
  // The API answers a line change with the whole updated list — show it at once
  // rather than waiting for a refetch, so a switch flips the moment it is saved.
  const applyLines = (lines: PlivoLine[]) => {
    queryClient.setQueryData<PlivoConfig>(['plivo', 'config'], (old) => old && { ...old, lines });
    return refreshConfig(); // still confirm with the server (e.g. whether this person can now call)
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await plivoService.connect(authId.trim(), authToken.trim());
      setAuthId('');
      setAuthToken('');
      toast.success('Plivo connected');
      await refreshConfig();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Plivo? Calls will stop being recorded until it is connected again.')) return;
    try {
      await plivoService.disconnect();
      toast.success('Plivo disconnected');
      await refreshConfig();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const saveLine = async (payload: Parameters<typeof plivoService.saveLine>[0], message: string) => {
    const lines = await plivoService.saveLine(payload);
    toast.success(message);
    await applyLines(lines);
  };

  const handleAddLine = async () => {
    setSavingLine(true);
    try {
      await saveLine(line, 'Line saved');
      setLine(EMPTY_LINE);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSavingLine(false);
    }
  };

  const handleToggleLine = async (l: PlivoLine, active: boolean) => {
    try {
      await saveLine(
        {
          plivoNumber: l.plivoNumber,
          userId: l.userId,
          agentPhone: l.agentPhone,
          languageCode: l.languageCode,
          active,
        },
        active ? 'Line turned on' : 'Line turned off',
      );
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const handleDeleteLine = async (l: PlivoLine) => {
    if (
      !window.confirm(
        `Remove ${formatPhone(l.plivoNumber)}? Calls to this number will no longer be forwarded or recorded.`,
      )
    )
      return;
    try {
      const lines = await plivoService.deleteLine(l.id);
      toast.success('Line removed');
      await applyLines(lines);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const handleRetry = async (call: PlivoCall) => {
    setRetrying(call.id);
    try {
      await plivoService.retryImport(call.id);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setRetrying(null);
      await queryClient.invalidateQueries({ queryKey: ['plivo', 'calls'] });
    }
  };

  if (isLoading) {
    return (
      <SettingsSection icon={<FiPhoneCall />}
        icon={<FiPhoneCall />}
        title="Calling"
        description="Record phone calls and get a summary and AI coaching for each one."
      >
        <Skeleton height={64} />
        <Skeleton height={64} />
      </SettingsSection>
    );
  }
  if (isError || !config) {
    return (
      <SettingsSection icon={<FiPhoneCall />}
        icon={<FiPhoneCall />}
        title="Calling"
        description="Record phone calls and get a summary and AI coaching for each one."
      >
        <div className={styles.errorState} role="alert">
          <span>Couldn't load calling settings. {extractErrorMessage(error)}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      </SettingsSection>
    );
  }

  return (
    <div className={styles.page}>
      <SettingsSection icon={<FiLink />}
        title="1. Connect Plivo"
        description="Calls go through your Plivo account, which is what lets HaiVE record them. Copy the Auth ID and Auth Token from the top of the Plivo console overview page."
      >
        {connected ? (
          <div className={styles.connectedRow}>
            <span className={styles.connectedLabel}>
              <FiCheckCircle aria-hidden /> Connected as <code>{config.authIdMasked}</code>
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void handleDisconnect()}>
              Disconnect
            </Button>
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
                label="Auth ID"
                value={authId}
                onChange={(e) => setAuthId(e.target.value)}
                placeholder="MAXXXXXXXXXXXXXXXXXX"
                autoComplete="off"
              />
              <Input
                label="Auth Token"
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="Auth Token"
                autoComplete="new-password"
              />
            </div>
            <div className={styles.actions}>
              <Button
                type="submit"
                loading={connecting}
                disabled={authId.trim().length < 6 || authToken.trim().length < 6}
              >
                Connect Plivo
              </Button>
            </div>
            <p className={styles.hint}>
              The token is checked with Plivo before it is saved, and stored encrypted — it is never shown again.
            </p>
          </form>
        )}
      </SettingsSection>

      {connected && (
        <SettingsSection icon={<FiGlobe />}
          title="2. Point Plivo at HaiVE"
          description="Plivo tells HaiVE when a call is answered and when its recording is ready, so it has to be able to reach this server over the internet."
        >
          {!config.publicUrlConfigured || !config.webhookUrls ? (
            <div className={styles.warning} role="status">
              <FiAlertCircle aria-hidden />
              <div>
                <strong>This server has no public address yet.</strong>
                <p>
                  Set <code>PLIVO_PUBLIC_BASE_URL</code> in <code>backend/.env</code> to the address Plivo can reach —
                  for example <code>https://api.yourcompany.com</code> in production. To try it on your own computer,
                  run <code>ngrok http 3000</code> (or <code>cloudflared tunnel --url http://localhost:3000</code>) and
                  use the https address it prints. Then restart the backend and reload this page.
                </p>
              </div>
            </div>
          ) : (
            <>
              <p className={styles.hint}>
                In the Plivo console go to <strong>Voice → Applications → XML → Add New Application</strong>. Use these
                two addresses (both method <strong>POST</strong>), then open <strong>Phone Numbers</strong>, choose your
                number and assign that application to it.
              </p>
              <div className={styles.urlBlock}>
                <span className={styles.urlLabel}>Answer URL</span>
                <CopyableText value={config.webhookUrls.answer} />
              </div>
              <div className={styles.urlBlock}>
                <span className={styles.urlLabel}>Hangup URL</span>
                <CopyableText value={config.webhookUrls.hangup} />
              </div>
            </>
          )}
        </SettingsSection>
      )}

      {connected && (
        <SettingsSection icon={<FiPhone />}
          title="3. Link each Plivo number to a person"
          description="When a customer calls the Plivo number it rings the person's own phone (for example their Airtel SIM), and the call is recorded. When that person places a call from HaiVE, Plivo rings this phone first, then dials the customer."
        >
          {config.lines.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Plivo number</th>
                    <th>Person</th>
                    <th>Their phone</th>
                    <th>Language</th>
                    <th>On</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {config.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{formatPhone(l.plivoNumber)}</td>
                      <td>{l.userName}</td>
                      <td>{formatPhone(l.agentPhone)}</td>
                      <td>{VOICE_LANGUAGES.find((v) => v.code === l.languageCode)?.label ?? l.languageCode}</td>
                      <td>
                        <Switch
                          checked={l.active}
                          onChange={(checked) => void handleToggleLine(l, checked)}
                          ariaLabel={`${formatPhone(l.plivoNumber)} active`}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={styles.iconButton}
                          aria-label={`Remove ${formatPhone(l.plivoNumber)}`}
                          onClick={() => void handleDeleteLine(l)}
                        >
                          <FiTrash2 />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={styles.hint}>No numbers linked yet. Add one below.</p>
          )}

          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void handleAddLine();
            }}
          >
            <div className={styles.fieldGrid}>
              <Input
                label="Plivo number"
                value={line.plivoNumber}
                onChange={(e) => setLine({ ...line, plivoNumber: e.target.value })}
                placeholder="91 80 1234 5678"
                hint="With country code."
              />
              <div className={styles.selectField}>
                <label htmlFor="calling-user">Person who takes the calls</label>
                <select
                  id="calling-user"
                  className={styles.select}
                  value={line.userId}
                  onChange={(e) => setLine({ ...line, userId: e.target.value })}
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
              <Input
                label="Their phone"
                value={line.agentPhone}
                onChange={(e) => setLine({ ...line, agentPhone: e.target.value })}
                placeholder="98765 43210"
                hint={`The phone that rings. +${config.defaultCountryCode} is assumed if you leave out the country code.`}
              />
              <div className={styles.selectField}>
                <label htmlFor="calling-language">Language of the calls</label>
                <select
                  id="calling-language"
                  className={styles.select}
                  value={line.languageCode}
                  onChange={(e) => setLine({ ...line, languageCode: e.target.value })}
                >
                  {VOICE_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className={styles.actions}>
              <Button
                type="submit"
                loading={savingLine}
                disabled={!line.plivoNumber.trim() || !line.userId || !line.agentPhone.trim()}
              >
                Save line
              </Button>
            </div>
          </form>
        </SettingsSection>
      )}

      {connected && (
        <SettingsSection icon={<FiPhoneCall />}
          title="Recent calls"
          description="Every call through your Plivo numbers, and where its recording is on its way to Call Library."
        >
          {!calls ? (
            <Skeleton height={96} />
          ) : calls.length === 0 ? (
            <p className={styles.hint}>No calls yet. Place one from Call Copilot, or call one of your Plivo numbers.</p>
          ) : (
            <ul className={styles.callList}>
              {calls.map((call) => (
                <li key={call.id} className={styles.callItem}>
                  <div className={styles.callMain}>
                    <span className={styles.callTitle}>
                      {call.direction === 'outbound' ? 'Called' : 'Received from'} {formatPhone(call.customerNumber)}
                    </span>
                    <span className={styles.callMeta}>
                      {new Date(call.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                      {formatDuration(call.durationSeconds) ? ` · ${formatDuration(call.durationSeconds)}` : ''}
                      {` · ${call.direction}`}
                    </span>
                  </div>
                  <CallStatus call={call} onRetry={(c) => void handleRetry(c)} retrying={retrying === call.id} />
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>
      )}

      {!connected && (
        <p className={styles.hint}>
          <Badge variant="neutral">Next</Badge> Once Plivo is connected you'll see how to point it at HaiVE and link
          your number to a person.
        </p>
      )}
    </div>
  );
}

import { FiAlertTriangle, FiRefreshCw, FiSettings, FiWifiOff } from './icons';
import { ActionButton, StateScreen } from './StateScreen';

export type NotReady = 'no_provider' | 'no_line' | 'not_configured' | 'offline' | 'error';

/**
 * Why calls can't be placed yet — what's missing, who can fix it, and (for
 * administrators) the way to Settings → Calling, which lives in HaiVE itself.
 */
export function ReadinessCard({
  reason,
  canManage,
  onRecheck,
  rechecking,
  onTryAnyway,
}: {
  reason: NotReady;
  canManage: boolean;
  onRecheck: () => void;
  rechecking: boolean;
  onTryAnyway?: () => void;
}) {
  const settings = canManage ? <ActionButton href="/settings/calling">{<FiSettings />} Open Settings → Calling</ActionButton> : null;
  const recheck = (
    <ActionButton variant={settings ? 'secondary' : 'primary'} onClick={onRecheck} busy={rechecking}>
      <FiRefreshCw /> {rechecking ? 'Checking…' : 'Check again'}
    </ActionButton>
  );

  switch (reason) {
    case 'no_provider':
      return (
        <StateScreen icon={<FiSettings />} title="Calling isn’t set up yet" actions={settings ?? recheck}>
          <p>
            {canManage
              ? 'Connect Plivo (Indian numbers) or Twilio (international numbers) in Settings → Calling. Every call is then recorded, transcribed, scored and summarised.'
              : 'An administrator needs to connect a phone provider (Plivo or Twilio) before anyone can place calls. Ask your HaiVE administrator.'}
          </p>
        </StateScreen>
      );
    case 'no_line':
      return (
        <StateScreen icon={<FiSettings />} title="No phone line is linked to you" actions={<>{settings}{recheck}</>}>
          <p>
            A call goes out on a business number linked to you and rings your own phone first.{' '}
            {canManage ? 'Link a number and your phone to yourself in Settings → Calling.' : 'Ask an administrator to link a number to you in Settings → Calling.'}
          </p>
        </StateScreen>
      );
    case 'not_configured':
      return (
        <StateScreen icon={<FiAlertTriangle />} tone="warning" title="Calling isn’t reachable yet" actions={<>{settings}{recheck}</>}>
          <p>The server has no public address for the phone system to reach it, so calls can’t connect.</p>
          <p>{canManage ? 'Set PLIVO_PUBLIC_BASE_URL (or TWILIO_PUBLIC_BASE_URL) on the server, then check again.' : 'Ask an administrator to finish setting up calling.'}</p>
        </StateScreen>
      );
    case 'offline':
      return (
        <StateScreen
          icon={<FiWifiOff />}
          tone="warning"
          title="Calling is offline right now"
          actions={
            <>
              {recheck}
              {onTryAnyway && (
                <ActionButton variant="secondary" onClick={onTryAnyway}>
                  Try anyway
                </ActionButton>
              )}
            </>
          }
        >
          <p>The phone system can’t reach HaiVE, so a call would drop a second after your phone answers.</p>
          <p>{canManage ? 'The calling connection (the server’s public address or tunnel) is down. Start it again, then check again.' : 'Ask an administrator to check calling.'}</p>
        </StateScreen>
      );
    case 'error':
      return (
        <StateScreen icon={<FiAlertTriangle />} tone="warning" title="Couldn’t check your phone line" actions={recheck}>
          <p>HaiVE didn’t answer. Check your connection and try again.</p>
        </StateScreen>
      );
  }
}

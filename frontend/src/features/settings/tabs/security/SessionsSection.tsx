import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiMonitor, FiSmartphone } from 'react-icons/fi';
import { Badge, Button, Modal, Skeleton } from '@/components/ui';
import { sessionsService, type Session } from '@/services/sessionsService';
import { extractErrorMessage } from '@/utils/errors';
import { SettingsSection } from '../../components/SettingsSection';
import sectionStyles from '../../components/SettingsSection.module.css';
import styles from '../SecuritySettings.module.css';

function isMobileDevice(device: string): boolean {
  return /android|ios|iphone|ipad/i.test(device);
}

export function SessionsSection() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [revokingJti, setRevokingJti] = useState<string | null>(null);
  const [busyJti, setBusyJti] = useState<string | null>(null);
  const [revokingAllOthers, setRevokingAllOthers] = useState(false);
  const [confirmingRevokeAll, setConfirmingRevokeAll] = useState(false);

  const load = () => {
    setLoading(true);
    sessionsService
      .list()
      .then(setSessions)
      .catch((err) => toast.error(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const confirmRevoke = async () => {
    if (!revokingJti) return;
    setBusyJti(revokingJti);
    try {
      await sessionsService.revoke(revokingJti);
      toast.success('Session revoked');
      setRevokingJti(null);
      load();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusyJti(null);
    }
  };

  const confirmRevokeAllOthers = async () => {
    setRevokingAllOthers(true);
    try {
      const { revokedCount } = await sessionsService.revokeAllOthers();
      toast.success(revokedCount > 0 ? `Signed out of ${revokedCount} other session(s)` : 'No other sessions to sign out of');
      setConfirmingRevokeAll(false);
      load();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setRevokingAllOthers(false);
    }
  };

  const otherSessionCount = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <>
      <SettingsSection icon={<FiMonitor />}
        title="Active Sessions"
        description="Devices currently signed in to your account."
        footer={
          !loading &&
          otherSessionCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmingRevokeAll(true)}>
              Sign out of all other sessions
            </Button>
          )
        }
      >
        {loading ? (
          <>
            <Skeleton height={52} />
            <Skeleton height={52} />
          </>
        ) : !sessions || sessions.length === 0 ? (
          <div className={styles.emptyState}>No active sessions.</div>
        ) : (
          sessions.map((session) => {
            const Icon = isMobileDevice(session.device) ? FiSmartphone : FiMonitor;
            return (
              <div key={session.jti} className={styles.sessionRow}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  <Icon size={18} />
                  <div className={styles.sessionInfo}>
                    <span className={styles.sessionDevice}>{session.device}</span>
                    <span className={styles.sessionMeta}>
                      {[session.location, `last active ${new Date(session.lastSeenAt).toLocaleString()}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                </div>
                {session.current ? (
                  <Badge variant="success" dot>
                    This device
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyJti === session.jti}
                    onClick={() => setRevokingJti(session.jti)}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            );
          })
        )}
      </SettingsSection>

      <Modal
        open={revokingJti !== null}
        onClose={() => setRevokingJti(null)}
        title="Revoke this session?"
        description="That device will be signed out immediately and will need to sign in again."
        maxWidth={420}
      >
        <div className={sectionStyles.footer} style={{ borderTop: 'none', padding: 'var(--space-4)' }}>
          <Button variant="ghost" onClick={() => setRevokingJti(null)} disabled={busyJti !== null}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirmRevoke()} loading={busyJti !== null}>
            Revoke
          </Button>
        </div>
      </Modal>

      <Modal
        open={confirmingRevokeAll}
        onClose={() => setConfirmingRevokeAll(false)}
        title="Sign out of all other sessions?"
        description="Every other device currently signed in will be signed out immediately. This device stays signed in."
        maxWidth={420}
      >
        <div className={sectionStyles.footer} style={{ borderTop: 'none', padding: 'var(--space-4)' }}>
          <Button variant="ghost" onClick={() => setConfirmingRevokeAll(false)} disabled={revokingAllOthers}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirmRevokeAllOthers()} loading={revokingAllOthers}>
            Sign out all others
          </Button>
        </div>
      </Modal>
    </>
  );
}

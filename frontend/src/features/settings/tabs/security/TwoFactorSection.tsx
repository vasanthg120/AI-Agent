import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Button, CopyableText, Input, Modal, Skeleton, Switch } from '@/components/ui';
import { twoFactorService, type TwoFactorSetup, type TwoFactorStatus } from '@/services/twoFactorService';
import { extractErrorMessage } from '@/utils/errors';
import { SettingsSection } from '../../components/SettingsSection';
import sectionStyles from '../../components/SettingsSection.module.css';
import styles from '../SecuritySettings.module.css';

type ReauthAction = 'disable' | 'regenerate' | null;

export function TwoFactorSection() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [setupData, setSetupData] = useState<TwoFactorSetup | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifying, setVerifying] = useState(false);

  const [reauthAction, setReauthAction] = useState<ReauthAction>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthSubmitting, setReauthSubmitting] = useState(false);

  const [backupCodesReveal, setBackupCodesReveal] = useState<string[] | null>(null);

  const refreshStatus = () => {
    twoFactorService
      .getStatus()
      .then(setStatus)
      .catch((err) => toast.error(extractErrorMessage(err)));
  };

  useEffect(() => {
    let cancelled = false;
    twoFactorService
      .getStatus()
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err) => {
        if (!cancelled) toast.error(extractErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openWizard = async () => {
    setWizardOpen(true);
    setSetupLoading(true);
    setVerifyCode('');
    try {
      const data = await twoFactorService.setup();
      setSetupData(data);
    } catch (err) {
      toast.error(extractErrorMessage(err));
      setWizardOpen(false);
    } finally {
      setSetupLoading(false);
    }
  };

  const handleVerifyAndEnable = async () => {
    if (verifyCode.length !== 6) {
      toast.error('Enter the 6-digit code from your authenticator app');
      return;
    }
    setVerifying(true);
    try {
      const { backupCodes } = await twoFactorService.enable(verifyCode);
      setWizardOpen(false);
      setSetupData(null);
      setBackupCodesReveal(backupCodes);
      refreshStatus();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setVerifying(false);
    }
  };

  const handleReauthConfirm = async () => {
    if (!reauthAction || !reauthPassword) {
      toast.error('Enter your password to continue');
      return;
    }
    setReauthSubmitting(true);
    try {
      if (reauthAction === 'disable') {
        await twoFactorService.disable({ password: reauthPassword });
        toast.success('Two-factor authentication disabled — other devices have been signed out');
        setReauthAction(null);
        refreshStatus();
      } else {
        const { backupCodes } = await twoFactorService.regenerateBackupCodes({ password: reauthPassword });
        setReauthAction(null);
        setBackupCodesReveal(backupCodes);
        refreshStatus();
      }
      setReauthPassword('');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setReauthSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SettingsSection title="Two-Factor Authentication" description="Add an extra layer of security to your account.">
        <Skeleton height={20} />
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title="Two-Factor Authentication" description="Add an extra layer of security to your account.">
        <Switch
          checked={status?.enabled ?? false}
          onChange={(checked) => {
            if (checked) void openWizard();
            else setReauthAction('disable');
          }}
          label="Require a verification code at sign-in"
          description="Uses an authenticator app (Google Authenticator, Authy, 1Password, etc)."
        />
        {status?.enabled && (
          <div className={styles.sessionRow}>
            <div className={styles.sessionInfo}>
              <span className={styles.sessionDevice}>
                Enabled {status.enabledAt ? `on ${new Date(status.enabledAt).toLocaleDateString()}` : ''}
              </span>
              <span className={styles.sessionMeta}>{status.backupCodesRemaining} backup code(s) remaining</span>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setReauthAction('regenerate')}>
              Regenerate backup codes
            </Button>
          </div>
        )}
      </SettingsSection>

      <Modal
        open={wizardOpen}
        onClose={() => {
          setWizardOpen(false);
          setSetupData(null);
        }}
        title="Set up two-factor authentication"
        description="Scan this QR code with your authenticator app, then enter the 6-digit code it shows."
        maxWidth={420}
      >
        {setupLoading || !setupData ? (
          <Skeleton height={200} />
        ) : (
          <div className={sectionStyles.body}>
            <img src={setupData.qrCodeDataUrl} alt="2FA enrollment QR code" width={200} height={200} style={{ borderRadius: 'var(--radius-md)' }} />
            <p className={styles.sessionMeta}>Can't scan? Enter this code manually:</p>
            <CopyableText value={setupData.secret} />
            <Input
              label="6-digit code"
              placeholder="123456"
              maxLength={6}
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
              disabled={verifying}
            />
            <div className={sectionStyles.footer} style={{ borderTop: 'none' }}>
              <Button variant="ghost" onClick={() => setWizardOpen(false)} disabled={verifying}>
                Cancel
              </Button>
              <Button onClick={() => void handleVerifyAndEnable()} loading={verifying}>
                Verify &amp; Enable
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={reauthAction !== null}
        onClose={() => {
          setReauthAction(null);
          setReauthPassword('');
        }}
        title={reauthAction === 'disable' ? 'Disable two-factor authentication?' : 'Regenerate backup codes?'}
        description={
          reauthAction === 'disable'
            ? 'This removes the extra sign-in step from your account. Confirm your password to continue.'
            : 'Your existing backup codes will stop working. Confirm your password to generate a new set.'
        }
        maxWidth={420}
      >
        <div className={sectionStyles.body}>
          <Input
            label="Password"
            type="password"
            placeholder="••••••••"
            value={reauthPassword}
            onChange={(e) => setReauthPassword(e.target.value)}
            disabled={reauthSubmitting}
          />
          <div className={sectionStyles.footer} style={{ borderTop: 'none' }}>
            <Button variant="ghost" onClick={() => setReauthAction(null)} disabled={reauthSubmitting}>
              Cancel
            </Button>
            <Button
              variant={reauthAction === 'disable' ? 'danger' : 'primary'}
              onClick={() => void handleReauthConfirm()}
              loading={reauthSubmitting}
            >
              {reauthAction === 'disable' ? 'Disable' : 'Regenerate'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={backupCodesReveal !== null}
        onClose={() => setBackupCodesReveal(null)}
        title="Save your backup codes"
        description="Each code can be used once if you lose access to your authenticator app. Store them somewhere safe — they will not be shown again."
        maxWidth={420}
      >
        <div className={sectionStyles.body}>
          {backupCodesReveal && <CopyableText value={backupCodesReveal.join('  ')} />}
          <p className={styles.warning}>This is the only time these codes will be shown.</p>
          <div className={sectionStyles.footer} style={{ borderTop: 'none' }}>
            <Button onClick={() => setBackupCodesReveal(null)}>I've saved these codes</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

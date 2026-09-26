import { useState } from 'react';
import toast from 'react-hot-toast';
import { FiEye, FiEyeOff, FiKey } from 'react-icons/fi';
import { Button, Input } from '@/components/ui';
import { authService } from '@/services/authService';
import { extractErrorMessage } from '@/utils/errors';
import { SettingsSection } from '../../components/SettingsSection';
import sectionStyles from '../../components/SettingsSection.module.css';
import styles from '../SecuritySettings.module.css';

export function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword) {
      toast.error('Enter your current and new password');
      return;
    }
    if (newPassword.length < 8) {
      toast.error('New password must be at least 8 characters');
      return;
    }
    setChangingPassword(true);
    try {
      await authService.changePassword(currentPassword, newPassword);
      toast.success('Password updated — other devices have been signed out');
      setCurrentPassword('');
      setNewPassword('');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <SettingsSection icon={<FiKey />} title="Password" description="Change your account password.">
      <Input
        label="Current password"
        type={showCurrentPassword ? 'text' : 'password'}
        placeholder="••••••••"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        disabled={changingPassword}
        rightIcon={
          <button
            type="button"
            className={styles.passwordToggle}
            onClick={() => setShowCurrentPassword((prev) => !prev)}
            aria-label={showCurrentPassword ? 'Hide password' : 'Show password'}
          >
            {showCurrentPassword ? <FiEyeOff /> : <FiEye />}
          </button>
        }
      />
      <Input
        label="New password"
        type={showNewPassword ? 'text' : 'password'}
        placeholder="••••••••"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        disabled={changingPassword}
        rightIcon={
          <button
            type="button"
            className={styles.passwordToggle}
            onClick={() => setShowNewPassword((prev) => !prev)}
            aria-label={showNewPassword ? 'Hide password' : 'Show password'}
          >
            {showNewPassword ? <FiEyeOff /> : <FiEye />}
          </button>
        }
      />
      <div className={sectionStyles.footer} style={{ borderTop: 'none' }}>
        <Button onClick={() => void handleChangePassword()} loading={changingPassword}>
          Update Password
        </Button>
      </div>
    </SettingsSection>
  );
}

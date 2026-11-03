import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { authService } from '@/services/authService';
import { useAuthStore } from '@/stores/authStore';
import { extractErrorMessage } from '@/utils/errors';
import { PasswordField } from './components/PasswordField';
import { PasswordStrengthMeter } from './components/PasswordStrengthMeter';
import styles from './AuthForm.module.css';

const MIN_PASSWORD_LENGTH = 8;

// Where an invitation's link lands. The token in the URL is the only proof needed;
// choosing a password here activates the account and signs the person in.
export function ActivateAccountPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const loginWithToken = useAuthStore((state) => state.loginWithToken);

  const [invitation, setInvitation] = useState<{ email: string; name: string; businessName: string } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(token ? null : 'This link is incomplete. Open it again from your email.');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!token) return;
    authService
      .describeInvitation(token)
      .then(setInvitation)
      .catch((err) => setLinkError(extractErrorMessage(err)));
  }, [token]);

  const submit = async () => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setProblem(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setProblem('The two passwords don’t match.');
      return;
    }
    setProblem(null);
    setSaving(true);
    try {
      const { accessToken } = await authService.acceptInvitation(token, password);
      await loginWithToken(accessToken);
      navigate(ROUTES.dashboard, { replace: true });
    } catch (err) {
      setProblem(extractErrorMessage(err));
      setSaving(false);
    }
  };

  if (linkError) {
    return (
      <div className={styles.form}>
        <div className={styles.hintBox} role="alert">
          <span>{linkError}</span>
        </div>
        <Link to={ROUTES.login}>Go to sign in</Link>
      </div>
    );
  }

  if (!invitation) return <p>Checking your invitation…</p>;

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (!saving) void submit();
      }}
      noValidate
    >
      <div className={styles.hintBox}>
        <span>
          Welcome, {invitation.name}. You’re activating <strong>{invitation.businessName}</strong> with{' '}
          <strong>{invitation.email}</strong>.
        </span>
      </div>
      <PasswordField label="Choose a password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      <PasswordStrengthMeter password={password} />
      <PasswordField label="Confirm password" autoComplete="new-password" value={confirm} error={problem ?? undefined} onChange={(e) => setConfirm(e.target.value)} />
      <Button type="submit" fullWidth loading={saving}>
        Activate account
      </Button>
    </form>
  );
}

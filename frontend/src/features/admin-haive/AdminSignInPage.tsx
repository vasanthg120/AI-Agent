import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiLock, FiMail, FiShield } from 'react-icons/fi';
import { Button, Input } from '@/components/ui';
import { useAdminAuthStore } from '@/stores/adminAuthStore';
import { extractErrorMessage } from '@/utils/errors';
import { ADMIN_ROUTES } from '@/constants/routes';
import styles from './AdminSignInPage.module.css';

// Authenticates through POST /auth/admin/login — a fully separate
// credential from the customer app's login (see adminAuthStore.ts /
// adminAuthService.ts). A successful call here means the account IS an
// admin account; there's no post-login role check to fail, unlike the old
// design where any customer account could attempt this form.
export function AdminSignInPage() {
  const login = useAdminAuthStore((state) => state.login);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      toast.success('Welcome back');
      navigate(ADMIN_ROUTES.dashboard, { replace: true });
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brandMark}>
          <FiShield size={20} />
        </div>
        <h1 className={styles.title}>Haive Platform Admin</h1>
        <p className={styles.subtitle}>Sign in with your platform admin account.</p>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <Input
            label="Email"
            type="email"
            autoComplete="username"
            leftIcon={<FiMail />}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            leftIcon={<FiLock />}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          {error && (
            <div className={styles.errorBox} role="alert">
              {error}
            </div>
          )}
          <Button type="submit" size="lg" fullWidth loading={submitting}>
            Sign In
          </Button>
        </form>

        <p className={styles.footerText}>Restricted to Haive platform administrators.</p>
      </div>
    </div>
  );
}

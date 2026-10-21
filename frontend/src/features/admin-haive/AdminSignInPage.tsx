import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiCreditCard, FiEye, FiEyeOff, FiLock, FiMail, FiShield, FiSliders, FiUsers } from 'react-icons/fi';
import { Button, Input } from '@/components/ui';
import { AuthLayout, type AuthLayoutHighlight } from '@/layouts/AuthLayout/AuthLayout';
import { useAdminAuthStore } from '@/stores/adminAuthStore';
import { extractLoginErrorMessage } from '@/utils/errors';
import { ADMIN_ROUTES } from '@/constants/routes';
// Same shell and form styling every customer-facing signed-out page uses
// (login/register/forgot-password) — see AuthForm.module.css's own header
// comment ("Shared by every signed-out page"). Reused here, not duplicated,
// so this page matches /login pixel-for-pixel; only `errorBox` (this admin
// form's own inline error style — the customer pages use a toast instead,
// a pre-existing behavioral difference left untouched) still comes from
// this page's own stylesheet.
import authStyles from '@/features/auth/AuthForm.module.css';
// AuthLayout's own CSS module, imported directly so the admin-specific
// brand-panel content below (brandTitle's accent span) can reuse its
// `.brandAccent` class exactly — the customer pages get this for free from
// AuthLayout's own default content; this page supplies its own content, so
// it needs the class itself.
import brandStyles from '@/layouts/AuthLayout/AuthLayout.module.css';
import styles from './AdminSignInPage.module.css';

const ADMIN_BRAND_TITLE = (
  <>
    Everything HaiVE runs,
    <br />
    <span className={brandStyles.brandAccent}>in one console.</span>
  </>
);

const ADMIN_BRAND_LEAD =
  'Organizations, billing, integrations and platform settings — manage all of HaiVE from one secure admin console.';

const ADMIN_HIGHLIGHTS: AuthLayoutHighlight[] = [
  {
    icon: FiUsers,
    title: 'Every organization, one view',
    text: 'See every workspace on HaiVE — plans, usage and status, all in one place.',
  },
  {
    icon: FiCreditCard,
    title: 'Billing, plans and subscriptions',
    text: 'Track payments, invoices and subscription health across the whole platform.',
  },
  {
    icon: FiSliders,
    title: 'Platform-wide settings',
    text: 'Manage the shared integrations and AI providers every organization relies on.',
  },
];

const ADMIN_TRUST = (
  <>
    <FiShield /> Audited admin actions · platform-admin only · encrypted credentials
  </>
);

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
  const [showPassword, setShowPassword] = useState(false);
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
      setError(extractLoginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Haive Platform Admin"
      subtitle="Sign in with your platform admin account."
      brandTitle={ADMIN_BRAND_TITLE}
      brandLead={ADMIN_BRAND_LEAD}
      highlights={ADMIN_HIGHLIGHTS}
      trust={ADMIN_TRUST}
    >
      <form className={authStyles.form} onSubmit={onSubmit} noValidate>
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
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          leftIcon={<FiLock />}
          rightIcon={
            <button
              type="button"
              className={authStyles.passwordToggle}
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <FiEyeOff /> : <FiEye />}
            </button>
          }
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

      <p className={authStyles.footerText}>Restricted to Haive platform administrators.</p>
    </AuthLayout>
  );
}

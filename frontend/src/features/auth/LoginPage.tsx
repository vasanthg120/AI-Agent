import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiArrowRight, FiMail } from 'react-icons/fi';
import { FaGoogle, FaMicrosoft } from 'react-icons/fa';
import { Input, Button } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';
import { authService } from '@/services/authService';
import { extractErrorMessage } from '@/utils/errors';
import { ROUTES } from '@/constants/routes';
import type { OAuthProvider } from '@/types';
import { PasswordField } from './components/PasswordField';
import { TwoFactorChallengeForm } from './components/TwoFactorChallengeForm';
import { loginSchema, type LoginFormValues } from './schemas';
import styles from './AuthForm.module.css';

type Step = 'credentials' | 'twoFactor';

export function LoginPage() {
  const [step, setStep] = useState<Step>('credentials');
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);
  // Never written to authStore/localStorage — held here only, for exactly
  // as long as the 2FA step is on screen. This is what guarantees it can
  // never be attached as a Bearer header by axiosClient's interceptor
  // (which only ever reads accessToken from the store) or trip the
  // 401-forced-logout path.
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const login = useAuthStore((state) => state.login);
  const verifyTwoFactor = useAuthStore((state) => state.verifyTwoFactor);
  const navigate = useNavigate();
  const location = useLocation();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    // Coming back from a password reset, the email is already known.
    defaultValues: {
      email: (location.state as { email?: string } | null)?.email ?? '',
      password: '',
      rememberMe: true,
    },
  });

  const goToChat = () => {
    const from = (location.state as { from?: Location })?.from?.pathname ?? ROUTES.chat;
    navigate(from, { replace: true });
    toast.success('Welcome back!');
  };

  const onSubmit = async (values: LoginFormValues) => {
    try {
      const result = await login(values);
      if (result.requiresTwoFactor) {
        setChallengeToken(result.challengeToken ?? null);
        setStep('twoFactor');
        return;
      }
      goToChat();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const onVerifyTwoFactor = async (code: string) => {
    if (!challengeToken) return;
    try {
      await verifyTwoFactor(challengeToken, code);
      goToChat();
    } catch (error) {
      toast.error(extractErrorMessage(error));
      throw error;
    }
  };

  if (step === 'twoFactor') {
    return (
      <TwoFactorChallengeForm
        onSubmit={onVerifyTwoFactor}
        onBack={() => {
          setStep('credentials');
          setChallengeToken(null);
        }}
      />
    );
  }

  // Full-page redirect into the provider's consent screen — same shape as
  // the Gmail/Outlook "Connect" buttons in IntegrationsPage, just for login
  // instead of mailbox delegation. The backend's callback redirects back to
  // /oauth/callback with a session token once it completes.
  const handleOAuth = async (provider: OAuthProvider) => {
    setOauthBusy(provider);
    try {
      const url = await authService.getOAuthUrl(provider);
      window.location.href = url;
    } catch (error) {
      toast.error(extractErrorMessage(error));
      setOauthBusy(null);
    }
  };

  return (
    <>
      <div className={styles.socialRow}>
        <button
          type="button"
          className={styles.socialButton}
          onClick={() => void handleOAuth('google')}
          disabled={!!oauthBusy}
        >
          <FaGoogle aria-hidden /> {oauthBusy === 'google' ? 'Opening Google…' : 'Google'}
        </button>
        <button
          type="button"
          className={styles.socialButton}
          onClick={() => void handleOAuth('microsoft')}
          disabled={!!oauthBusy}
        >
          <FaMicrosoft aria-hidden /> {oauthBusy === 'microsoft' ? 'Opening Microsoft…' : 'Microsoft'}
        </button>
      </div>

      <div className={styles.divider}>or sign in with email</div>

      <form className={styles.form} onSubmit={handleSubmit(onSubmit)} noValidate>
        <Input
          label="Work email"
          type="email"
          placeholder="you@company.com"
          autoComplete="email"
          inputMode="email"
          autoFocus
          leftIcon={<FiMail />}
          error={errors.email?.message}
          {...register('email')}
        />

        <PasswordField
          label="Password"
          placeholder="Your password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register('password')}
        />

        <div className={styles.optionsRow}>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" {...register('rememberMe')} />
            Keep me signed in
          </label>
          <Link className={styles.link} to={ROUTES.forgotPassword}>
            Forgot password?
          </Link>
        </div>

        <Button type="submit" size="lg" fullWidth loading={isSubmitting} rightIcon={<FiArrowRight />}>
          Sign in
        </Button>
      </form>

      <p className={styles.footerText}>
        New to HaiVE?{' '}
        <Link className={styles.link} to={ROUTES.register}>
          Create your workspace
        </Link>
      </p>
    </>
  );
}

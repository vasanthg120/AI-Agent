import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiMail, FiLock, FiEye, FiEyeOff } from 'react-icons/fi';
import { FaGoogle, FaMicrosoft } from 'react-icons/fa';
import { Input, Button } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';
import { authService } from '@/services/authService';
import { extractErrorMessage } from '@/utils/errors';
import { ROUTES } from '@/constants/routes';
import type { OAuthProvider } from '@/types';
import { TwoFactorChallengeForm } from './components/TwoFactorChallengeForm';
import { loginSchema, type LoginFormValues } from './schemas';
import styles from './AuthForm.module.css';

type Step = 'credentials' | 'twoFactor';

export function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState<Step>('credentials');
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
    defaultValues: { email: '', password: '', rememberMe: true },
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
    try {
      const url = await authService.getOAuthUrl(provider);
      window.location.href = url;
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  return (
    <>
      <form className={styles.form} onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className={styles.hintBox}>Sign in with your account, or create one below.</div>

        <Input
          label="Email"
          type="email"
          placeholder="you@company.com"
          leftIcon={<FiMail />}
          error={errors.email?.message}
          {...register('email')}
        />

        <Input
          label="Password"
          type={showPassword ? 'text' : 'password'}
          placeholder="••••••••"
          leftIcon={<FiLock />}
          rightIcon={
            <button
              type="button"
              className={styles.passwordToggle}
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <FiEyeOff /> : <FiEye />}
            </button>
          }
          error={errors.password?.message}
          {...register('password')}
        />

        <div className={styles.optionsRow}>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" {...register('rememberMe')} />
            Remember me
          </label>
          <Link className={styles.link} to={ROUTES.forgotPassword}>
            Forgot password?
          </Link>
        </div>

        <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
          Sign In
        </Button>
      </form>

      <div className={styles.divider}>or continue with</div>
      <div className={styles.socialRow}>
        <button type="button" className={styles.socialButton} onClick={() => handleOAuth('google')} aria-label="Continue with Google">
          <FaGoogle />
        </button>
        <button
          type="button"
          className={styles.socialButton}
          onClick={() => handleOAuth('microsoft')}
          aria-label="Continue with Microsoft"
        >
          <FaMicrosoft />
        </button>
      </div>

      <p className={styles.footerText}>
        Don't have an account?{' '}
        <Link className={styles.link} to={ROUTES.register}>
          Create one
        </Link>
      </p>
    </>
  );
}

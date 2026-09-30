import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import { FiArrowLeft, FiArrowRight, FiCheck, FiMail } from 'react-icons/fi';
import { Input, Button } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { authService } from '@/services/authService';
import { extractErrorMessage } from '@/utils/errors';
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  type ForgotPasswordFormValues,
  type ResetPasswordFormValues,
} from './schemas';
import { AuthStepper } from './components/AuthStepper';
import { OtpInput } from './components/OtpInput';
import { PasswordField } from './components/PasswordField';
import { PasswordStrengthMeter } from './components/PasswordStrengthMeter';
import styles from './AuthForm.module.css';

const STEPS = [
  { id: 'email', label: 'Your email' },
  { id: 'reset', label: 'New password' },
  { id: 'done', label: 'Done' },
];
const RESEND_AFTER_SECONDS = 60;

// Forgot and reset password in one guided flow: ask for the email, then the
// emailed code and the new password together (the reset call checks both),
// then a clear "done" with the way back to sign in.
export function ForgotPasswordPage() {
  const [step, setStep] = useState(0);
  const [maskedEmail, setMaskedEmail] = useState('');
  const [email, setEmail] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [resending, setResending] = useState(false);
  const navigate = useNavigate();

  const emailForm = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });
  const resetForm = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    mode: 'onTouched',
    defaultValues: { otp: '', password: '', confirmPassword: '' },
  });
  const newPassword = resetForm.watch('password');

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const sendCode = async (address: string) => {
    const { maskedEmail: masked } = await authService.forgotPassword({ email: address });
    setEmail(address);
    setMaskedEmail(masked);
    setResendIn(RESEND_AFTER_SECONDS);
  };

  const onSubmitEmail = async (values: ForgotPasswordFormValues) => {
    try {
      await sendCode(values.email.trim());
      resetForm.reset({ otp: '', password: '', confirmPassword: '' });
      setStep(1);
      toast.success('We sent you a 6-digit code');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const resend = async () => {
    setResending(true);
    try {
      await sendCode(email);
      resetForm.setValue('otp', '');
      toast.success('A new code is on its way');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setResending(false);
    }
  };

  const onSubmitReset = async (values: ResetPasswordFormValues) => {
    try {
      await authService.resetPassword({ email, ...values });
      setStep(2);
    } catch (error) {
      toast.error(extractErrorMessage(error));
      resetForm.setValue('otp', '');
    }
  };

  return (
    <>
      <AuthStepper steps={STEPS} current={step} onStepClick={step < 2 ? (i) => setStep(i) : undefined} />

      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.22, ease: [0.2, 0.9, 0.3, 1] }}
        >
          {step === 0 && (
            <form className={styles.form} onSubmit={emailForm.handleSubmit(onSubmitEmail)} noValidate>
              <p className={styles.stepLead} style={{ marginTop: 0 }}>
                Enter the email you sign in with. We’ll send a 6-digit code to reset your password.
              </p>
              <Input
                label="Email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                placeholder="you@company.com"
                leftIcon={<FiMail />}
                error={emailForm.formState.errors.email?.message}
                {...emailForm.register('email')}
              />
              <Button
                type="submit"
                size="lg"
                fullWidth
                loading={emailForm.formState.isSubmitting}
                rightIcon={<FiArrowRight />}
              >
                Send code
              </Button>
            </form>
          )}

          {step === 1 && (
            <form className={styles.form} onSubmit={resetForm.handleSubmit(onSubmitReset)} noValidate>
              <div className={styles.hintBox}>
                <FiMail aria-hidden />
                <span>
                  Code sent to <strong>{maskedEmail || email}</strong>. It can take a minute — check spam too.
                </span>
              </div>

              <Controller
                control={resetForm.control}
                name="otp"
                render={({ field }) => (
                  <OtpInput
                    autoFocus
                    value={field.value}
                    onChange={field.onChange}
                    error={resetForm.formState.errors.otp?.message}
                  />
                )}
              />
              <div className={styles.inlineRow}>
                <button type="button" className={styles.textButton} onClick={() => setStep(0)}>
                  Use a different email
                </button>
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={resendIn > 0 || resending}
                  onClick={() => void resend()}
                >
                  {resending ? 'Sending…' : resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
                </button>
              </div>

              <PasswordField
                label="New password"
                autoComplete="new-password"
                error={resetForm.formState.errors.password?.message}
                {...resetForm.register('password')}
              />
              <PasswordStrengthMeter password={newPassword ?? ''} />
              <PasswordField
                label="Confirm new password"
                autoComplete="new-password"
                error={resetForm.formState.errors.confirmPassword?.message}
                {...resetForm.register('confirmPassword')}
              />
              <Button type="submit" size="lg" fullWidth loading={resetForm.formState.isSubmitting}>
                Reset password
              </Button>
            </form>
          )}

          {step === 2 && (
            <div className={styles.success}>
              <motion.span
                className={styles.successIcon}
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 380, damping: 18 }}
              >
                <FiCheck />
              </motion.span>
              <h2 className={styles.successTitle}>Password updated</h2>
              <p className={styles.successText}>
                Your password has been reset. Sign in with your new password — other devices will need it too.
              </p>
              <Button
                fullWidth
                size="lg"
                rightIcon={<FiArrowRight />}
                onClick={() => navigate(ROUTES.login, { state: { email } })}
              >
                Sign in
              </Button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {step < 2 && (
        <p className={styles.footerText}>
          <Link className={styles.link} to={ROUTES.login}>
            <FiArrowLeft aria-hidden style={{ verticalAlign: '-2px' }} /> Back to sign in
          </Link>
        </p>
      )}
    </>
  );
}

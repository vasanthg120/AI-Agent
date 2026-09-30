import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import { FiArrowLeft, FiArrowRight, FiBriefcase, FiInfo, FiMail, FiUser } from 'react-icons/fi';
import { Input, Button } from '@/components/ui';
import { PhoneNumberField } from '@/features/calling/PhoneNumberField';
import { authService } from '@/services/authService';
import { useAuthStore } from '@/stores/authStore';
import { ROUTES } from '@/constants/routes';
import { registerSchema, type RegisterFormValues } from './schemas';
import { AuthStepper } from './components/AuthStepper';
import { PasswordField } from './components/PasswordField';
import { PasswordStrengthMeter } from './components/PasswordStrengthMeter';
import styles from './AuthForm.module.css';

const STEPS: Array<{
  id: string;
  label: string;
  heading: string;
  lead: string;
  fields: FieldPath<RegisterFormValues>[];
}> = [
  {
    id: 'you',
    label: 'About you',
    heading: 'Tell us who you are',
    lead: 'You’ll be the owner of your new workspace.',
    fields: ['firstName', 'lastName', 'email'],
  },
  {
    id: 'company',
    label: 'Your company',
    heading: 'Your company',
    lead: 'Your workspace is named after it — teammates you invite join it.',
    fields: ['company', 'phone'],
  },
  {
    id: 'security',
    label: 'Security',
    heading: 'Secure your account',
    lead: 'Choose a strong password. You can add two-factor sign-in later.',
    fields: ['password', 'confirmPassword', 'acceptTerms'],
  },
];

// Sign-up in three short steps, each checked before moving on, so nobody
// meets a wall of eight fields or finds a mistake only at the very end.
export function RegisterPage() {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const register_ = useAuthStore((state) => state.register);
  const navigate = useNavigate();

  const {
    register,
    control,
    handleSubmit,
    trigger,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    mode: 'onTouched',
    defaultValues: {
      firstName: '',
      lastName: '',
      company: '',
      email: '',
      phone: '',
      password: '',
      confirmPassword: '',
      acceptTerms: undefined as unknown as true,
      marketingConsent: false,
    },
  });

  const password = watch('password');
  const firstName = watch('firstName');
  const last = step === STEPS.length - 1;

  const goTo = (next: number) => {
    setDirection(next > step ? 1 : -1);
    setStep(next);
  };

  const next = async () => {
    const ok = await trigger(STEPS[step].fields, { shouldFocus: true });
    if (ok) goTo(step + 1);
  };

  const onSubmit = async (values: RegisterFormValues) => {
    try {
      await register_(values);
      // The sign-up call itself doesn't take a phone number — save it on the
      // new profile so it isn't silently dropped. Best-effort: the account
      // exists either way.
      if (values.phone) await authService.updateMe({ phone: values.phone }).catch(() => undefined);
      toast.success('Your workspace is ready — welcome to HaiVE!');
      navigate(ROUTES.chat, { replace: true });
    } catch (error) {
      toast.error((error as Error).message);
      // An email already in use is a step-1 problem; take people back to it.
      if (/email/i.test((error as Error).message)) goTo(0);
    }
  };

  const current = STEPS[step];

  return (
    <>
      <AuthStepper steps={STEPS} current={step} onStepClick={goTo} />

      <form
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          if (!last) {
            e.preventDefault();
            void next();
            return;
          }
          void handleSubmit(onSubmit)(e);
        }}
      >
        <AnimatePresence mode="popLayout" initial={false} custom={direction}>
          <motion.div
            key={current.id}
            className={styles.stepBody}
            custom={direction}
            initial={{ opacity: 0, x: direction * 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction * -24 }}
            transition={{ duration: 0.22, ease: [0.2, 0.9, 0.3, 1] }}
          >
            <h2 className={styles.stepHeading}>
              {step === 1 && firstName ? `Nice to meet you, ${firstName}` : current.heading}
            </h2>
            <p className={styles.stepLead}>{current.lead}</p>

            {step === 0 && (
              <>
                <div className={styles.row2}>
                  <Input
                    label="First name"
                    autoComplete="given-name"
                    autoFocus
                    leftIcon={<FiUser />}
                    error={errors.firstName?.message}
                    {...register('firstName')}
                  />
                  <Input
                    label="Last name"
                    autoComplete="family-name"
                    error={errors.lastName?.message}
                    {...register('lastName')}
                  />
                </div>
                <Input
                  label="Work email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  leftIcon={<FiMail />}
                  error={errors.email?.message}
                  {...register('email')}
                />
              </>
            )}

            {step === 1 && (
              <>
                <Input
                  label="Company name"
                  autoComplete="organization"
                  autoFocus
                  placeholder="Acme Pvt Ltd"
                  leftIcon={<FiBriefcase />}
                  error={errors.company?.message}
                  {...register('company')}
                />
                <Controller
                  control={control}
                  name="phone"
                  render={({ field }) => (
                    <div>
                      <PhoneNumberField
                        label="Phone number"
                        hint="Used for account recovery and call features. We never share it."
                        initialValue={field.value}
                        onChange={(digits) => field.onChange(digits ? `+${digits}` : '')}
                      />
                      {errors.phone && <span className={styles.fieldError}>{errors.phone.message}</span>}
                    </div>
                  )}
                />
              </>
            )}

            {step === 2 && (
              <>
                <PasswordField
                  label="Password"
                  autoComplete="new-password"
                  autoFocus
                  error={errors.password?.message}
                  {...register('password')}
                />
                <PasswordStrengthMeter password={password ?? ''} />
                <PasswordField
                  label="Confirm password"
                  autoComplete="new-password"
                  error={errors.confirmPassword?.message}
                  {...register('confirmPassword')}
                />
                <label className={styles.checkboxRow}>
                  <input type="checkbox" {...register('acceptTerms')} />
                  <span>
                    I agree to the <a className={styles.link}>Terms of Service</a> and{' '}
                    <a className={styles.link}>Privacy Policy</a>
                  </span>
                </label>
                {errors.acceptTerms && <span className={styles.fieldError}>{errors.acceptTerms.message}</span>}
                <label className={styles.checkboxRow}>
                  <input type="checkbox" {...register('marketingConsent')} />
                  <span>Send me product updates and tips (optional)</span>
                </label>
                <div className={styles.hintBox}>
                  <FiInfo aria-hidden />
                  <span>
                    You’re creating a new workspace. To join your team’s existing workspace instead, ask its admin to
                    add you from <strong>Settings → Users</strong>.
                  </span>
                </div>
              </>
            )}
          </motion.div>
        </AnimatePresence>

        <div className={styles.stepActions}>
          {step > 0 && (
            <Button
              type="button"
              variant="outline"
              size="lg"
              leftIcon={<FiArrowLeft />}
              onClick={() => goTo(step - 1)}
              disabled={isSubmitting}
            >
              Back
            </Button>
          )}
          <Button type="submit" size="lg" loading={isSubmitting} rightIcon={last ? undefined : <FiArrowRight />}>
            {last ? 'Create workspace' : 'Continue'}
          </Button>
        </div>
      </form>

      <p className={styles.footerText}>
        Already have an account?{' '}
        <Link className={styles.link} to={ROUTES.login}>
          Sign in
        </Link>
      </p>
    </>
  );
}

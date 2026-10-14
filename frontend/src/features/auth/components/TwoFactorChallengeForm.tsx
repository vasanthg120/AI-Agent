import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FiArrowLeft, FiShield } from 'react-icons/fi';
import { Button, Input } from '@/components/ui';
import { twoFactorChallengeSchema, type TwoFactorChallengeFormValues } from '../schemas';
import { OtpInput } from './OtpInput';
import styles from '../AuthForm.module.css';

export interface TwoFactorChallengeFormProps {
  onSubmit: (code: string) => Promise<void>;
  onBack: () => void;
}

// Shared between LoginPage (password path) and OAuthCallbackPage (OAuth
// path) — both reach the exact same backend challenge/verify flow (see
// AuthService.issueTokenOrChallenge, the single branch point both paths
// share), so this is one UI serving both entry points rather than two.
// Six boxes for the authenticator code (submits itself once all six are in);
// a plain field for a backup code.
export function TwoFactorChallengeForm({ onSubmit, onBack }: TwoFactorChallengeFormProps) {
  const [useBackup, setUseBackup] = useState(false);
  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<TwoFactorChallengeFormValues>({
    resolver: zodResolver(twoFactorChallengeSchema),
    defaultValues: { code: '' },
  });

  const submit = async (values: TwoFactorChallengeFormValues) => {
    try {
      await onSubmit(values.code);
    } catch {
      // The page shows the error; clear the boxes for another try.
      setValue('code', '');
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit(submit)} noValidate>
      <div className={styles.hintBox}>
        <FiShield aria-hidden />
        <span>
          {useBackup
            ? 'Enter one of the backup codes you saved when you turned on two-factor authentication.'
            : 'Open your authenticator app and enter the 6-digit code for HaiVE.'}
        </span>
      </div>

      {useBackup ? (
        <Input
          label="Backup code"
          placeholder="XXXX-XXXX"
          autoFocus
          autoComplete="off"
          error={errors.code?.message}
          {...register('code')}
        />
      ) : (
        <Controller
          control={control}
          name="code"
          render={({ field }) => (
            <OtpInput
              autoFocus
              value={field.value}
              disabled={isSubmitting}
              error={errors.code?.message}
              onChange={(v) => {
                field.onChange(v);
                if (v.length === 6) void handleSubmit(submit)();
              }}
            />
          )}
        />
      )}

      <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
        Verify and sign in
      </Button>

      <div className={styles.inlineRow}>
        <button type="button" className={styles.textButton} onClick={onBack} disabled={isSubmitting}>
          <FiArrowLeft aria-hidden /> Back
        </button>
        <button
          type="button"
          className={styles.textButton}
          onClick={() => {
            setUseBackup((v) => !v);
            setValue('code', '');
          }}
        >
          {useBackup ? 'Use authenticator code' : 'Use a backup code'}
        </button>
      </div>
    </form>
  );
}

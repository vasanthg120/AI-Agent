import { useState } from 'react';
import type { FormEvent } from 'react';
import { FiArrowLeft, FiShield } from '../components/icons';
import { useAuthStore } from '@/stores/authStore';
import { extractLoginErrorMessage } from '@/utils/errors';
import styles from './SignInScreen.module.css';

// Signing in inside the Dialer itself: an iPhone keeps a home-screen app's
// storage apart from Safari's, so being signed in to HaiVE in Safari doesn't
// carry over. Same account, same password, same two-step code as HaiVE.
export function SignInScreen() {
  const login = useAuthStore((state) => state.login);
  const verifyTwoFactor = useAuthStore((state) => state.verifyTwoFactor);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // Held here only while the code step is on screen — never stored, never sent as a session.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        await verifyTwoFactor(challenge, code.trim());
      } else {
        const result = await login({ email: email.trim(), password, rememberMe: true });
        if (result.requiresTwoFactor) setChallenge(result.challengeToken ?? null);
      }
    } catch (err) {
      setError(extractLoginErrorMessage(err, challenge ? 'That code didn’t work. Try the newest one.' : undefined));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.screen}>
      <form className={styles.card} onSubmit={(event) => void submit(event)} noValidate>
        <img className={styles.logo} src="/dialer/icons/icon.svg" alt="" width={64} height={64} />
        <h1 className={styles.title}>{challenge ? 'Enter your sign-in code' : 'Sign in to HaiVE Dialer'}</h1>
        <p className={styles.subtitle}>
          {challenge ? 'Open your authenticator app and type the 6-digit code for HaiVE.' : 'Use the email and password you use for HaiVE.'}
        </p>

        {challenge ? (
          <label className={styles.field}>
            <span>Code</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/[^\d]/g, '').slice(0, 8))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              aria-invalid={!!error || undefined}
              aria-describedby={error ? 'sign-in-error' : undefined}
            />
          </label>
        ) : (
          <>
            <label className={styles.field}>
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                inputMode="email"
                autoCapitalize="none"
                required
                aria-invalid={!!error || undefined}
                aria-describedby={error ? 'sign-in-error' : undefined}
              />
            </label>
            <label className={styles.field}>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                aria-invalid={!!error || undefined}
                aria-describedby={error ? 'sign-in-error' : undefined}
              />
            </label>
          </>
        )}

        {error && (
          <p id="sign-in-error" className={styles.error} role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className={styles.submit}
          disabled={busy || (challenge ? code.length < 6 : !email || !password)}
          aria-busy={busy || undefined}
        >
          {challenge && <FiShield aria-hidden />}
          {busy ? 'Signing in…' : challenge ? 'Verify' : 'Sign in'}
        </button>

        {challenge ? (
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              setChallenge(null);
              setCode('');
              setError(null);
            }}
          >
            <FiArrowLeft aria-hidden /> Use a different account
          </button>
        ) : (
          <a className={styles.link} href="/forgot-password">
            Forgot your password?
          </a>
        )}
      </form>
    </main>
  );
}

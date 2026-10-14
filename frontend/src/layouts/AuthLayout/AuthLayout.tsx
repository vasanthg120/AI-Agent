import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiBarChart2, FiMail, FiPhoneCall, FiShield } from 'react-icons/fi';
import { Logo } from '@/components/common/Logo';
import styles from './AuthLayout.module.css';

export interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  // Wider form column (the multi-step sign-up).
  wide?: boolean;
}

const HIGHLIGHTS = [
  {
    icon: FiBarChart2,
    title: 'Your business at a glance',
    text: 'Pipeline, revenue and team performance in one live dashboard.',
  },
  {
    icon: FiMail,
    title: 'An inbox that replies for you',
    text: 'AI drafts every customer reply and never lets one slip past its SLA.',
  },
  {
    icon: FiPhoneCall,
    title: 'Coaching on every call',
    text: 'Live suggestions while you talk, a summary and a coach report after.',
  },
];

// Every signed-out page: a brand panel that says what HaiVE is (desktop and
// tablet), and the form. On phones the panel steps aside and the form takes
// the whole screen, with the logo on top.
export function AuthLayout({ title, subtitle, children, wide }: AuthLayoutProps) {
  return (
    <div className={styles.page}>
      <aside className={styles.brand} aria-hidden>
        <span className={styles.glowA} />
        <span className={styles.glowB} />
        <div className={styles.brandInner}>
          <Logo className={styles.brandLogo} />
          <div className={styles.brandCopy}>
            <h2 className={styles.brandTitle}>
              Your enterprise
              <br />
              <span className={styles.brandAccent}>AI workforce.</span>
            </h2>
            <p className={styles.brandLead}>
              Deals, emails, calls and documents in one place — with an AI that works them alongside your team.
            </p>
          </div>
          <ul className={styles.highlights}>
            {HIGHLIGHTS.map(({ icon: Icon, title: t, text }, i) => (
              <motion.li
                key={t}
                className={styles.highlight}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, delay: 0.15 + i * 0.08, ease: [0.16, 1, 0.3, 1] }}
              >
                <span className={styles.highlightIcon}>
                  <Icon />
                </span>
                <span>
                  <strong>{t}</strong>
                  <span>{text}</span>
                </span>
              </motion.li>
            ))}
          </ul>
          <p className={styles.trust}>
            <FiShield /> Encrypted at rest · two-factor sign-in · your data stays yours
          </p>
        </div>
      </aside>

      <main className={styles.main}>
        <motion.div
          className={clsx(styles.panel, wide && styles.panelWide)}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className={styles.mobileLogo}>
            <Logo />
          </div>
          <header className={styles.header}>
            <h1 className={styles.title}>{title}</h1>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </header>
          {children}
        </motion.div>
        <p className={styles.legal}>© {new Date().getFullYear()} HaiVE AI · Terms · Privacy</p>
      </main>
    </div>
  );
}

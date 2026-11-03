import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import type { IconType } from 'react-icons';
import { FiBarChart2, FiMail, FiPhoneCall, FiShield } from 'react-icons/fi';
import { Logo } from '@/components/common/Logo';
import styles from './AuthLayout.module.css';

export interface AuthLayoutHighlight {
  icon: IconType;
  title: string;
  text: string;
}

export interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  // Wider form column (the multi-step sign-up).
  wide?: boolean;
  // Left brand panel content — all optional, defaulting to HaiVE's
  // customer-facing pitch below (used as-is by /login, /register,
  // /forgot-password). A caller like AdminSignInPage overrides these to
  // show relevant copy on the SAME visual shell, without touching any of
  // those customer pages' content.
  brandTitle?: ReactNode;
  brandLead?: ReactNode;
  highlights?: AuthLayoutHighlight[];
  trust?: ReactNode;
}

const DEFAULT_BRAND_TITLE = (
  <>
    Your enterprise
    <br />
    <span className={styles.brandAccent}>AI workforce.</span>
  </>
);

const DEFAULT_BRAND_LEAD =
  'Deals, emails, calls and documents in one place — with an AI that works them alongside your team.';

const DEFAULT_HIGHLIGHTS: AuthLayoutHighlight[] = [
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

const DEFAULT_TRUST = (
  <>
    <FiShield /> Encrypted at rest · two-factor sign-in · your data stays yours
  </>
);

// Every signed-out page: a brand panel that says what HaiVE is (desktop and
// tablet), and the form. On phones the panel steps aside and the form takes
// the whole screen, with the logo on top.
export function AuthLayout({ title, subtitle, children, wide, brandTitle, brandLead, highlights, trust }: AuthLayoutProps) {
  return (
    <div className={styles.page}>
      <aside className={styles.brand} aria-hidden>
        <span className={styles.glowA} />
        <span className={styles.glowB} />
        <div className={styles.brandInner}>
          <Logo className={styles.brandLogo} />
          <div className={styles.brandCopy}>
            <h2 className={styles.brandTitle}>{brandTitle ?? DEFAULT_BRAND_TITLE}</h2>
            <p className={styles.brandLead}>{brandLead ?? DEFAULT_BRAND_LEAD}</p>
          </div>
          <ul className={styles.highlights}>
            {(highlights ?? DEFAULT_HIGHLIGHTS).map(({ icon: Icon, title: t, text }, i) => (
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
          <p className={styles.trust}>{trust ?? DEFAULT_TRUST}</p>
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

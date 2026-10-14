import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { IconType } from 'react-icons';
import { Badge, Card, type BadgeVariant } from '@/components/ui';
import styles from './integrations.module.css';

export type CardTone = 'idle' | 'connected' | 'waiting' | 'attention';

export interface IntegrationCardProps {
  // A logo image, or a lettered tile for systems without one.
  logo: ReactNode;
  name: string;
  // A short line under the name: what kind of thing this is / how it stays up to date.
  tagline: string;
  tone?: CardTone;
  status?: { label: string; variant: BadgeVariant };
  // Shown while not connected: what connecting it gives you.
  description?: string;
  highlights?: string[];
  // Shown once connected: the account, last sync, record counts…
  facts?: { icon: IconType; text: ReactNode }[];
  // One plain sentence when something is wrong.
  problem?: string;
  actions: ReactNode;
}

/** A lettered tile for a system with no logo asset. */
export function LetterLogo({ name, color }: { name: string; color: string }) {
  return (
    <span className={styles.letterLogo} style={{ background: color }} aria-hidden>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

// One integration, connected or not — the same card everywhere on the page,
// so every integration answers the same questions in the same place: what is
// it, is it connected, how is it doing, and what can I do next. The coloured
// edge says the state at a glance (green: working, amber: waiting, red: needs
// attention); the badge says it in words.
export function IntegrationCard({
  logo,
  name,
  tagline,
  tone = 'idle',
  status,
  description,
  highlights,
  facts,
  problem,
  actions,
}: IntegrationCardProps) {
  return (
    <Card className={clsx(styles.card, styles[`card_${tone}`])}>
      <div className={styles.cardHead}>
        <span className={styles.logoTile}>{logo}</span>
        <div className={styles.cardTitle}>
          <strong>{name}</strong>
          <span>{tagline}</span>
        </div>
        {status && (
          <Badge variant={status.variant} dot>
            {status.label}
          </Badge>
        )}
      </div>

      {description && <p className={styles.cardDescription}>{description}</p>}
      {highlights && highlights.length > 0 && (
        <ul className={styles.cardHighlights}>
          {highlights.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}

      {facts && facts.length > 0 && (
        <ul className={styles.cardFacts}>
          {facts.map(({ icon: Icon, text }, i) => (
            <li key={i}>
              <Icon aria-hidden />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      )}

      {problem && (
        <p className={styles.cardProblem} role="status">
          {problem}
        </p>
      )}
      <div className={styles.cardActions}>{actions}</div>
    </Card>
  );
}

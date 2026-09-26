import type { HTMLAttributes, KeyboardEvent } from 'react';
import clsx from 'clsx';
import styles from './Card.module.css';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
  interactive?: boolean;
  glass?: boolean;
}

export function Card({ padded = true, interactive, glass, className, children, onClick, onKeyDown, ...rest }: CardProps) {
  // An interactive card that actually does something on click is a button in
  // everything but tag name: reachable with Tab, activated with Enter/Space,
  // announced as a button, and marked with a hover arrow (see .clickable) so
  // people can tell it opens more detail instead of guessing.
  const clickable = interactive && !!onClick;
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (!clickable || e.defaultPrevented || e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.currentTarget.click();
    }
  };

  return (
    <div
      className={clsx(
        styles.card,
        padded && styles.padded,
        interactive && styles.interactive,
        clickable && styles.clickable,
        glass && styles.glass,
        className,
      )}
      onClick={onClick}
      onKeyDown={clickable || onKeyDown ? handleKeyDown : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}

import { useState } from 'react';
import { FiDownload, FiPlusSquare, FiShare, FiX } from '../components/icons';
import { Sheet } from '../components/Sheet';
import { useDialerStore } from '../lib/dialerStore';
import { dismissInstall, installDismissed, isIos, isStandalone, promptInstall } from '../lib/install';
import styles from './InstallBits.module.css';

/** Whether this browser can still add the Dialer to the home screen (and how). */
export function useInstallOffer(): 'prompt' | 'ios' | null {
  const prompt = useDialerStore((state) => state.installPrompt);
  if (isStandalone()) return null;
  if (prompt) return 'prompt';
  return isIos() ? 'ios' : null;
}

/** iPhones have no install button: the steps, with the icons Safari uses. */
export function IosInstallSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Add the Dialer to your Home Screen">
      <ol className={styles.steps}>
        <li>
          <span className={styles.stepIcon} aria-hidden>
            <FiShare />
          </span>
          <span>
            In Safari, tap <strong>Share</strong> (the square with an arrow).
          </span>
        </li>
        <li>
          <span className={styles.stepIcon} aria-hidden>
            <FiPlusSquare />
          </span>
          <span>
            Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </span>
        </li>
      </ol>
      <p className={styles.note}>The Dialer then opens full screen from its own icon. Sign in once inside it.</p>
      <button type="button" className={styles.done} onClick={onClose}>
        Got it
      </button>
    </Sheet>
  );
}

/** A small, dismissible offer at the top of the keypad. */
export function InstallCard() {
  const offer = useInstallOffer();
  const [hidden, setHidden] = useState(installDismissed);
  const [iosOpen, setIosOpen] = useState(false);
  if (!offer || hidden) return null;

  const install = async () => {
    if (offer === 'ios') return setIosOpen(true);
    if (await promptInstall()) setHidden(true);
  };
  return (
    <>
      <div className={styles.card} role="region" aria-label="Install the Dialer">
        <img src="/dialer/icons/icon.svg" alt="" width={36} height={36} className={styles.cardIcon} />
        <p className={styles.cardText}>Add the Dialer to your home screen.</p>
        <button type="button" className={styles.cardButton} onClick={() => void install()}>
          <FiDownload aria-hidden /> Install
        </button>
        <button
          type="button"
          className={styles.cardClose}
          aria-label="Don’t show this again"
          onClick={() => {
            dismissInstall();
            setHidden(true);
          }}
        >
          <FiX aria-hidden />
        </button>
      </div>
      <IosInstallSheet open={iosOpen} onClose={() => setIosOpen(false)} />
    </>
  );
}

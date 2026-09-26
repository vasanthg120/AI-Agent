import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiAlertCircle, FiArrowUpRight, FiAward, FiMic, FiPhoneCall, FiUploadCloud, FiZap } from 'react-icons/fi';
import { Button } from '@/components/ui';
import { plivoService } from '@/services/plivoService';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { EASE_OUT, FADE_UP, ROW_IN, SPRING_SNAPPY, staggerChildren } from '../motion';
import { CustomerPicker, type SelectedCustomer } from './CustomerPicker';
import { PhoneCallCard } from './PhoneCallCard';
import styles from './StartHub.module.css';

type Mode = 'record' | 'phone';

const MODE_STORAGE_KEY = 'haive-call-copilot-mode';

function readStoredMode(): Mode {
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === 'record' || stored === 'phone') return stored;
  } catch {
    // localStorage can throw in a locked-down browser context — fall back silently.
  }
  return 'record';
}

export interface StartHubProps {
  customer: SelectedCustomer | null;
  onCustomerChange: (customer: SelectedCustomer | null) => void;
  language: string;
  onLanguageChange: (code: string) => void;
  // Why the last attempt to start didn't work (mic blocked, server refused, …).
  errors: string[];
  onStart: () => void;
  onOpenUpload: () => void;
  onOpenLibrary: () => void;
}

interface ModeCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  tag?: { label: string; tone: 'success' | 'warning' | 'neutral' };
}

const STEPS = [
  {
    icon: <FiMic />,
    title: 'Talk as you normally would',
    text: "HaiVE listens through this device's microphone and transcribes the conversation as it happens.",
  },
  {
    icon: <FiZap />,
    title: 'Get help in the moment',
    text: 'See what to say or ask next, plus objections and buying signals the second they come up.',
  },
  {
    icon: <FiAward />,
    title: 'Review with your AI Coach',
    text: 'End the call for a summary, follow-ups and coaching — all saved to your Call Library.',
  },
];

// The first thing you see. Instead of one small "Record" card with the other two
// ways of capturing a call tucked away elsewhere, all three are laid out side by
// side with a sentence each — so it's clear what HaiVE can do and which to pick.
export function StartHub({
  customer,
  onCustomerChange,
  language,
  onLanguageChange,
  errors,
  onStart,
  onOpenUpload,
  onOpenLibrary,
}: StartHubProps) {
  const highlightId = useId();
  const [mode, setMode] = useState<Mode>(readStoredMode);

  // Same query the phone panel uses, so it's one request — this only feeds the "Ready / Needs setup" tag.
  const { data: plivo } = useQuery({
    queryKey: ['plivo', 'config'],
    queryFn: plivoService.getConfig,
    staleTime: 30_000,
  });
  const phoneTag: ModeCardProps['tag'] = !plivo
    ? undefined
    : plivo.canCall
      ? { label: 'Ready', tone: 'success' }
      : { label: 'Needs setup', tone: 'warning' };

  const chooseMode = (next: Mode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Non-fatal — the choice still holds for this visit.
    }
  };

  const cards: Array<{ id: Mode | 'upload' } & ModeCardProps> = [
    {
      id: 'record',
      icon: <FiMic />,
      title: 'Record here',
      description:
        "Use this device's microphone — for a meeting in person or a call on speaker. You get live coaching as you talk.",
      tag: { label: 'Live coaching', tone: 'neutral' },
    },
    {
      id: 'phone',
      icon: <FiPhoneCall />,
      title: 'Call a customer',
      description: 'HaiVE rings your phone, then connects the customer. The whole call is recorded for you.',
      tag: phoneTag,
    },
    {
      id: 'upload',
      icon: <FiUploadCloud />,
      title: 'Upload a recording',
      description: 'Already have the audio? Get the transcript, a summary and an AI Coach report in a minute or two.',
    },
  ];

  return (
    <motion.div className={styles.hub} variants={staggerChildren(0.07)} initial="hidden" animate="show">
      <motion.div variants={FADE_UP} className={styles.intro}>
        <h2 className={styles.heading}>How do you want to capture this call?</h2>
        <p className={styles.subheading}>
          Pick one. Every option ends up in your Call Library with a summary and coaching.
        </p>
      </motion.div>

      <motion.div variants={FADE_UP} className={styles.modes} role="group" aria-label="How to capture the call">
        {cards.map((card) => {
          const isUpload = card.id === 'upload';
          const selected = !isUpload && card.id === mode;
          return (
            <button
              key={card.id}
              type="button"
              className={clsx(styles.mode, selected && styles.modeSelected)}
              aria-pressed={isUpload ? undefined : selected}
              onClick={() => (isUpload ? onOpenUpload() : chooseMode(card.id as Mode))}
            >
              {selected && (
                <motion.span
                  layoutId={`${highlightId}-mode`}
                  className={styles.modeHighlight}
                  transition={SPRING_SNAPPY}
                />
              )}
              <span className={styles.modeTop}>
                <span className={styles.modeIcon} aria-hidden>
                  {card.icon}
                </span>
                {card.tag && <span className={clsx(styles.tag, styles[card.tag.tone])}>{card.tag.label}</span>}
                {isUpload && (
                  <span className={styles.open} aria-hidden>
                    <FiArrowUpRight />
                  </span>
                )}
              </span>
              <span className={styles.modeTitle}>{card.title}</span>
              <span className={styles.modeText}>{card.description}</span>
            </button>
          );
        })}
      </motion.div>

      <motion.div variants={FADE_UP}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={mode}
            className={styles.panel}
            aria-label={mode === 'record' ? 'Record here' : 'Call a customer'}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE_OUT }}
          >
            {mode === 'record' ? (
              <RecordPanel
                customer={customer}
                onCustomerChange={onCustomerChange}
                language={language}
                onLanguageChange={onLanguageChange}
                errors={errors}
                onStart={onStart}
              />
            ) : (
              <PhoneCallCard onOpenLibrary={onOpenLibrary} />
            )}
          </motion.section>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

function RecordPanel({
  customer,
  onCustomerChange,
  language,
  onLanguageChange,
  errors,
  onStart,
}: Pick<StartHubProps, 'customer' | 'onCustomerChange' | 'language' | 'onLanguageChange' | 'errors' | 'onStart'>) {
  const languageId = useId();

  return (
    <div className={styles.record}>
      <div className={styles.setup}>
        <CustomerPicker value={customer} onChange={onCustomerChange} />

        <div className={styles.field}>
          <label htmlFor={languageId} className={styles.fieldLabel}>
            Spoken language
          </label>
          <select
            id={languageId}
            className={styles.select}
            value={language}
            onChange={(e) => onLanguageChange(e.target.value)}
          >
            {VOICE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <span className={styles.fieldHint}>
            The language you and the customer mostly speak — it makes the transcript far more accurate.
          </span>
        </div>

        <AnimatePresence initial={false}>
          {errors.map((message) => (
            <motion.div
              key={message}
              className={styles.error}
              role="alert"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
            >
              <FiAlertCircle aria-hidden />
              <span>{message}</span>
            </motion.div>
          ))}
        </AnimatePresence>

        <div className={styles.startRow}>
          <Button type="button" size="lg" leftIcon={<FiMic />} onClick={onStart} className={styles.startButton}>
            Start recording
          </Button>
          <span className={styles.startHint}>Your browser asks for microphone access the first time.</span>
        </div>
      </div>

      <div className={styles.steps}>
        <div className={styles.stepsTitle}>What happens next</div>
        <motion.ol className={styles.stepList} variants={staggerChildren(0.09, 0.05)} initial="hidden" animate="show">
          {STEPS.map((step, index) => (
            <motion.li key={step.title} className={styles.step} variants={ROW_IN}>
              <span className={styles.stepIcon} aria-hidden>
                {step.icon}
              </span>
              <span className={styles.stepBody}>
                <span className={styles.stepTitle}>
                  <span className={styles.stepNumber}>{index + 1}</span>
                  {step.title}
                </span>
                <span className={styles.stepText}>{step.text}</span>
              </span>
            </motion.li>
          ))}
        </motion.ol>
      </div>
    </div>
  );
}

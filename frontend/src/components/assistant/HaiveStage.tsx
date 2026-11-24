import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiSquare } from 'react-icons/fi';
import { VoiceOrb, type VoiceOrbState } from '@/components/voice/VoiceOrb';
import { VoiceWaveform } from '@/components/voice/VoiceWaveform';
import { useAssistantStore, type AssistantVoiceState } from '@/stores/assistantStore';
import { assistantVoice } from './AssistantVoice';
import styles from './HaiveStage.module.css';

const ORB: Record<AssistantVoiceState, VoiceOrbState> = {
  idle: 'idle',
  listening: 'listening',
  transcribing: 'thinking',
  thinking: 'thinking',
  speaking: 'speaking',
};

const STATUS: Record<AssistantVoiceState, string> = {
  idle: '',
  listening: 'Listening',
  transcribing: 'Got it',
  thinking: 'Thinking',
  speaking: 'Haive is speaking',
};

// Shown under the status until there are words to show.
const HINT: Record<AssistantVoiceState, string> = {
  idle: '',
  listening: 'Go ahead — ask about your revenue, pipeline, anything.',
  transcribing: 'One moment…',
  thinking: 'Working it out from your own figures…',
  speaking: '',
};

// Haive, on stage, while it talks with you: its avatar and a waveform that move with its own
// voice (or with yours while it listens), and what it is saying right now, sentence by
// sentence. Slides open when Haive listens, thinks or speaks; folds away when it's quiet.
export function HaiveStage({ variant = 'panel' }: { variant?: 'panel' | 'page' }) {
  const voiceState = useAssistantStore((s) => s.voiceState);
  const caption = useAssistantStore((s) => s.caption);
  const stream = useAssistantStore((s) => s.voiceStream);
  const orb = ORB[voiceState];
  const words = voiceState === 'speaking' ? caption : null;

  return (
    <AnimatePresence initial={false}>
      {voiceState !== 'idle' && (
        <motion.section
          key="stage"
          className={clsx(styles.stage, variant === 'page' && styles.page)}
          data-state={orb}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
          aria-label="Haive"
        >
          <div className={styles.inner}>
            <span className={styles.aura} aria-hidden />
            <VoiceOrb state={orb} stream={orb === 'listening' || orb === 'speaking' ? stream : null} size={64} />
            <div className={styles.side}>
              <span className={styles.status} aria-live="polite">
                <span className={styles.statusDot} aria-hidden />
                {STATUS[voiceState]}
              </span>
              <VoiceWaveform
                stream={orb === 'listening' || orb === 'speaking' ? stream : null}
                active={orb === 'speaking'}
                bars={34}
                tone={orb === 'listening' ? 'danger' : 'accent'}
                className={styles.wave}
              />
              <AnimatePresence mode="wait" initial={false}>
                <motion.p
                  key={words ?? `hint-${voiceState}`}
                  className={words ? styles.caption : styles.hint}
                  initial={{ opacity: 0, y: 8, filter: 'blur(2px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                >
                  {words ?? HINT[voiceState]}
                </motion.p>
              </AnimatePresence>
            </div>
            {variant === 'page' && (voiceState === 'speaking' || voiceState === 'listening') && (
              <button
                type="button"
                className={styles.stop}
                onClick={() => (voiceState === 'speaking' ? assistantVoice.stopSpeaking() : assistantVoice.cancelListening())}
              >
                <FiSquare aria-hidden /> {voiceState === 'speaking' ? 'Stop' : 'Cancel'}
              </button>
            )}
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

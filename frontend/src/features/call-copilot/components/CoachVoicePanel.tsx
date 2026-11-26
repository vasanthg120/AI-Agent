import { useMemo } from 'react';
import clsx from 'clsx';
import { FiHeadphones, FiPause, FiPlay, FiRotateCcw, FiSquare, FiVolume2 } from 'react-icons/fi';
import { Button, IconButton } from '@/components/ui';
import { VoiceOrb } from '@/components/voice/VoiceOrb';
import { VoiceWaveform } from '@/components/voice/VoiceWaveform';
import { streamOfElement } from '@/components/voice/useAudioFrames';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { useCoachNarration } from '../useCoachNarration';
import styles from './AiCoachPanel.module.css';

/** "4:05" */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// AI Coach Voice Feedback: the complete report of THIS call read aloud in the
// language picked here — overall score, what went well, what to improve, every
// skill, serious concerns, coaching and next steps. The speaker icon and Speak
// Now are the same control on the same player (useCoachNarration): there is one
// narration and one voice, never two.
export function CoachVoicePanel({
  sessionId,
  languageCode,
  onLanguageChange,
}: {
  sessionId: string;
  languageCode: string;
  onLanguageChange: (code: string) => void;
}) {
  const narration = useCoachNarration(sessionId, languageCode);
  const { status, partIndex, partCount, sectionTitle, progress, elapsed, duration, buffering, error, audio } = narration;
  const language = VOICE_LANGUAGES.find((l) => l.code === languageCode)?.label ?? languageCode;
  // The voice as a stream, for the orb and waveform to move with (never changes what is heard).
  const stream = useMemo(() => streamOfElement(audio), [audio]);

  const where = sectionTitle && partCount > 0 ? `${sectionTitle} (${partIndex + 1} of ${partCount})` : null;
  let line: string;
  switch (status) {
    case 'preparing':
      line =
        languageCode === 'en'
          ? 'Preparing the full report…'
          : `Preparing the full report in ${language}… the first time in a language can take up to a minute.`;
      break;
    case 'playing':
      line = `Playing: Complete AI Coach Report${where ? ` — ${where}` : ''}${buffering ? ' · getting the next part ready…' : ''}`;
      break;
    case 'paused':
      line = `Paused: Complete AI Coach Report${where ? ` — ${where}` : ''}`;
      break;
    case 'completed':
      line = 'Finished: you have heard the complete AI Coach report.';
      break;
    case 'error':
      line = where ? `Stopped at ${where}.` : 'The report could not be read out.';
      break;
    default:
      line = `Hear the complete report in ${language}: your score, strengths, what to improve, every skill, concerns, coaching and next steps.`;
  }

  const busy = status === 'preparing';
  const active = status === 'playing' || status === 'paused' || busy;
  // The speaker icon: the same play / pause as the buttons beside it.
  const speaker =
    status === 'playing'
      ? { icon: <FiPause />, label: 'Pause the AI Coach report', onClick: narration.pause }
      : status === 'paused'
        ? { icon: <FiPlay />, label: 'Resume the AI Coach report', onClick: narration.resume }
        : { icon: <FiVolume2 />, label: `Listen to the full AI Coach report in ${language}`, onClick: narration.start };
  const showTime = status === 'playing' || status === 'paused' || status === 'completed';

  return (
    <section className={styles.voicePanel} aria-label="AI Coach Voice Feedback">
      <div className={styles.voiceHead}>
        <span className={styles.voiceTitle}>
          <FiHeadphones aria-hidden /> AI Coach Voice Feedback
        </span>
        <label className={styles.voiceLanguage}>
          <span>Language</span>
          <select
            className={styles.languageSelect}
            value={languageCode}
            onChange={(e) => onLanguageChange(e.target.value)}
            aria-label="Language for the spoken AI Coach report"
          >
            {VOICE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <IconButton icon={speaker.icon} label={speaker.label} onClick={speaker.onClick} disabled={busy} size="sm" active={status === 'playing'} />
      </div>

      <div className={styles.voiceButtons}>
        {(status === 'idle' || status === 'error') && (
          <Button type="button" size="sm" leftIcon={<FiPlay />} onClick={narration.start}>
            {status === 'error' ? (
              'Try again'
            ) : (
              <span>
                Speak Now<span className={styles.speakLong}> – Listen to Full AI Coach Report</span>
              </span>
            )}
          </Button>
        )}
        {busy && (
          <Button type="button" size="sm" loading disabled>
            Generating audio…
          </Button>
        )}
        {status === 'playing' && (
          <Button type="button" size="sm" variant="secondary" leftIcon={<FiPause />} onClick={narration.pause}>
            Pause
          </Button>
        )}
        {status === 'paused' && (
          <Button type="button" size="sm" leftIcon={<FiPlay />} onClick={narration.resume}>
            Resume
          </Button>
        )}
        {active && (
          <Button type="button" size="sm" variant="secondary" leftIcon={<FiSquare />} onClick={narration.stop}>
            Stop
          </Button>
        )}
        {(status === 'playing' || status === 'paused' || status === 'completed') && (
          <Button type="button" size="sm" variant={status === 'completed' ? 'primary' : 'secondary'} leftIcon={<FiRotateCcw />} onClick={narration.replay}>
            Replay
          </Button>
        )}
      </div>

      <div className={styles.voiceStatus} role="status" aria-live="polite">
        {active && (
          <VoiceOrb state={status === 'playing' && !buffering ? 'speaking' : busy || buffering ? 'thinking' : 'idle'} stream={status === 'playing' ? stream : null} size={26} />
        )}
        {status === 'playing' && !buffering && <VoiceWaveform stream={stream} active size="sm" bars={12} />}
        <span className={clsx(styles.voiceLine, status === 'error' && styles.voiceLineError)}>{line}</span>
      </div>

      {(showTime || (status === 'error' && progress > 0)) && (
        <div className={styles.voiceProgress}>
          <span
            className={styles.voiceTrack}
            role="progressbar"
            aria-label="How much of the report has been read"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span className={styles.voiceFill} style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
          <span className={styles.voiceTime}>
            {clock(elapsed)}
            {duration !== null && ` / ${clock(duration)}`}
          </span>
        </div>
      )}

      {error && (
        <p className={styles.voiceError} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

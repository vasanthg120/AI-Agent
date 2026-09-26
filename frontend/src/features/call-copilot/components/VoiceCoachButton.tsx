import { useEffect, useRef, useState } from 'react';
import { FiPause, FiPlay, FiSquare, FiVolume2 } from 'react-icons/fi';
import { IconButton, Spinner } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { callCopilotService } from '@/services/callCopilotService';
import { voiceService } from '@/services/voiceService';
import styles from './AiCoachPanel.module.css';

type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused';

// Play/Pause/Stop for the coach's spoken feedback, in whichever language is
// picked next to it. English speaks the script generated with the coaching
// report; any other language first asks the backend for that script rewritten
// natively in that language (cached per language server-side, so only the
// first play in a language pays for it), then speaks it through the same
// voiceService.speak() chat's own voice feature uses — same backend
// gate/throttle, so no separate capability check here: a disabled account
// just sees the inline error below.
export function VoiceCoachButton({
  sessionId,
  englishScript,
  languageCode,
  languageLabel,
}: {
  sessionId?: string;
  englishScript: string;
  languageCode: string;
  languageLabel: string;
}) {
  const [state, setState] = useState<PlaybackState>('idle');
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  // Bumped on every language change/unmount so a slow fetch for a language the
  // user has already moved off never starts playing over the new selection.
  const requestRef = useRef(0);

  const discardAudio = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };

  useEffect(() => {
    requestRef.current += 1;
    discardAudio();
    setState('idle');
    setError(null);
    return () => {
      requestRef.current += 1;
      discardAudio();
    };
  }, [languageCode]);

  const handlePlay = async () => {
    setError(null);
    if (audioRef.current && state === 'paused') {
      await audioRef.current.play();
      setState('playing');
      return;
    }
    const request = ++requestRef.current;
    setState('loading');
    try {
      let script = englishScript;
      if (languageCode !== 'en') {
        if (!sessionId) throw new Error('Open this call from the Call Library to hear it in another language.');
        script = await callCopilotService.getVoiceScript(sessionId, languageCode);
      }
      const blob = await voiceService.speak(script, languageCode);
      if (request !== requestRef.current) return;
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audio.onended = () => setState('idle');
      audio.onerror = () => {
        setError('Voice playback failed.');
        setState('idle');
      };
      audioRef.current = audio;
      await audio.play();
      setState('playing');
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(extractErrorMessage(err));
      setState('idle');
    }
  };

  const handlePause = () => {
    audioRef.current?.pause();
    setState('paused');
  };

  const handleStop = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setState('idle');
  };

  return (
    <div className={styles.voiceControls}>
      {state === 'loading' && (
        <>
          <Spinner size={16} />
          <span className={styles.voiceHint}>
            {languageCode === 'en' ? 'Preparing audio…' : `Preparing ${languageLabel} audio…`}
          </span>
        </>
      )}
      {state === 'idle' && (
        <IconButton
          icon={<FiVolume2 />}
          label={`Hear your coach walk you through this call in ${languageLabel}`}
          onClick={() => void handlePlay()}
        />
      )}
      {state === 'playing' && (
        <>
          <IconButton icon={<FiPause />} label="Pause" onClick={handlePause} />
          <IconButton icon={<FiSquare />} label="Stop" onClick={handleStop} />
        </>
      )}
      {state === 'paused' && (
        <>
          <IconButton icon={<FiPlay />} label="Resume" onClick={() => void handlePlay()} />
          <IconButton icon={<FiSquare />} label="Stop" onClick={handleStop} />
        </>
      )}
      {error && <span className={styles.voiceError}>{error}</span>}
    </div>
  );
}

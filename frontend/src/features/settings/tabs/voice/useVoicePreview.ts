import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { voiceConfigService, type VoicePersonality } from '@/services/voiceConfigService';
import { extractErrorMessage } from '@/utils/errors';

export type PreviewState = 'idle' | 'loading' | 'playing';

// One sample plays at a time. Starting another voice stops the current one, and
// pressing the active voice's button stops it (Play -> spinner -> Stop). A slow
// request for a voice the person has already moved on from never starts playing
// over the newer choice. Fetched clips are kept for the life of the page, so
// replaying a voice is instant (the server caches them too).
export function useVoicePreview() {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Bumped whenever playback is stopped or superseded; a request only acts on
  // its result if the value it started with is still current.
  const requestRef = useRef(0);
  const clipsRef = useRef(new Map<string, string>());

  const stop = useCallback(() => {
    requestRef.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    setLoadingId(null);
    setPlayingId(null);
  }, []);

  useEffect(() => {
    const clips = clipsRef.current;
    return () => {
      requestRef.current += 1;
      audioRef.current?.pause();
      audioRef.current = null;
      clips.forEach((url) => URL.revokeObjectURL(url));
      clips.clear();
    };
  }, []);

  const toggle = useCallback(
    async (voiceId: string, personality: VoicePersonality | null) => {
      if (loadingId === voiceId || playingId === voiceId) {
        stop();
        return;
      }
      stop();
      const request = requestRef.current;
      setLoadingId(voiceId);
      try {
        const key = `${voiceId}|${personality ?? ''}`;
        let url = clipsRef.current.get(key);
        if (!url) {
          url = URL.createObjectURL(await voiceConfigService.preview(voiceId, personality));
          clipsRef.current.set(key, url);
        }
        if (request !== requestRef.current) return;

        const audio = new Audio(url);
        audio.onended = () => {
          if (audioRef.current !== audio) return;
          audioRef.current = null;
          setPlayingId(null);
        };
        audio.onerror = () => {
          if (audioRef.current !== audio) return;
          audioRef.current = null;
          setPlayingId(null);
          toast.error('The preview could not be played.');
        };
        audioRef.current = audio;
        await audio.play();
        if (request !== requestRef.current) return;
        setLoadingId(null);
        setPlayingId(voiceId);
      } catch (err) {
        if (request !== requestRef.current) return;
        audioRef.current = null;
        setLoadingId(null);
        setPlayingId(null);
        toast.error(extractErrorMessage(err));
      }
    },
    [loadingId, playingId, stop],
  );

  const stateOf = (voiceId: string): PreviewState =>
    playingId === voiceId ? 'playing' : loadingId === voiceId ? 'loading' : 'idle';

  return { toggle, stop, stateOf };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { callCopilotService } from '@/services/callCopilotService';
import { voiceService } from '@/services/voiceService';
import { extractErrorMessage } from '@/utils/errors';
import { CoachNarrationPlayer, IDLE_SNAPSHOT, type NarrationSnapshot } from './coachNarrationPlayer';

export function describeNarrationError(err: unknown): string {
  if (axios.isAxiosError(err) && err.response?.status === 429) {
    return 'Too many voice requests in a minute — wait a moment, then press Try again.';
  }
  return extractErrorMessage(err);
}

export interface CoachNarrationControls extends NarrationSnapshot {
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  replay: () => void;
}

/**
 * The AI Coach's narration for one call in one language. A new call or language
 * makes a new player and destroys the old one (its sound stops at once), as does
 * closing the panel — so nothing keeps talking about a call no longer on screen.
 */
export function useCoachNarration(sessionId: string | undefined, languageCode: string): CoachNarrationControls {
  const [snapshot, setSnapshot] = useState<NarrationSnapshot>(IDLE_SNAPSHOT);
  const playerRef = useRef<CoachNarrationPlayer | null>(null);

  useEffect(() => {
    setSnapshot(IDLE_SNAPSHOT);
    if (!sessionId) return undefined;
    const player = new CoachNarrationPlayer(
      {
        load: () => callCopilotService.getCoachNarration(sessionId, languageCode),
        speak: (text) => voiceService.speak(text, languageCode),
        describeError: describeNarrationError,
      },
      setSnapshot,
    );
    playerRef.current = player;
    return () => {
      player.destroy();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [sessionId, languageCode]);

  const start = useCallback(() => playerRef.current?.start(), []);
  const pause = useCallback(() => playerRef.current?.pause(), []);
  const resume = useCallback(() => playerRef.current?.resume(), []);
  const stop = useCallback(() => playerRef.current?.stop(), []);
  const replay = useCallback(() => playerRef.current?.replay(), []);
  return { ...snapshot, start, pause, resume, stop, replay };
}

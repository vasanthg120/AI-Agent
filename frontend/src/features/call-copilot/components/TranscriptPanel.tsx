import { useEffect, useRef } from 'react';
import styles from './TranscriptPanel.module.css';

// Auto-scrolls to the latest text as it arrives — same "live feed" UX as a
// chat transcript, just one continuously-growing block instead of discrete
// messages (a call has one speaker stream, not turns).
export function TranscriptPanel({ transcript, isRecording }: { transcript: string; isRecording: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [transcript]);

  return (
    <div className={styles.wrapper}>
      {transcript ? (
        <p className={styles.text}>{transcript}</p>
      ) : (
        <p className={styles.empty}>{isRecording ? 'Listening…' : 'Transcript will appear here once the call starts.'}</p>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

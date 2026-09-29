import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MotionConfig, motion } from 'framer-motion';
import { FiFolder, FiMic, FiRadio, FiUploadCloud, FiVolume2 } from 'react-icons/fi';
import { Button, PageHeader } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useCallSessionStore } from '@/stores/callSessionStore';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { EASE_OUT } from './motion';
import { LiveConsole, type LiveStatus } from './components/LiveConsole';
import { PillTabs } from './components/PillTabs';
import { StartHub } from './components/StartHub';
import type { SelectedCustomer } from './components/CustomerPicker';
import { CallSummaryModal } from './components/CallSummaryModal';
import { UploadRecordingModal } from './components/UploadRecordingModal';
import { CallLibraryListView } from './components/CallLibraryListView';
import { useSegmentedRecording, micErrorMessage } from './hooks/useSegmentedRecording';
import styles from './CallCopilotPage.module.css';

const LANGUAGE_STORAGE_KEY = 'haive-call-copilot-language';

function readStoredLanguage(): string {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && VOICE_LANGUAGES.some((l) => l.code === stored)) return stored;
  } catch {
    // localStorage can throw in a locked-down browser context — fall back silently.
  }
  return VOICE_LANGUAGES[0].code;
}

// Real-Time AI Sales Call Copilot — Listen -> Transcribe -> Understand ->
// Analyze -> Recommend -> Alert. The recording lifecycle (mic capture,
// segmented upload) lives in useSegmentedRecording; the call session's live
// state (transcript/events/recommendations/status) lives in
// useCallSessionStore, which owns the /call-copilot socket entirely — this
// component only renders what the store already has and issues start/stop.
export function CallCopilotPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('live');
  const [customer, setCustomer] = useState<SelectedCustomer | null>(null);
  const [language, setLanguage] = useState(readStoredLanguage);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [librarySwitch, setLibrarySwitch] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const {
    status,
    sessionId,
    sessionStartedAt,
    contextBlob,
    transcript,
    events,
    recommendations,
    sentiment,
    warning,
    error,
    summary,
    coaching,
    startCall,
    appendAudioSegment,
    endCall,
    reset,
  } = useCallSessionStore();

  const recording = useSegmentedRecording((blob, sequence) => {
    void appendAudioSegment(blob, sequence, language);
  });

  useEffect(() => {
    if (status === 'recording') {
      timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [status]);

  useEffect(() => {
    if (status === 'ended') setSummaryOpen(true);
  }, [status]);

  // Never leave a mic hot if the user navigates away mid-call.
  useEffect(() => {
    return () => {
      recording.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeLanguage = (code: string) => {
    setLanguage(code);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
    } catch {
      // Non-fatal — the selection still works for this session.
    }
  };

  const handleStart = async () => {
    setElapsedSeconds(0);
    // Mic access is confirmed BEFORE the call session is created — starting
    // the session first would leave an orphaned, never-ended (and never
    // billed-back) session server-side if the browser denies the mic prompt,
    // since recording.start() never throws and this page has no other way
    // to unwind an already-started session at that point.
    const micError = await recording.start();
    if (micError) return;
    startCall({ dealId: customer?.dealId, contextQuery: customer?.label ?? 'sales call' });
  };

  const handleEnd = () => {
    recording.stop();
    endCall();
  };

  const handleCloseSummary = () => {
    setSummaryOpen(false);
    reset();
    setCustomer(null);
    setElapsedSeconds(0);
  };

  const isIdle = status === 'idle' || status === 'error';
  const isLive = status === 'starting' || status === 'recording' || status === 'ending';
  const languageLabel = VOICE_LANGUAGES.find((l) => l.code === language)?.label ?? language;

  const startErrors = [recording.error ? micErrorMessage(recording.error) : null, error].filter(
    (message): message is string => !!message,
  );

  const openLibrary = () => {
    // A fresh mount of the library, so it loads the call that just finished.
    setLibrarySwitch((n) => n + 1);
    setActiveTab('library');
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className={styles.page}>
        <div className={styles.content}>
          <PageHeader
            icon={FiMic}
            title="Call Copilot"
            subtitle="Capture a call, get live suggestions while you talk, and review it with your AI Coach afterwards."
            actions={
              isIdle && (
                // Not shown mid-call: leaving the page stops the recording.
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    leftIcon={<FiVolume2 />}
                    onClick={() => navigate(ROUTES.settingsVoice)}
                  >
                    Voice &amp; Accent
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    leftIcon={<FiUploadCloud />}
                    onClick={() => setUploadModalOpen(true)}
                  >
                    Upload a Recording
                  </Button>
                </>
              )
            }
          />

          <PillTabs
            ariaLabel="Call Copilot sections"
            activeId={activeTab}
            onChange={setActiveTab}
            items={[
              { id: 'live', label: 'Live Call', icon: <FiRadio aria-hidden />, live: isLive },
              { id: 'library', label: 'Call Library', icon: <FiFolder aria-hidden /> },
            ]}
          />

          <>
            {activeTab === 'library' ? (
              <motion.div key="library" {...SCREEN}>
                <CallLibraryListView key={librarySwitch} onStartCall={() => setActiveTab('live')} />
              </motion.div>
            ) : isLive ? (
              <motion.div key="console" {...SCREEN}>
                <LiveConsole
                  status={status as LiveStatus}
                  elapsedSeconds={elapsedSeconds}
                  transcript={transcript}
                  events={events}
                  recommendations={recommendations}
                  sentiment={sentiment}
                  contextBlob={contextBlob}
                  warning={warning}
                  customerLabel={customer?.label}
                  languageLabel={languageLabel}
                  stream={recording.stream}
                  onEnd={handleEnd}
                />
              </motion.div>
            ) : (
              <motion.div key="hub" {...SCREEN}>
                <StartHub
                  customer={customer}
                  onCustomerChange={setCustomer}
                  language={language}
                  onLanguageChange={changeLanguage}
                  errors={startErrors}
                  onStart={() => void handleStart()}
                  onOpenUpload={() => setUploadModalOpen(true)}
                  onOpenLibrary={openLibrary}
                />
              </motion.div>
            )}
          </>
        </div>

        <CallSummaryModal
          open={summaryOpen}
          onClose={handleCloseSummary}
          source="live"
          summaryResult={summary}
          transcript={transcript}
          sessionId={sessionId ?? undefined}
          createdAt={sessionStartedAt ?? undefined}
          sentiment={sentiment}
          coachingPending={status === 'ended' && !coaching}
          coaching={coaching ?? undefined}
          onCoachingGenerated={(report) => useCallSessionStore.setState({ coaching: report })}
        />

        <UploadRecordingModal
          open={uploadModalOpen}
          onClose={() => setUploadModalOpen(false)}
          onProcessed={() => setLibrarySwitch((n) => n + 1)}
        />
      </div>
    </MotionConfig>
  );
}

// How one screen replaces another: a short fade with a small lift, so switching
// tabs or starting a call feels like moving between rooms, not a page reload.
const SCREEN = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.24, ease: EASE_OUT },
} as const;

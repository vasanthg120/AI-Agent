import { useEffect, useRef, useState } from 'react';
import { FiAlertCircle, FiMic, FiSquare, FiUploadCloud } from 'react-icons/fi';
import { Button, Card, SectionCard, Skeleton, StatTile, Tabs } from '@/components/ui';
import { useCallSessionStore } from '@/stores/callSessionStore';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { CustomerPicker, type SelectedCustomer } from './components/CustomerPicker';
import { CustomerContextCard } from './components/CustomerContextCard';
import { TranscriptPanel } from './components/TranscriptPanel';
import { EventsFeed } from './components/EventsFeed';
import { RecommendationsPanel } from './components/RecommendationsPanel';
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

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Real-Time AI Sales Call Copilot — Listen -> Transcribe -> Understand ->
// Analyze -> Recommend -> Alert. The recording lifecycle (mic capture,
// segmented upload) lives in useSegmentedRecording; the call session's live
// state (transcript/events/recommendations/status) lives in
// useCallSessionStore, which owns the /call-copilot socket entirely — this
// component only renders what the store already has and issues start/stop.
export function CallCopilotPage() {
  const [activeTab, setActiveTab] = useState('live');
  const [customer, setCustomer] = useState<SelectedCustomer | null>(null);
  const [language, setLanguage] = useState(readStoredLanguage);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [librarySwitch, setLibrarySwitch] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { status, contextBlob, transcript, events, recommendations, sentiment, warning, error, summary, startCall, appendAudioSegment, endCall, reset } =
    useCallSessionStore();

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

  const tabItems = [
    { id: 'live', label: 'Live Call' },
    { id: 'library', label: 'Call Library' },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.pageTitle}>Call Copilot</div>
          <div className={styles.pageSubtitle}>Live AI assistance during a sales call — transcript, signals, and recommendations as you talk.</div>
        </div>
        {activeTab === 'live' && isIdle && (
          <Button type="button" variant="secondary" leftIcon={<FiUploadCloud />} onClick={() => setUploadModalOpen(true)}>
            Upload a Recording
          </Button>
        )}
      </div>

      <Tabs items={tabItems} activeId={activeTab} onChange={setActiveTab} />

      {activeTab === 'library' && <CallLibraryListView key={librarySwitch} />}

      {activeTab === 'live' && (
        <>
          {isLive && (
            <div className={styles.statRow}>
              <StatTile label="Status" value={status === 'starting' ? 'Starting…' : status === 'ending' ? 'Ending…' : 'Recording'} />
              <StatTile label="Duration" value={formatDuration(elapsedSeconds)} />
              <StatTile label="Events Detected" value={events.length} />
              <StatTile label="Sentiment" value={sentiment ?? '—'} />
            </div>
          )}

          {isIdle && (
            <Card className={styles.startCard}>
              <CustomerPicker value={customer} onChange={setCustomer} />
              <label className={styles.languageRow}>
                <span>Language</span>
                <select className={styles.select} value={language} onChange={(e) => changeLanguage(e.target.value)}>
                  {VOICE_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              {recording.error && (
                <div className={styles.errorBox} role="alert">
                  <FiAlertCircle size={16} />
                  <span>{micErrorMessage(recording.error)}</span>
                </div>
              )}
              {error && (
                <div className={styles.errorBox} role="alert">
                  <FiAlertCircle size={16} />
                  <span>{error}</span>
                </div>
              )}
              <Button type="button" leftIcon={<FiMic />} onClick={() => void handleStart()}>
                Record
              </Button>
            </Card>
          )}

          {isLive && (
            <>
              {warning && (
                <div className={styles.warningBox} role="status">
                  <FiAlertCircle size={14} /> {warning}
                </div>
              )}

              <div className={styles.grid}>
                <div className={styles.mainColumn}>
                  <SectionCard title="Live Transcript">
                    <TranscriptPanel transcript={transcript} isRecording={status === 'recording'} />
                  </SectionCard>
                  <SectionCard title="Recommendations">
                    <RecommendationsPanel recommendations={recommendations} />
                  </SectionCard>
                </div>
                <div className={styles.sideColumn}>
                  <SectionCard title="Customer Context">
                    {contextBlob === '' && status === 'starting' ? <Skeleton height={80} /> : <CustomerContextCard contextBlob={contextBlob} />}
                  </SectionCard>
                  <SectionCard title="Detected Signals">
                    <EventsFeed events={events} />
                  </SectionCard>
                </div>
              </div>

              <div className={styles.endBar}>
                <Button type="button" variant="danger" leftIcon={<FiSquare />} onClick={handleEnd} disabled={status === 'ending'}>
                  End Call
                </Button>
              </div>
            </>
          )}
        </>
      )}

      <CallSummaryModal open={summaryOpen} onClose={handleCloseSummary} source="live" summaryResult={summary} transcript={transcript} events={events} sentiment={sentiment} />

      <UploadRecordingModal
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onProcessed={() => setLibrarySwitch((n) => n + 1)}
      />
    </div>
  );
}

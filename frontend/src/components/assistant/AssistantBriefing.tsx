import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { FiArrowRight, FiCheckCircle, FiMic, FiRefreshCw, FiSquare, FiVolume2, FiVolumeX } from 'react-icons/fi';
import { assistantService, type BriefingAction, type BriefingView } from '@/services/assistantService';
import { useAssistantStore, type AssistantVoiceState } from '@/stores/assistantStore';
import { useChatStore } from '@/stores/chatStore';
import { extractErrorMessage } from '@/utils/errors';
import { assistantVoice } from './AssistantVoice';
import { FigureText, pointSpoken } from './FigureText';
import styles from './AssistantBriefing.module.css';

const KIND_LABEL: Record<string, string> = { actual: 'Actual', estimate: 'Estimate', forecast: 'Forecast', recommendation: 'Advice' };

export const STATUS_TEXT: Record<AssistantVoiceState, string> = {
  idle: 'Ready to help',
  listening: 'Listening…',
  transcribing: 'Got it — one moment…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
};

/** Questions Haive offers before a briefing names its own (the AI Conversations defaults). */
export const DEFAULT_QUESTIONS = [
  'How is our revenue pipeline performing?',
  'Which sales opportunities need attention?',
  'Which customers have pending quotations?',
  'What should our sales team prioritise today?',
];

/** Today's briefing: what Haive said, the points behind it (each marked actual, forecast or advice), and the next step. */
export function BriefingCard({ briefing, compact }: { briefing: BriefingView; compact?: boolean }) {
  const voiceState = useAssistantStore((s) => s.voiceState);
  // Voice switched off in AI Conversations settings: the briefing is read, not heard.
  const voiceEnabled = useAssistantStore((s) => s.settings?.voiceEnabled !== false);
  const queryClient = useQueryClient();
  const [updating, setUpdating] = useState(false);
  const b = briefing.briefing;
  const speaking = voiceState === 'speaking';

  // While Haive speaks this briefing, the point it's talking about lights up and its figures count up.
  const caption = useAssistantStore((s) => s.caption);
  const pointTexts = useMemo(() => b.points.map((p) => `${p.business} ${p.text}`), [b.points]);
  const spokenPoint = speaking ? pointSpoken(pointTexts, caption) : -1;
  const [runs, setRuns] = useState<Record<number, number>>({});
  const pointRefs = useRef<Array<HTMLLIElement | null>>([]);
  useEffect(() => {
    if (spokenPoint < 0) return;
    setRuns((r) => ({ ...r, [spokenPoint]: (r[spokenPoint] ?? 0) + 1 }));
    // Brought into view as Haive reaches it.
    pointRefs.current[spokenPoint]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [spokenPoint]);

  const hear = async () => {
    if (speaking) return assistantVoice.stopSpeaking();
    // From the welcome screen: open today's briefing conversation first, so a follow-up continues it.
    if (useChatStore.getState().activeConversationId !== briefing.conversationId) await useChatStore.getState().selectConversation(briefing.conversationId);
    assistantVoice.speakBriefing();
  };

  const update = async () => {
    setUpdating(true);
    try {
      const fresh = await assistantService.getBriefing(true);
      queryClient.setQueryData(['assistant-briefing'], fresh);
      useAssistantStore.getState().setBriefing(fresh);
      await useChatStore.getState().selectConversation(fresh.conversationId);
      assistantVoice.speakBriefing();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setUpdating(false);
    }
  };

  return (
    <section className={clsx(styles.card, compact && styles.compact)} aria-label={briefing.label ?? 'Today’s briefing'}>
      <div className={styles.cardHead}>
        <span className={styles.eyebrow}>{briefing.label ?? 'Today’s briefing'}</span>
        <div className={styles.cardActions}>
          <button type="button" className={styles.iconButton} onClick={() => void update()} disabled={updating} title="Write it again from the latest figures" aria-label="Update the briefing">
            <FiRefreshCw className={clsx(updating && styles.spin)} aria-hidden />
          </button>
          {voiceEnabled && (
            <button type="button" className={clsx(styles.play, speaking && styles.playing)} onClick={() => void hear()}>
              {speaking ? <FiSquare aria-hidden /> : <FiVolume2 aria-hidden />}
              {speaking ? 'Stop' : 'Hear it'}
            </button>
          )}
        </div>
      </div>
      <p className={styles.headline}>{b.headline}</p>
      {!compact && <p className={styles.spoken}>{b.spoken}</p>}
      {b.points.length > 0 && (
        <ul className={styles.points}>
          {b.points.map((p, i) => (
            <li
              key={i}
              ref={(node) => {
                pointRefs.current[i] = node;
              }}
              className={clsx(styles[`sev_${p.severity}`], i === spokenPoint && styles.pointSpoken)}
              style={{ '--i': i } as React.CSSProperties}
            >
              <span className={styles.dot} aria-hidden />
              <span className={styles.pointText}>
                {p.business && <strong>{p.business}: </strong>}
                <FigureText text={p.text} run={runs[i] ?? 0} />
              </span>
              <span className={clsx(styles.kind, styles[`kind_${p.kind}`])} title="Actual = recorded; Forecast = projected; Advice = a recommendation">
                {KIND_LABEL[p.kind] ?? p.kind}
              </span>
            </li>
          ))}
        </ul>
      )}
      {b.nextAction && !compact && (
        <p className={styles.next}>
          <FiArrowRight aria-hidden />
          <span>
            <strong>Do first: {b.nextAction.text}</strong> — {b.nextAction.why}
          </span>
        </p>
      )}
      {!compact && (b.actions ?? []).some((a) => a.status !== 'dismissed') && (
        <div className={styles.suggestions} role="group" aria-label="Haive suggests">
          {b.actions
            .filter((a) => a.status !== 'dismissed')
            .map((a) => (
              <SuggestedAction key={a.id} action={a} />
            ))}
        </div>
      )}
    </section>
  );
}

/** One thing Haive offers to do: done only on "Do it" (or a spoken yes), and called done only when it is. */
function SuggestedAction({ action }: { action: BriefingAction }) {
  if (action.status === 'done') {
    return (
      <p className={clsx(styles.suggestion, styles.suggestionDone)} role="status">
        <FiCheckCircle aria-hidden /> <span>Done — {action.result}</span>
      </p>
    );
  }
  const running = action.status === 'running';
  return (
    <div className={styles.suggestion}>
      <span className={styles.suggestionText}>
        <small>Haive suggests · due {action.due}</small>
        {action.label}
        {action.error && <em className={styles.suggestionError}>{action.error}</em>}
      </span>
      <span className={styles.suggestionButtons}>
        <button type="button" className={styles.doIt} onClick={() => void assistantVoice.runAction(action.id)} disabled={running}>
          {running ? 'Doing it…' : 'Do it'}
        </button>
        <button type="button" className={styles.notNow} onClick={() => void assistantVoice.dismissAction(action.id)} disabled={running}>
          Not now
        </button>
      </span>
    </div>
  );
}

/** Ask Haive something: one tap sends the question in the current conversation (answered aloud when voice is on). */
export function SuggestedQuestions({ questions, onAsk }: { questions: string[]; onAsk: (q: string) => void }) {
  if (questions.length === 0) return null;
  return (
    <div className={styles.questions} aria-label="Suggested questions">
      {questions.map((q) => (
        <button key={q} type="button" className={styles.question} onClick={() => onAsk(q)}>
          {q}
        </button>
      ))}
    </div>
  );
}

/** Tap to talk (tap again, or just stop speaking, to finish); tap while Haive speaks to interrupt; mute. */
export function VoiceControls() {
  const voiceState = useAssistantStore((s) => s.voiceState);
  const voiceOn = useAssistantStore((s) => s.voiceOn);
  const [level, setLevel] = useState(0);
  const listening = voiceState === 'listening';
  const busy = voiceState === 'transcribing' || voiceState === 'thinking';

  return (
    <div className={styles.controls}>
      <button
        type="button"
        className={clsx(styles.mic, listening && styles.micListening, voiceState === 'speaking' && styles.micSpeaking)}
        style={{ ['--level' as string]: String(Math.min(1, level * 8)) }}
        onClick={() => void assistantVoice.talk(setLevel)}
        disabled={busy}
        aria-label={listening ? 'Finish speaking' : voiceState === 'speaking' ? 'Interrupt and speak' : 'Speak to Haive'}
        title={listening ? 'Finish' : voiceState === 'speaking' ? 'Interrupt and speak' : 'Tap and speak'}
      >
        <FiMic aria-hidden />
      </button>
      <span className={styles.status} aria-live="polite">
        {STATUS_TEXT[voiceState]}
        {voiceState === 'idle' && <small>Tap the mic and ask anything about your business</small>}
      </span>
      {voiceState === 'speaking' && (
        <button type="button" className={styles.stop} onClick={() => assistantVoice.stopSpeaking()}>
          <FiSquare aria-hidden /> Stop
        </button>
      )}
      <button
        type="button"
        className={styles.iconButton}
        onClick={() => {
          if (voiceOn) assistantVoice.stopSpeaking();
          useAssistantStore.getState().setVoiceOn(!voiceOn);
        }}
        aria-pressed={!voiceOn}
        aria-label={voiceOn ? 'Mute Haive' : 'Let Haive speak'}
        title={voiceOn ? 'Mute — answers shown, not spoken' : 'Speak answers out loud'}
      >
        {voiceOn ? <FiVolume2 aria-hidden /> : <FiVolumeX aria-hidden />}
      </button>
    </div>
  );
}

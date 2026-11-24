// Call Intelligence — what every call sends to the one evaluation engine
// (python-agent's /call-copilot/evaluate, app/agent/call_intelligence.py).
// Live calls, uploaded recordings and phone calls recorded through Call Copilot
// all go through it the same way; only how each knows *when* something was
// said, and *who* said it, differs — and that is worked out here.

/** The three kinds of recording (the spec's "categories"), one evaluation. */
export type RecordingCategory = 'live' | 'upload' | 'phone';

export const RECORDING_LABEL: Record<RecordingCategory, string> = {
  live: 'Live call',
  upload: 'Uploaded recording',
  phone: 'Phone call recorded through Call Copilot',
};

/** A line of the transcript as the evaluation reads it: its id, time into the call (seconds), speaker. */
export interface TranscriptLine {
  id: string;
  at: number | null;
  speaker: string | null;
  text: string;
}

interface SegmentLike {
  sequence: number;
  text?: string;
  speaker?: string;
  recordedAt?: Date;
  startSeconds?: number;
  endSeconds?: number;
}

interface SessionLike {
  source: 'live' | 'upload';
  originalFilename?: string;
  createdAt?: Date;
  endedAt?: Date;
  transcript: SegmentLike[];
}

/** A phone call through Plivo or Twilio is stored like an upload, named after its provider. */
export function recordingCategory(session: Pick<SessionLike, 'source' | 'originalFilename'>): RecordingCategory {
  if (session.source === 'live') return 'live';
  return /^(plivo|twilio)-/.test(session.originalFilename ?? '') ? 'phone' : 'upload';
}

// A recording transcribed without speaker separation comes back as one long
// piece; cut into lines of about this many words so a quote points somewhere useful.
const MAX_LINE_WORDS = 60;

function splitLong(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_LINE_WORDS * 1.5) return [text];
  const sentences = text.match(/[^.!?।]+[.!?।]+|\S[^.!?।]*$/g) ?? [text];
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence.trim()}` : sentence.trim();
    if (current && next.split(/\s+/).length > MAX_LINE_WORDS) {
      out.push(current);
      current = sentence.trim();
    } else current = next;
  }
  if (current) out.push(current);
  return out;
}

/**
 * The transcript as numbered lines, in order, with when each was said:
 *  - an uploaded or phone recording: the start time Sarvam gives each speaker turn;
 *  - a live call: when the previous piece of audio arrived (each piece is recorded
 *    one after another from the start of the call), so the first starts at 0:00.
 * Speakers are Sarvam's labels ("0", "1") when the recording separated them; a live
 * call (one microphone) has none.
 */
export function transcriptLines(session: SessionLike): TranscriptLine[] {
  const segments = [...session.transcript].sort((a, b) => a.sequence - b.sequence);
  const live = session.source === 'live';
  const start = session.createdAt?.getTime();
  const lines: TranscriptLine[] = [];
  let previousArrival: number | undefined;
  for (const seg of segments) {
    const arrival = seg.recordedAt instanceof Date ? seg.recordedAt.getTime() : undefined;
    let at: number | null = null;
    if (typeof seg.startSeconds === 'number') at = Math.round(seg.startSeconds * 10) / 10;
    else if (live && start !== undefined) at = previousArrival === undefined ? 0 : Math.max(0, Math.round((previousArrival - start) / 1000));
    if (arrival !== undefined) previousArrival = arrival;
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    splitLong(text).forEach((part, i) => {
      lines.push({ id: `L${lines.length + 1}`, at: i === 0 ? at : null, speaker: seg.speaker ?? null, text: part });
    });
  }
  return lines;
}

/** Whether the recording told speakers apart (two or more speaker labels). */
export function speakersSeparated(session: SessionLike): boolean {
  return new Set(session.transcript.map((s) => s.speaker).filter((s): s is string => !!s)).size >= 2;
}

/** How long the call was, in seconds, as far as the recording shows. */
export function callDurationSeconds(session: SessionLike): number | null {
  const ends = session.transcript.map((s) => s.endSeconds ?? s.startSeconds).filter((n): n is number => typeof n === 'number');
  if (ends.length) return Math.round(Math.max(...ends));
  if (session.source === 'live' && session.createdAt && session.endedAt) return Math.max(0, Math.round((session.endedAt.getTime() - session.createdAt.getTime()) / 1000));
  return null;
}

/** The evaluation as it is stored on the call (see app/agent/call_intelligence.py `finish`). */
export interface CallEvaluation {
  version: number;
  assessable: boolean;
  notAssessableReason?: string | null;
  score: number | null;
  band: string;
  bandLabel: string;
  coverage: number;
  lowCoverage?: boolean;
  categories: { key: string; label: string; weight: number; assessable: boolean; score: number | null }[];
  [more: string]: unknown;
}

/** What /call-copilot/evaluate answers: the report, and the same report in the AI Coach's earlier fields. */
export interface EvaluateReply {
  evaluation: CallEvaluation;
  categoryScores: { category: string; score: number; rationale: string }[];
  overallScore: number | null;
  whatWentWell: string[];
  whatToImprove: string[];
  whatWouldHaveDoneDifferently: string[];
  nextCallFocus: string[];
  keyMoments: { momentType: string; text: string; recommendation: string; at?: number | null }[];
  coachingSummary: string;
  voiceScript: string;
}

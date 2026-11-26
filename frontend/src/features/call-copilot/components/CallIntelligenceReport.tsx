import { createContext, useContext, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiAlertOctagon,
  FiAlertTriangle,
  FiArrowRight,
  FiCheck,
  FiCheckCircle,
  FiChevronDown,
  FiCompass,
  FiFlag,
  FiHelpCircle,
  FiList,
  FiPlay,
  FiShield,
  FiTarget,
  FiTrendingUp,
  FiUser,
  FiX,
} from 'react-icons/fi';
import type { CallEvaluation, EvaluationEvidence, EvaluationOutcome } from '@/services/callCopilotService';
import { EASE_OUT, FADE_UP, SPRING_SOFT, staggerChildren } from '../motion';
import styles from './CallIntelligenceReport.module.css';

// Call Intelligence: the one report every call gets — live, uploaded or a phone
// call — scored like a demanding sales manager would (see python-agent
// app/agent/call_intelligence.py). The score is earned: every mark rests on a
// quote checked against the transcript, a quality review looked for generosity
// before it was saved, and a category the call gave no chance to show is "Not
// assessable" rather than guessed.

const BAND_TONE: Record<CallEvaluation['band'], 'top' | 'good' | 'mid' | 'low' | 'bad' | 'muted'> = {
  exceptional: 'top',
  very_good: 'good',
  good: 'good',
  average: 'mid',
  poor: 'low',
  critical: 'bad',
  not_assessable: 'muted',
};

const OUTCOME_LABEL: Record<EvaluationOutcome, string> = {
  sale_confirmed: 'Sale confirmed',
  strong_progress: 'Strong progress',
  next_step_agreed: 'Next step agreed',
  information_only: 'Information only',
  no_progress: 'No progress',
  lost: 'Lost',
  cut_short: 'Call cut short',
  not_a_sales_call: 'Not a sales call',
  unclear: 'Unclear',
};

const MISSED_LABEL: Record<string, string> = {
  unanswered_question: 'Question left unanswered',
  missed_buying_signal: 'Buying signal missed',
  unhandled_objection: 'Objection not handled',
  missing_follow_up: 'No follow-up',
  value_not_explained: 'Value not explained',
  no_meaningful_outcome: 'No real outcome',
  other: 'Missed opportunity',
};

const CHECK_LABEL: Record<string, string> = {
  score_matches_conversation: 'The score matches the conversation',
  high_scores_supported: 'High marks are backed by evidence',
  negatives_identified: 'Problems are all identified',
  feedback_matches_transcript: 'Feedback matches the transcript',
  outcome_separate_from_performance: 'Outcome kept apart from performance',
  no_unsupported_assumptions: 'No unsupported assumptions',
  recommendations_relevant: 'Recommendations fit this call',
};

/** A review's 0–100 as the app shows scores everywhere: out of 10, one decimal at most ("3.4", "7"). */
export function outOf10(score100: number): string {
  return String(Math.round(score100) / 10);
}

/** "01:42" — time into the call. */
export function clock(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Jumps the call's recording to a moment (CallSummaryModal opens the Transcript tab and plays from
// there). Absent — no recording, or the Dialer — the times are plain labels.
const SeekContext = createContext<((seconds: number) => void) | null>(null);

/** A time into the call; a button that plays the recording from there when the recording can be played. */
function Time({ at }: { at: number | null | undefined }) {
  const seek = useContext(SeekContext);
  const label = clock(at);
  if (!label) return null;
  if (!seek) return <span className={styles.time}>{label}</span>;
  return (
    <button type="button" className={clsx(styles.time, styles.timeSeek)} onClick={() => seek(at!)} aria-label={`Play the recording from ${label}`} title="Play the recording from here">
      <FiPlay aria-hidden /> {label}
    </button>
  );
}

/** "Agent (Speaker 1)" when the evaluation worked out who that speaker is. */
function useSpeakerNames(evaluation: CallEvaluation): (label: string | null | undefined) => string | null {
  const roles = new Map((evaluation.understanding?.speakers ?? []).map((s) => [s.label, s.role]));
  return (label) => {
    if (!label || label === 'Unlabelled') return null;
    const role = roles.get(label);
    if (role === 'agent') return `Agent (${label})`;
    if (role === 'customer') return `Customer (${label})`;
    return label;
  };
}

function Evidence({ evidence, speaker }: { evidence: EvaluationEvidence; speaker: (label: string) => string | null }) {
  const time = clock(evidence.at);
  const who = speaker(evidence.speaker);
  return (
    <blockquote className={clsx(styles.quote, evidence.judgement === 'negative' && styles.quoteNegative)}>
      {(time || who) && (
        <span className={styles.quoteMeta}>
          {time && <Time at={evidence.at} />}
          {who && <span>{who}</span>}
        </span>
      )}
      <span className={styles.quoteText}>“{evidence.quote}”</span>
    </blockquote>
  );
}

function Section({ icon, title, hint, tone, children }: { icon: ReactNode; title: string; hint?: string; tone?: 'good' | 'bad' | 'warn' | 'info'; children: ReactNode }) {
  return (
    <motion.section variants={FADE_UP} className={clsx(styles.card, tone && styles[`card_${tone}`])}>
      <h4 className={styles.cardTitle}>
        <span className={styles.cardIcon} aria-hidden>
          {icon}
        </span>
        {title}
        {hint && <span className={styles.cardHint}>{hint}</span>}
      </h4>
      {children}
    </motion.section>
  );
}

export function CallIntelligenceReport({
  evaluation,
  voice,
  actions,
  onSeek,
}: {
  evaluation: CallEvaluation;
  voice?: ReactNode;
  actions?: ReactNode;
  // Play the call's recording from a moment (the report's quote and moment times become buttons).
  onSeek?: (seconds: number) => void;
}) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const speaker = useSpeakerNames(evaluation);
  const tone = BAND_TONE[evaluation.band] ?? 'muted';
  // Every section there even if a report was saved without one (an answer the AI cut short).
  const given = evaluation.conclusion ?? ({} as Partial<CallEvaluation['conclusion']>);
  const conclusion: CallEvaluation['conclusion'] = {
    outcome: given.outcome ?? undefined,
    verdict: given.verdict ?? '',
    summaryForAgent: given.summaryForAgent ?? '',
    strengths: given.strengths ?? [],
    weaknesses: given.weaknesses ?? [],
    coaching: given.coaching ?? [],
    nextActions: given.nextActions ?? [],
  };
  const challenge: CallEvaluation['challenge'] = {
    missedOpportunities: evaluation.challenge?.missedOpportunities ?? [],
    seriousConcerns: evaluation.challenge?.seriousConcerns ?? [],
    expertWouldHaveDone: evaluation.challenge?.expertWouldHaveDone ?? [],
  };
  const analysis = evaluation.analysis;
  const qa: CallEvaluation['qa'] = {
    reviewed: evaluation.qa?.reviewed ?? false,
    quotesChecked: evaluation.qa?.quotesChecked ?? 0,
    quotesDropped: evaluation.qa?.quotesDropped ?? 0,
    checks: evaluation.qa?.checks ?? [],
    adjustments: evaluation.qa?.adjustments ?? [],
  };
  const lowered = qa.adjustments.filter((a) => a.category && a.to !== null && a.from !== null && a.to < a.from);
  const raised = qa.adjustments.filter((a) => a.category && a.to !== null && a.from !== null && a.to > a.from);
  const capsOnTotal = qa.adjustments.filter((a) => !a.category && a.to !== null);
  const separated = evaluation.recording?.speakersSeparated;
  const duration = clock(evaluation.recording?.durationSeconds ?? null);

  return (
    <SeekContext.Provider value={onSeek ?? null}>
    <motion.div className={styles.report} variants={staggerChildren(0.06)} initial="hidden" animate="show">
      {/* ---- the verdict ---- */}
      <motion.section variants={FADE_UP} className={clsx(styles.hero, styles[`tone_${tone}`])}>
        {/* Out of 10, as every list and average shows it (the review works in 0–100; the dial fills by it). */}
        <div className={styles.dial} style={{ ['--pct' as string]: `${evaluation.score ?? 0}%` }} aria-label={evaluation.score === null ? 'Not assessable' : `Score ${outOf10(evaluation.score)} out of 10`}>
          <span className={styles.dialValue}>{evaluation.score === null ? '—' : outOf10(evaluation.score)}</span>
          <span className={styles.dialOutOf}>/10</span>
        </div>
        <div className={styles.heroText}>
          <span className={clsx(styles.band, styles[`band_${tone}`])}>{evaluation.bandLabel}</span>
          <p className={styles.verdict}>{evaluation.assessable ? conclusion.verdict : evaluation.notAssessableReason}</p>
          <div className={styles.facts}>
            {evaluation.recording?.categoryLabel && <span className={styles.fact}>{evaluation.recording.categoryLabel}</span>}
            {duration && <span className={styles.fact}>{duration}</span>}
            <span className={styles.fact} title={separated ? 'The recording separated the speakers.' : 'One microphone: who said what was worked out from the words.'}>
              {separated ? 'Speakers separated' : 'Speakers inferred'}
            </span>
            {evaluation.assessable && (
              <span className={clsx(styles.fact, evaluation.lowCoverage && styles.factWarn)} title="The share of the scorecard's weight this call gave a fair chance to judge.">
                Judged on {evaluation.coverage}% of the scorecard
              </span>
            )}
            {qa.reviewed && (
              <span className={styles.fact} title="A second, stricter review checked the marks against the transcript before this report was saved.">
                <FiShield aria-hidden /> Quality-checked
                {lowered.length > 0 ? ` · ${lowered.length} mark${lowered.length === 1 ? '' : 's'} lowered` : ''}
              </span>
            )}
          </div>
          {evaluation.lowCoverage && <p className={styles.coverageNote}>Too little of this call could be judged for the score to say much — read the notes below.</p>}
          {voice}
          {actions}
        </div>
      </motion.section>

      {!evaluation.assessable ? null : (
        <>
          {challenge.seriousConcerns.length > 0 && (
            <motion.section variants={FADE_UP} className={styles.alert} role="note">
              <FiAlertOctagon aria-hidden />
              <div>
                <strong>Serious concern{challenge.seriousConcerns.length > 1 ? 's' : ''}</strong>
                {challenge.seriousConcerns.map((c, i) => (
                  <div key={i} className={styles.alertItem}>
                    <p>{c.text}</p>
                    <Evidence evidence={c.evidence} speaker={speaker} />
                  </div>
                ))}
              </div>
            </motion.section>
          )}

          {/* ---- outcome is not performance ---- */}
          {conclusion.outcome && (
            <motion.section variants={FADE_UP} className={styles.outcome}>
              <div className={styles.outcomeBlock}>
                <span className={styles.outcomeLabel}>
                  <FiFlag aria-hidden /> Business outcome
                </span>
                <strong>{OUTCOME_LABEL[conclusion.outcome.result] ?? conclusion.outcome.result}</strong>
                <p>{conclusion.outcome.explanation}</p>
              </div>
              <div className={styles.outcomeBlock}>
                <span className={styles.outcomeLabel}>
                  <FiUser aria-hidden /> The agent’s performance
                </span>
                <strong>{evaluation.bandLabel}</strong>
                <p>{conclusion.outcome.performanceVsOutcome}</p>
              </div>
            </motion.section>
          )}

          {/* ---- the scorecard ---- */}
          <Section icon={<FiList />} title="Scorecard" hint="Each skill out of 10, weighted into the score · select a row for the evidence">
            <ul className={styles.scorecard}>
              {evaluation.categories.map((c, index) => {
                const open = openCategory === c.key;
                const changes = qa.adjustments.filter((a) => a.category === c.key);
                const barTone = c.score === null ? 'muted' : c.score >= 8 ? 'good' : c.score >= 6 ? 'mid' : c.score >= 4 ? 'low' : 'bad';
                return (
                  <li key={c.key} className={styles.row}>
                    <button type="button" className={styles.rowButton} aria-expanded={open} onClick={() => setOpenCategory(open ? null : c.key)}>
                      <span className={styles.rowName}>
                        {c.label}
                        <span className={styles.weight}>{c.weight}%</span>
                      </span>
                      {c.score === null ? (
                        <span className={styles.notAssessable}>Not assessable</span>
                      ) : (
                        <>
                          <span className={styles.track}>
                            <motion.span
                              className={clsx(styles.fill, styles[`fill_${barTone}`])}
                              initial={{ width: 0 }}
                              animate={{ width: `${c.score * 10}%` }}
                              transition={{ duration: 0.8, ease: EASE_OUT, delay: 0.15 + index * 0.05 }}
                            />
                          </span>
                          <span className={styles.rowScore}>
                            {c.score}
                            <small>/10</small>
                          </span>
                        </>
                      )}
                      <FiChevronDown className={clsx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
                    </button>
                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div className={styles.rowBody} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SPRING_SOFT}>
                          <p>{c.score === null ? c.notAssessableReason : c.rationale}</p>
                          {c.evidence.map((e, i) => (
                            <Evidence key={i} evidence={e} speaker={speaker} />
                          ))}
                          {changes.map((a, i) => (
                            <p key={i} className={styles.change}>
                              <FiShield aria-hidden /> {a.by === 'rule' ? 'Scoring rule' : 'Quality review'}:{' '}
                              {a.to === null ? 'made not assessable' : `${a.from} → ${a.to}`} — {a.reason}
                            </p>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ul>
            {capsOnTotal.length > 0 && (
              <ul className={styles.caps}>
                {capsOnTotal.map((a, i) => (
                  <li key={i}>
                    <FiShield aria-hidden /> Overall held at {outOf10(a.to!)}/10: {a.reason}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* ---- strengths and weaknesses ---- */}
          <div className={styles.twoCol}>
            <Section icon={<FiCheck />} title="Strengths" tone="good">
              {conclusion.strengths.length === 0 ? (
                <p className={styles.empty}>Nothing stood out enough to count as a strength.</p>
              ) : (
                <ul className={styles.items}>
                  {conclusion.strengths.map((s, i) => (
                    <li key={i}>
                      <p>{s.text}</p>
                      <Evidence evidence={s.evidence} speaker={speaker} />
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section icon={<FiAlertTriangle />} title="Critical weaknesses" tone="bad">
              {conclusion.weaknesses.length === 0 ? (
                <p className={styles.empty}>No weaknesses worth flagging.</p>
              ) : (
                <ul className={styles.items}>
                  {[...conclusion.weaknesses]
                    .sort((a, b) => ['critical', 'major', 'minor'].indexOf(a.severity) - ['critical', 'major', 'minor'].indexOf(b.severity))
                    .map((w, i) => (
                      <li key={i}>
                        <p>
                          <span className={clsx(styles.severity, styles[`sev_${w.severity}`])}>{w.severity}</span> {w.text}
                        </p>
                        {w.impact && <p className={styles.impact}>Impact: {w.impact}</p>}
                        {w.evidence && <Evidence evidence={w.evidence} speaker={speaker} />}
                      </li>
                    ))}
                </ul>
              )}
            </Section>
          </div>

          {challenge.missedOpportunities.length > 0 && (
            <Section icon={<FiCompass />} title="Missed opportunities" tone="warn">
              <ul className={styles.items}>
                {challenge.missedOpportunities.map((m, i) => (
                  <li key={i}>
                    <p>
                      <span className={styles.kind}>{MISSED_LABEL[m.kind] ?? 'Missed opportunity'}</span>
                      <Time at={m.at} /> {m.text}
                    </p>
                    {m.evidence && <Evidence evidence={m.evidence} speaker={speaker} />}
                    {m.betterApproach && (
                      <p className={styles.better}>
                        <FiArrowRight aria-hidden /> {m.betterApproach}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* ---- what happened in the conversation ---- */}
          {analysis && (
            <Section icon={<FiTrendingUp />} title="The conversation">
              <div className={styles.signals}>
                <div className={styles.signal}>
                  <span className={styles.signalLabel}>Customer engagement</span>
                  <strong className={styles[`level_${analysis.customerEngagement.level}`]}>{analysis.customerEngagement.level}</strong>
                  <p>{analysis.customerEngagement.basis}</p>
                </div>
                <div className={styles.signal}>
                  <span className={styles.signalLabel}>Customer sentiment</span>
                  <strong>
                    {analysis.customerSentiment.start} → {analysis.customerSentiment.end}
                  </strong>
                  <p>{analysis.customerSentiment.basis}</p>
                </div>
              </div>
              {analysis.objections.length > 0 && (
                <SignalList
                  title="Objections"
                  rows={analysis.objections.map((o) => ({
                    at: o.at,
                    text: o.objection,
                    note: o.how,
                    state: o.handling === 'well' ? 'good' : o.handling === 'partly' ? 'mid' : 'bad',
                    stateLabel: o.handling === 'well' ? 'Handled' : o.handling === 'partly' ? 'Partly handled' : 'Not handled',
                  }))}
                />
              )}
              {analysis.buyingSignals.length > 0 && (
                <SignalList
                  title="Buying signals"
                  rows={analysis.buyingSignals.map((b) => ({ at: b.at, text: b.signal, state: b.actedOn ? 'good' : 'bad', stateLabel: b.actedOn ? 'Acted on' : 'Missed' }))}
                />
              )}
              {analysis.customerQuestions.some((q) => q.answered !== 'yes') && (
                <SignalList
                  title="Customer questions not fully answered"
                  rows={analysis.customerQuestions
                    .filter((q) => q.answered !== 'yes')
                    .map((q) => ({ at: q.at, text: q.question, state: q.answered === 'partly' ? 'mid' : 'bad', stateLabel: q.answered === 'partly' ? 'Partly' : 'Unanswered' }))}
                />
              )}
            </Section>
          )}

          {/* ---- what to do ---- */}
          {conclusion.coaching.length > 0 && (
            <Section icon={<FiTarget />} title="Coaching" tone="info">
              <ol className={styles.coaching}>
                {conclusion.coaching.map((c, i) => (
                  <li key={i}>
                    <strong>{c.change}</strong>
                    <p>{c.how}</p>
                    {c.example && <p className={styles.say}>Try saying: “{c.example}”</p>}
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {conclusion.nextActions.length > 0 && (
            <Section icon={<FiFlag />} title="Recommended next actions" hint="Still to do">
              <ul className={styles.actions}>
                {conclusion.nextActions.map((a, i) => (
                  <li key={i}>
                    <span className={clsx(styles.priority, styles[`prio_${a.priority}`])}>{a.priority}</span>
                    <span className={styles.actionText}>
                      {a.text}
                      <small>
                        {a.owner === 'agent' ? 'You' : a.owner === 'customer' ? 'The customer' : 'A manager'} · {a.basis}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* ---- how this report was checked ---- */}
          <motion.section variants={FADE_UP} className={styles.qa}>
            <button type="button" className={styles.qaToggle} aria-expanded={showChecks} onClick={() => setShowChecks((v) => !v)}>
              <FiShield aria-hidden /> How this report was checked
              <FiChevronDown className={clsx(styles.chevron, showChecks && styles.chevronOpen)} aria-hidden />
            </button>
            {showChecks && (
              <div className={styles.qaBody}>
                <p>
                  {qa.quotesChecked} quote{qa.quotesChecked === 1 ? '' : 's'} checked against the transcript
                  {qa.quotesDropped ? `; ${qa.quotesDropped} couldn’t be found word for word and ${qa.quotesDropped === 1 ? 'was' : 'were'} left out` : ' — all found'}.
                  {lowered.length + raised.length > 0 && ` ${lowered.length + raised.length} mark${lowered.length + raised.length === 1 ? '' : 's'} changed by the scoring rules or the review (open a scorecard row to see why).`}
                  {!qa.reviewed && ' The quality review could not run this time; the scoring rules were still applied.'}
                </p>
                {qa.checks.length > 0 && (
                  <ul className={styles.checks}>
                    {qa.checks.map((c, i) => (
                      <li key={i}>
                        {c.passed ? <FiCheckCircle className={styles.pass} aria-hidden /> : <FiX className={styles.fail} aria-hidden />}
                        <span>
                          {CHECK_LABEL[c.check] ?? c.check}
                          {c.note && <small> — {c.note}</small>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </motion.section>
        </>
      )}
    </motion.div>
    </SeekContext.Provider>
  );
}

function SignalList({ title, rows }: { title: string; rows: { at: number | null; text: string; note?: string; state: 'good' | 'mid' | 'bad'; stateLabel: string }[] }) {
  return (
    <div className={styles.signalList}>
      <span className={styles.signalLabel}>
        <FiHelpCircle aria-hidden /> {title}
      </span>
      <ul>
        {rows.map((r, i) => (
          <li key={i}>
            <span className={clsx(styles.state, styles[`state_${r.state}`])}>{r.stateLabel}</span>
            <span className={styles.signalText}>
              <Time at={r.at} /> {r.text}
              {r.note && <small>{r.note}</small>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

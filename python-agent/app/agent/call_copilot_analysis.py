"""Real-Time AI Sales Call Copilot — the structured Claude calls a call
session makes: a periodic mid-call analysis (throttled, see
app.routes.call_copilot), a one-shot end-of-call summary, and a one-shot
end-of-call coaching report (humanized score + manager-style feedback,
generated right after the summary and reusing it as grounding context).

All three are built on anthropic_client._run_forced_tool_extraction — the
exact same retry-once-then-raise, forced-tool-choice, traced-and-billed shape
already used for role/finance-document/business-document extraction. Kept in
its own module rather than added inline to anthropic_client.py (which already
holds the shared helper plus several other features' tool schemas) purely to
avoid growing that already-large file further with more sizable schemas; the
underscore-prefixed helper is imported directly rather than duplicated.
"""

from app.agent.anthropic_client import _run_forced_tool_extraction

CALL_ANALYSIS_TOOL = {
    "name": "analyze_call_segment",
    "description": (
        "Analyze the most recent portion of a live sales call transcript and return real-time "
        "coaching signals for the salesperson. Only report what is NEW in this segment — the "
        "caller already knows about everything in 'already_detected', so do not repeat those."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "sentiment": {
                "type": "string",
                "enum": ["positive", "neutral", "negative", "mixed"],
                "description": "The customer's overall tone in this segment specifically, not the whole call.",
            },
            "events": {
                "type": "array",
                "description": "NEW signals detected in this segment only — empty array if nothing new.",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": [
                                "intent", "requirement", "objection", "pain_point", "competitor",
                                "budget", "timeline", "buying_signal", "commitment",
                            ],
                        },
                        "text": {"type": "string", "description": "A short, specific statement of what was detected, quoting or closely paraphrasing the transcript."},
                    },
                    "required": ["type", "text"],
                },
            },
            "recommendations": {
                "type": "array",
                "description": "Concrete, immediately-actionable suggestions for what the salesperson should say or do next, given what just happened. Empty if nothing new is warranted this cycle.",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["say", "ask", "handle_objection", "next_action"]},
                        "text": {"type": "string", "description": "The actual suggested wording or action — specific enough to use verbatim if needed."},
                    },
                    "required": ["type", "text"],
                },
            },
        },
        "required": ["sentiment", "events", "recommendations"],
    },
}

CALL_SUMMARY_TOOL = {
    "name": "summarize_call",
    "description": (
        "Summarize a completed sales call end-to-end for the salesperson's records and follow-up, "
        "in a structured, scannable format — never a single dense paragraph."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "headline": {
                "type": "string",
                "description": (
                    "One plain-language sentence capturing the single most important outcome of the "
                    "call — the first thing a busy manager reads, e.g. 'Customer is ready to move "
                    "forward pending legal review of the contract.'"
                ),
            },
            "outcome": {
                "type": "string",
                "enum": ["moving_forward", "needs_follow_up", "objection_raised", "no_decision", "lost", "not_applicable"],
                "description": "The single best-fitting overall outcome classification for this call.",
            },
            "summaryPoints": {
                "type": "array",
                "description": (
                    "3-5 short, plain-language bullet points narrating what happened, in "
                    "chronological order — one idea per bullet, no jargon."
                ),
                "items": {"type": "string"},
            },
            "customerNeeds": {
                "type": "array",
                "description": "Concrete needs/requirements the customer expressed, in their own terms. Empty array if none were discussed.",
                "items": {"type": "string"},
            },
            "concernsRaised": {
                "type": "array",
                "description": "Objections, hesitations, or risks the customer raised. Empty array if none.",
                "items": {"type": "string"},
            },
            "keyTakeaways": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "The handful of facts most worth remembering later (budget figures, timelines, "
                    "decision-makers named, competitor mentions) — short, specific, standalone statements."
                ),
            },
            "followUpActions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "A concrete next step, phrased as an action, e.g. 'Send pricing document for the enterprise tier'."},
                        "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                        "owner": {"type": "string", "enum": ["salesperson", "customer"], "description": "Who needs to do this next."},
                    },
                    "required": ["text", "priority", "owner"],
                },
            },
        },
        "required": ["headline", "outcome", "summaryPoints", "customerNeeds", "concernsRaised", "keyTakeaways", "followUpActions"],
    },
}

COACHING_TOOL = {
    "name": "generate_coaching_report",
    "description": (
        "Act as an experienced sales manager who just listened to this entire completed call. "
        "Grade the salesperson's performance and give them specific, human, actionable coaching — "
        "never generic sales advice, always grounded in what this particular call actually contained."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "categoryScores": {
                "type": "array",
                "description": (
                    "Exactly one entry per category below, in this order: opening_rapport, "
                    "discovery_listening, value_communication, objection_handling, "
                    "engagement_confidence, closing_followup."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "category": {
                            "type": "string",
                            "enum": [
                                "opening_rapport", "discovery_listening", "value_communication",
                                "objection_handling", "engagement_confidence", "closing_followup",
                            ],
                        },
                        "score": {
                            "type": "integer",
                            "description": (
                                "0-10, whole number, judged only against this call. If the topic "
                                "genuinely never came up, score it low and say so in the rationale as "
                                "a missed opportunity to address it — never skip or guess a middling "
                                "score just because there's little to go on."
                            ),
                        },
                        "rationale": {
                            "type": "string",
                            "description": "One or two sentences citing something specific that was actually said in this call.",
                        },
                    },
                    "required": ["category", "score", "rationale"],
                },
            },
            "whatWentWell": {
                "type": "array",
                "description": "2-4 specific positive moments from this exact call and why each one worked.",
                "items": {"type": "string"},
            },
            "whatToImprove": {
                "type": "array",
                "description": "2-4 specific weaknesses from this exact call, referencing what actually happened — never a generic skill name alone.",
                "items": {"type": "string"},
            },
            "whatWouldHaveDoneDifferently": {
                "type": "array",
                "description": "1-3 concrete alternative things to have said or done, specific enough to use verbatim next time.",
                "items": {"type": "string"},
            },
            "nextCallFocus": {
                "type": "array",
                "description": "1-3 specific things this salesperson should focus on in their next call.",
                "items": {"type": "string"},
            },
            "keyMoments": {
                "type": "array",
                "description": "3-6 of the most important moments from the call, each tied to something that actually happened.",
                "items": {
                    "type": "object",
                    "properties": {
                        "momentType": {
                            "type": "string",
                            "enum": ["great_moment", "missed_opportunity", "buying_signal", "risk_signal"],
                        },
                        "text": {"type": "string", "description": "What happened, referencing the transcript specifically."},
                        "recommendation": {
                            "type": "string",
                            "description": "What the salesperson should have done, or should do about it now. Empty string if this moment needs no follow-up (e.g. a clean great_moment).",
                        },
                        "relatedEventText": {
                            "type": "string",
                            "description": (
                                "If this moment corresponds to one of the signals listed in "
                                "'Signals detected during the call' below, copy that signal's text "
                                "here EXACTLY so it can be matched back to when it happened. Empty "
                                "string if this moment isn't tied to one of those listed signals."
                            ),
                        },
                    },
                    "required": ["momentType", "text", "recommendation", "relatedEventText"],
                },
            },
            "coachingSummary": {
                "type": "string",
                "description": "A short (3-5 sentence) personalized wrap-up, written as if a manager is speaking directly to the salesperson.",
            },
            "voiceScript": {
                "type": "string",
                "description": (
                    "A natural, spoken-out-loud script — what a sales manager would actually SAY to "
                    "the salesperson, not a written report. 30-90 seconds when read aloud (roughly "
                    "75-220 words). Must mention the overall score, the strongest area, the single "
                    "biggest miss, and one specific focus for next time. Warm, direct, conversational "
                    "— never a bullet list, never a recitation of every field above."
                ),
            },
        },
        "required": [
            "categoryScores", "whatWentWell", "whatToImprove", "whatWouldHaveDoneDifferently",
            "nextCallFocus", "keyMoments", "coachingSummary", "voiceScript",
        ],
    },
}

_ANALYSIS_SYSTEM_PROMPT = (
    "You are a real-time sales call copilot listening in on a live customer call. You are given "
    "background context about the customer/deal (from CRM, past notes, and business knowledge), "
    "a rolling window of the most recent transcript, and a list of signals already detected "
    "earlier in this same call. Your job is to spot what's NEW in the latest transcript segment "
    "and give the salesperson sharp, immediately useful coaching — not a running commentary. If "
    "nothing new and noteworthy happened, return empty events/recommendations arrays rather than "
    "inventing something. Never fabricate a detail (a budget figure, a competitor name, a "
    "commitment) that was not actually said."
)

_SUMMARY_SYSTEM_PROMPT = (
    "You are summarizing a completed sales call for a busy salesperson's CRM records. They will "
    "skim this in seconds between calls, so prioritize plain, concrete language over formal or "
    "vague business-speak — write the way you'd explain the call out loud to a colleague, not the "
    "way you'd write a report. Every field must be grounded ONLY in what the transcript and "
    "detected-events list actually show — never invent a commitment, number, name, or next step "
    "that wasn't actually discussed. If the call was too short or unclear to support a field "
    "confidently, return an empty array or the most neutral applicable enum value rather than "
    "guessing. The headline and summary bullets are the most-read part of this output — make them count."
)


_COACHING_SYSTEM_PROMPT = (
    "You are an experienced, supportive sales manager giving a salesperson feedback right after "
    "one of their calls — the way you'd actually talk to them in person, not a corporate report. "
    "Every score, strength, weakness, and moment you cite must be grounded ONLY in what the "
    "transcript and detected-events list actually show — never invent a detail, a number, or a "
    "moment that didn't happen. Be specific: reference what was actually said instead of generic "
    "advice like 'improve communication skills'. Be honest about weaknesses but supportive in tone "
    "— the goal is a salesperson who feels coached, not criticized. If a call was too short or "
    "one-sided to judge a category fairly, say so plainly in that category's rationale rather than "
    "inventing evidence."
)


# Keys mirror app.integrations.sarvam_client.SUPPORTED_LANGUAGES exactly — the
# only languages the TTS step after this can actually speak.
VOICE_LANGUAGE_NAMES = {
    "en": "English",
    "hi": "Hindi",
    "ta": "Tamil",
    "te": "Telugu",
    "kn": "Kannada",
    "ml": "Malayalam",
    "bn": "Bengali",
    "mr": "Marathi",
    "gu": "Gujarati",
    "pa": "Punjabi",
    "od": "Odia",
}

# /voice/speak rejects text over 2500 characters (see routes/voice.py's
# SpeakRequest) — kept a little under so a script never fails at the last step.
_MAX_SPOKEN_CHARS = 2400

VOICE_SCRIPT_TOOL = {
    "name": "write_spoken_coaching",
    "description": (
        "Write the coaching feedback as a natural spoken script, in the requested language, "
        "exactly as a native-speaking sales manager would say it out loud to the salesperson."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "voiceScript": {
                "type": "string",
                "description": (
                    "The spoken script, entirely in the requested language and its native script. "
                    "Plain flowing sentences only — no bullet points, no markdown, no headings, no "
                    "emoji. 75-200 words, under 1800 characters."
                ),
            },
        },
        "required": ["voiceScript"],
    },
}

_VOICE_SCRIPT_SYSTEM_PROMPT = (
    "You are an experienced, supportive sales manager who speaks {language} natively, giving a "
    "salesperson quick spoken feedback right after their call. You are given the coaching "
    "feedback that was already prepared for this call. Re-tell it as a short spoken monologue in "
    "natural, conversational {language} — the way a fluent native speaker would actually say it "
    "out loud, NOT a word-for-word translation. Write in {language}'s own script. Prefer everyday "
    "{language} words; keep an English term only where native speakers genuinely say it in English "
    "(e.g. CRM, follow-up), and only a few. Mention the overall score as 'X out of 10', the "
    "strongest area, the single biggest miss, and one specific thing to focus on next time. Use "
    "ONLY what the provided feedback contains — never add a fact, number, or moment that isn't in "
    "it. Warm, direct, and encouraging; no bullet points or formatting, since this will be read "
    "aloud by a text-to-speech voice."
)


def _truncate_for_speech(text: str, limit: int = _MAX_SPOKEN_CHARS) -> str:
    """Cuts at the last full sentence within `limit` (Latin and Devanagari
    danda terminators) so the audio never ends mid-word."""
    text = text.strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    last = max(cut.rfind(ch) for ch in ".!?।॥")
    return cut[: last + 1] if last > limit // 2 else cut


def localize_voice_script(
    language_code: str,
    coaching: dict,
    *,
    organization_id: str | None,
    user_id: str,
) -> str:
    """Rewrites an already-generated coaching report as a spoken script in the
    given language. Deliberately grounded in the coaching report only (not the
    full transcript again) — cheaper, and the coaching already is the
    grounded analysis. Cached per language on the session by NestJS
    (CallCopilotService.getVoiceScript), so this runs at most once per
    language per coaching report."""
    language = VOICE_LANGUAGE_NAMES[language_code]

    def bullets(items: list[str]) -> str:
        return "\n".join(f"- {i}" for i in items) or "(none)"

    scores = "\n".join(
        f"- {c.get('category')}: {c.get('score')}/10 — {c.get('rationale')}" for c in coaching.get("categoryScores", [])
    )
    user_text = (
        f"Overall score: {coaching.get('overallScore')} out of 10\n\n"
        f"Category scores:\n{scores or '(none)'}\n\n"
        f"What went well:\n{bullets(coaching.get('whatWentWell', []))}\n\n"
        f"What to improve:\n{bullets(coaching.get('whatToImprove', []))}\n\n"
        f"What the manager would have done differently:\n{bullets(coaching.get('whatWouldHaveDoneDifferently', []))}\n\n"
        f"Next call focus:\n{bullets(coaching.get('nextCallFocus', []))}\n\n"
        f"Coaching summary: {coaching.get('coachingSummary') or '(none)'}\n\n"
        f"The English spoken script prepared for this call (for tone and length reference only):\n"
        f"{coaching.get('voiceScript') or '(none)'}\n\n"
        f"Write the spoken script now, in {language}."
    )
    result = _run_forced_tool_extraction(
        _VOICE_SCRIPT_SYSTEM_PROMPT.format(language=language),
        VOICE_SCRIPT_TOOL,
        [{"type": "text", "text": user_text}],
        name="call_copilot_voice_script",
        organization_id=organization_id,
        user_id=user_id,
    )
    return _truncate_for_speech(result.get("voiceScript", ""))


def generate_coaching_report(
    context_blob: str,
    full_transcript: str,
    detected_events: list[str],
    call_summary: str,
    *,
    organization_id: str | None,
    user_id: str,
) -> dict:
    """One-shot end-of-call coaching layer — runs after summarize_call, reusing
    its already-generated summary as grounding context rather than re-deriving
    outcome/needs/concerns from scratch. See CallCopilotService.generateCoaching
    (NestJS) for the best-effort, fire-and-forget caller."""
    user_text = (
        f"Customer/deal context:\n{context_blob or '(no linked CRM/RAG context for this call)'}\n\n"
        f"Signals detected during the call: {', '.join(detected_events) or '(none detected)'}\n\n"
        f"Existing call summary (already generated, for grounding — do not repeat it verbatim):\n{call_summary or '(none)'}\n\n"
        f"Full call transcript:\n{full_transcript[:60000]}"
    )
    return _run_forced_tool_extraction(
        _COACHING_SYSTEM_PROMPT,
        COACHING_TOOL,
        [{"type": "text", "text": user_text}],
        name="call_copilot_coaching",
        organization_id=organization_id,
        user_id=user_id,
    )


def analyze_call_segment(
    context_blob: str,
    transcript_window: str,
    already_detected: list[str],
    *,
    organization_id: str | None,
    user_id: str,
) -> dict:
    """One throttled mid-call analysis — see app.routes.call_copilot for the
    rate-limit + minimum-new-words gate that decides when this gets called at
    all. Returns {"sentiment", "events": [...], "recommendations": [...]}."""
    user_text = (
        f"Customer/deal context (fetched once at call start):\n{context_blob or '(no linked CRM/RAG context for this call)'}\n\n"
        f"Already detected so far this call (do not repeat): {', '.join(already_detected) or '(none yet)'}\n\n"
        f"Most recent transcript:\n{transcript_window}"
    )
    return _run_forced_tool_extraction(
        _ANALYSIS_SYSTEM_PROMPT,
        CALL_ANALYSIS_TOOL,
        [{"type": "text", "text": user_text}],
        name="call_copilot_analysis",
        organization_id=organization_id,
        user_id=user_id,
    )


def summarize_call(
    context_blob: str,
    full_transcript: str,
    detected_events: list[str],
    *,
    organization_id: str | None,
    user_id: str,
) -> dict:
    """One-shot end-of-call summary — full transcript, not a windowed slice
    (the call is over, there's no more "recent vs. stale" distinction)."""
    user_text = (
        f"Customer/deal context:\n{context_blob or '(no linked CRM/RAG context for this call)'}\n\n"
        f"Signals detected during the call: {', '.join(detected_events) or '(none detected)'}\n\n"
        f"Full call transcript:\n{full_transcript[:60000]}"
    )
    return _run_forced_tool_extraction(
        _SUMMARY_SYSTEM_PROMPT,
        CALL_SUMMARY_TOOL,
        [{"type": "text", "text": user_text}],
        name="call_copilot_summary",
        organization_id=organization_id,
        user_id=user_id,
    )

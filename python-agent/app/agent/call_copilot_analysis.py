"""Real-Time AI Sales Call Copilot — the two structured Claude calls a live
call session makes: a periodic mid-call analysis (throttled, see
app.routes.call_copilot) and a one-shot end-of-call summary.

Both are built on anthropic_client._run_forced_tool_extraction — the exact
same retry-once-then-raise, forced-tool-choice, traced-and-billed shape
already used for role/finance-document/business-document extraction. Kept in
its own module rather than added inline to anthropic_client.py (which already
holds the shared helper plus several other features' tool schemas) purely to
avoid growing that already-large file further with two more sizable schemas;
the underscore-prefixed helper is imported directly rather than duplicated.
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
    "description": "Summarize a completed sales call end-to-end for the salesperson's records and follow-up.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "3-6 sentence narrative summary of the whole call."},
            "keyTakeaways": {"type": "array", "items": {"type": "string"}},
            "followUpActions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "A concrete next step, e.g. 'Send pricing document for the enterprise tier'."},
                        "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                    },
                    "required": ["text", "priority"],
                },
            },
        },
        "required": ["summary", "keyTakeaways", "followUpActions"],
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
    "You are summarizing a completed sales call for the salesperson's CRM records. Base the "
    "summary, takeaways, and follow-up actions ONLY on what the transcript and detected-events "
    "list actually show — never invent a commitment, number, or next step that wasn't discussed."
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

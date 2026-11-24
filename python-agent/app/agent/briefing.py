"""Haive's spoken business briefing — the first thing the voice assistant says.

NestJS (backend/src/assistant) gathers the facts from the business's own data —
the same figures the Dashboard, Inbox and Agent Activity show, already limited
to what this person may see — and sends them here. One forced-tool Claude call
turns them into what a sharp business executive would say: a greeting by name,
the few things that matter, why, the next step, and an offer to go deeper. It
speaks only from the facts it is given: no invented figures, and actual numbers
are kept apart from estimates and forecasts.
"""

from __future__ import annotations

import json

from app.agent.anthropic_client import _run_forced_tool_extraction

POINT_KINDS = ["actual", "estimate", "forecast", "recommendation"]

BRIEFING_TOOL = {
    "name": "business_briefing",
    "description": "Brief one person on their business right now, out loud, from the facts given — like a trusted executive sitting beside them.",
    "input_schema": {
        "type": "object",
        "properties": {
            "spoken": {
                "type": "string",
                "description": (
                    "Exactly what Haive says out loud, as long as the message asks: greet them by first name for the time of day, then the "
                    "3-4 things that matter most right now and why, the one thing to do first, and end with a single question "
                    "offering to go deeper (e.g. 'Shall I walk you through the pipeline?'). Natural speech for a voice: round "
                    "numbers the way people say them (₹2.3 lakh, A$12 thousand, 9 emails), no lists, no symbols like % or /, "
                    "no markdown. Never invent a figure."
                ),
            },
            "headline": {"type": "string", "description": "One short sentence: the state of things today (shown on the briefing card)."},
            "points": {
                "type": "array",
                "maxItems": 5,
                "description": "The key points as short written lines (under 20 words each), most important first.",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "kind": {
                            "type": "string",
                            "enum": POINT_KINDS,
                            "description": "actual = a recorded figure; estimate = an approximation from the data; forecast = a projection (e.g. month-end revenue); recommendation = advice.",
                        },
                        "severity": {"type": "string", "enum": ["critical", "warning", "good", "info"]},
                        "business": {"type": "string", "description": "Which business it is about, when the person sees more than one; else empty."},
                    },
                    "required": ["text", "kind", "severity", "business"],
                },
            },
            "nextAction": {
                "type": "object",
                "properties": {"text": {"type": "string", "description": "The single most valuable thing to do next."}, "why": {"type": "string"}},
                "required": ["text", "why"],
            },
            "suggestedQuestions": {
                "type": "array",
                "maxItems": 4,
                "items": {"type": "string"},
                "description": "3-4 questions they could ask next, short (under 9 words). Prefer the person's own configured questions that today's facts make relevant.",
            },
            "actions": {
                "type": "array",
                "maxItems": 2,
                "description": (
                    "At most two things Haive could DO for them right now, done only if they say yes. Only 'give_task', and only "
                    "to someone in facts.actionPeople (by their ref; 'me' = a task for themselves). Leave empty when nothing "
                    "clearly calls for it or actionPeople is empty."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["give_task"]},
                        "personRef": {"type": "string", "description": "A ref from facts.actionPeople (p1, p2… or me)."},
                        "title": {"type": "string", "description": "The task, as its title: short, concrete, under 12 words (e.g. 'Reply to the 6 waiting Shollinganallur enquiries')."},
                        "due": {"type": "string", "enum": ["today", "tomorrow"]},
                    },
                    "required": ["type", "personRef", "title", "due"],
                },
            },
        },
        "required": ["spoken", "headline", "points", "nextAction", "suggestedQuestions", "actions"],
    },
}

BRIEFING_SYSTEM_PROMPT = (
    "You are Haive, the AI business executive built into this company's operating system. You brief one person on "
    "their business the way a trusted chief of staff would: warm, direct, specific, never robotic, never a list of "
    "numbers. Interpret: say what the figures mean and why they matter, then what to do.\n"
    "Rules:\n"
    "- Use ONLY the facts given. Never invent a figure, a customer, a deal or an event. If something isn't in the "
    "facts (for example payments, which this business doesn't record), don't mention it.\n"
    "- Recorded figures are actual. 'projectedMonthEnd' is a forecast — say 'on track for about…' / 'projected', never as a fact.\n"
    "- Several businesses: keep each one's figures with its name, and never add amounts in different currencies together.\n"
    "- Lakh and crore are for rupees only; say other currencies in thousands and millions (A$740 thousand, never 7.4 lakh).\n"
    "- Someone who sees only their own work: talk about their tasks, emails and calls — not the business's revenue.\n"
    "- Lead with what needs attention (overdue, waiting, at risk); mention one good thing if there is one; be honest when things are quiet.\n"
    "- If 'focus' is given, it is why you are speaking now (their scheduled briefing, or an alert they tapped): open with it — "
    "what it means and what to do — then the rest briefly.\n"
    "- Actions are offers, never done: if you suggest one, end the spoken part by asking whether to do it (e.g. 'Shall I give "
    "Abishake a task to answer them today?') instead of the usual closing question. Never say it is done.\n"
    "- Speak in the language asked for, naturally, as a native speaker would say it."
)

# How much Haive says (the person's AI Conversations setting): the spoken length, and room for it.
STYLE_LENGTHS = {
    "concise": ("70-120 words, never more than 140", 2000),
    "detailed": ("150-200 words, never more than 220: the same order, with a sentence more on why each thing matters", 3200),
}

LANGUAGE_NAMES = {"en": "English", "hi": "Hindi", "ta": "Tamil", "te": "Telugu", "kn": "Kannada", "ml": "Malayalam", "bn": "Bengali", "mr": "Marathi", "gu": "Gujarati", "pa": "Punjabi", "od": "Odia"}


def compose_briefing(
    facts: dict, *, organization_id: str | None, user_id: str, request_id: str = "", style: str = "concise", run=_run_forced_tool_extraction
) -> dict:
    """One briefing from the facts NestJS gathered. `run` is the Claude call (replaced in tests)."""
    language = LANGUAGE_NAMES.get(str(facts.get("language") or "en").split("-")[0], "English")
    length, max_tokens = STYLE_LENGTHS.get(style, STYLE_LENGTHS["concise"])
    text = (
        f"Speak in {language}. Spoken length: {length}.\n"
        f"Facts about this person's business right now (JSON, from their own data — use nothing else):\n"
        f"{json.dumps(facts, ensure_ascii=False, default=str)}"
    )
    result = run(
        BRIEFING_SYSTEM_PROMPT,
        BRIEFING_TOOL,
        [{"type": "text", "text": text}],
        name="assistant_briefing",
        organization_id=organization_id,
        user_id=user_id,
        request_id=request_id,
        max_tokens=max_tokens,
    )
    points = [p for p in result.get("points") or [] if isinstance(p, dict) and p.get("text")]
    return {
        "spoken": (result.get("spoken") or "").strip(),
        "headline": (result.get("headline") or "").strip(),
        "points": [{**p, "kind": p.get("kind") if p.get("kind") in POINT_KINDS else "actual"} for p in points[:5]],
        "nextAction": result.get("nextAction") if isinstance(result.get("nextAction"), dict) else None,
        "suggestedQuestions": [q for q in result.get("suggestedQuestions") or [] if isinstance(q, str) and q.strip()][:4],
        # Offers only; NestJS keeps those naming someone this person may give a task to.
        "actions": [
            {"type": "give_task", "personRef": str(a.get("personRef") or ""), "title": str(a.get("title") or "").strip(), "due": a.get("due") if a.get("due") in ("today", "tomorrow") else "today"}
            for a in result.get("actions") or []
            if isinstance(a, dict) and a.get("type") == "give_task" and a.get("personRef") and str(a.get("title") or "").strip()
        ][:2],
    }

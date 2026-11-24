"""Call Intelligence — the one evaluation engine every call goes through.

Live calls, uploaded recordings and phone calls recorded through Call Copilot
(Plivo / Twilio) all reach this module the same way: NestJS sends the
transcript as numbered lines — each with its time into the call and its
speaker when the recording separated speakers — plus the call's context. The
evaluation then runs in five steps, the last three in code so they cannot be
talked out of:

1. Evaluate (one structured Claude call): understand → analyse → score each
   of the nine weighted categories with quotes → challenge → conclude. The
   model never gives the total, never a timestamp and never a speaker of its
   own: it points at line ids.
2. Verify (code): every quote must really be in the line it names (or the
   line next to it). One that isn't is dropped and counted; times and speakers
   come from the transcript line, never from the model.
3. Strict rules (code): high marks need real quotes; 90+ needs broad
   evidence; an unhandled objection, a missed buying signal or no next step
   caps its category; a serious concern keeps the call out of the good bands.
4. Review (a second Claude call, a QA manager's): is the draft too generous,
   are the negatives there, is outcome kept apart from performance, is
   anything assumed? Its adjustments are applied, then the rules again (a
   review can never lift a mark the rules capped).
5. Score (code): the weighted score over the categories that could be
   judged, with the share of the weight that could be (coverage), and a band.

Too little conversation to judge (a voicemail, a few words) never reaches the
model: it is reported as not assessable, with the reason.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from app.agent.anthropic_client import _run_forced_tool_extraction

# ---- the framework ---------------------------------------------------------------------

# Key, label, weight (out of 100). The order is the scorecard's order.
CATEGORIES: list[tuple[str, str, int]] = [
    ("discovery", "Requirement Understanding & Discovery", 15),
    ("listening", "Active Listening & Engagement", 10),
    ("product_knowledge", "Product / Service Knowledge", 10),
    ("communication", "Communication & Clarity", 10),
    ("objection_handling", "Objection Handling", 15),
    ("value_proposition", "Persuasion & Value Proposition", 10),
    ("trust_building", "Customer Relationship & Trust Building", 10),
    ("opportunity", "Opportunity Identification & Buying Signals", 10),
    ("closure", "Call Closure & Next Steps", 10),
]
CATEGORY_KEYS = [k for k, _, _ in CATEGORIES]
LABEL = {k: label for k, label, _ in CATEGORIES}
WEIGHT = {k: w for k, _, w in CATEGORIES}
assert sum(WEIGHT.values()) == 100

BANDS: list[tuple[int, str, str]] = [
    (90, "exceptional", "Exceptional"),
    (80, "very_good", "Very Good"),
    (70, "good", "Good"),
    (60, "average", "Average"),
    (40, "poor", "Poor"),
    (0, "critical", "Critical"),
]

# Below this much conversation there is nothing fair to judge.
MIN_WORDS = 40
MIN_LINES = 3
# Below this share of the weight being assessable, the score is shown as low-confidence.
LOW_COVERAGE = 50
# The transcript sent to the model (characters). Longer calls are cut at the end, and say so.
MAX_TRANSCRIPT_CHARS = 60_000

OUTCOMES = [
    "sale_confirmed",
    "strong_progress",
    "next_step_agreed",
    "information_only",
    "no_progress",
    "lost",
    "cut_short",
    "not_a_sales_call",
    "unclear",
]
MISSED_KINDS = ["unanswered_question", "missed_buying_signal", "unhandled_objection", "missing_follow_up", "value_not_explained", "no_meaningful_outcome", "other"]
CONCERN_KINDS = ["unrealistic_promise", "incorrect_information", "unprofessional", "compliance", "other"]


def band_of(score: int | None) -> tuple[str, str]:
    if score is None:
        return "not_assessable", "Not assessable"
    for floor, key, label in BANDS:
        if score >= floor:
            return key, label
    return "critical", "Critical"


# ---- the transcript, as the model sees it ---------------------------------------------


def clock(seconds: float | None) -> str:
    if seconds is None:
        return "--:--"
    s = max(0, int(round(seconds)))
    return f"{s // 3600}:{(s % 3600) // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


def speaker_name(label: str | None) -> str:
    """Sarvam's diarization labels speakers "0", "1"…; people read "Speaker 1", "Speaker 2"."""
    if label is None or str(label).strip() == "":
        return "Unlabelled"
    text = str(label).strip()
    return f"Speaker {int(text) + 1}" if text.isdigit() else text


def format_lines(lines: list[dict]) -> tuple[str, bool]:
    """'L7 [01:42] Speaker 2: …' per line; cut at MAX_TRANSCRIPT_CHARS (and say whether it was)."""
    out: list[str] = []
    used = 0
    for line in lines:
        row = f"{line['id']} [{clock(line.get('at'))}] {speaker_name(line.get('speaker'))}: {line['text']}"
        if used + len(row) > MAX_TRANSCRIPT_CHARS:
            return "\n".join(out), True
        out.append(row)
        used += len(row) + 1
    return "\n".join(out), False


# ---- step 1: the evaluation -------------------------------------------------------------

_EVIDENCE = {
    "type": "object",
    "properties": {
        "lineId": {"type": "string", "description": "The transcript line it comes from, e.g. 'L12'."},
        "quote": {"type": "string", "description": "Words copied EXACTLY from that line — the few words that prove the point (3-12 words). Never paraphrase inside a quote."},
        "judgement": {"type": "string", "enum": ["positive", "negative"]},
    },
    "required": ["lineId", "quote", "judgement"],
}

EVALUATION_TOOL = {
    "name": "evaluate_call",
    "description": (
        "Evaluate one completed call the way an experienced Sales Director and QA manager would, in five stages, "
        "in the order of this schema: understand, analyse, evaluate each category, challenge, conclude. Every "
        "judgement points at transcript line ids; quotes are copied exactly from those lines."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "understanding": {
                "type": "object",
                "description": "Stage 1 — understand the call before judging anything.",
                "properties": {
                    "callPurpose": {"type": "string", "description": "Why this call happened, in one sentence."},
                    "context": {"type": "string", "description": "The situation in one or two sentences: who the customer is, where the deal stands."},
                    "speakers": {
                        "type": "array",
                        "description": "Each speaker label in the transcript and who they are. 'Unlabelled' when the recording did not separate speakers.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string"},
                                "role": {"type": "string", "enum": ["agent", "customer", "other", "mixed", "unknown"]},
                                "basis": {"type": "string", "description": "What in the transcript shows it."},
                            },
                            "required": ["label", "role", "basis"],
                        },
                    },
                    "customerRequirements": {"type": "array", "items": {"type": "string"}, "description": "What the customer actually needs, in their terms. Empty if never stated."},
                },
                "required": ["callPurpose", "context", "speakers", "customerRequirements"],
            },
            "analysis": {
                "type": "object",
                "description": "Stage 2 — what happened, line by line. Only things that are in the transcript.",
                "properties": {
                    "customerQuestions": {
                        "type": "array",
                        "maxItems": 5,
                        "description": "The customer's real questions (at most 5).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": {"type": "string"},
                                "lineId": {"type": "string"},
                                "answered": {"type": "string", "enum": ["yes", "partly", "no"]},
                            },
                            "required": ["question", "lineId", "answered"],
                        },
                    },
                    "objections": {
                        "type": "array",
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "objection": {"type": "string"},
                                "lineId": {"type": "string"},
                                "handling": {"type": "string", "enum": ["well", "partly", "not_handled"]},
                                "how": {"type": "string", "description": "How the agent responded (or that they didn't)."},
                            },
                            "required": ["objection", "lineId", "handling", "how"],
                        },
                    },
                    "buyingSignals": {
                        "type": "array",
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "signal": {"type": "string"},
                                "lineId": {"type": "string"},
                                "actedOn": {"type": "boolean", "description": "Did the agent pick it up and move the sale forward?"},
                            },
                            "required": ["signal", "lineId", "actedOn"],
                        },
                    },
                    "commitments": {
                        "type": "array",
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "by": {"type": "string", "enum": ["agent", "customer"]},
                                "text": {"type": "string"},
                                "lineId": {"type": "string"},
                                "realistic": {"type": "boolean", "description": "False for a promise the agent cannot be sure to keep (a price, a date, a guarantee given without checking)."},
                            },
                            "required": ["by", "text", "lineId", "realistic"],
                        },
                    },
                    "communicationIssues": {
                        "type": "array",
                        "maxItems": 3,
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["interruption", "monologue", "repetition", "unclear", "off_topic", "other"]},
                                "text": {"type": "string"},
                                "lineId": {"type": "string"},
                            },
                            "required": ["kind", "text", "lineId"],
                        },
                    },
                    "customerEngagement": {
                        "type": "object",
                        "properties": {"level": {"type": "string", "enum": ["high", "medium", "low", "unclear"]}, "basis": {"type": "string"}},
                        "required": ["level", "basis"],
                    },
                    "customerSentiment": {
                        "type": "object",
                        "properties": {
                            "start": {"type": "string", "enum": ["positive", "neutral", "negative", "mixed", "unclear"]},
                            "end": {"type": "string", "enum": ["positive", "neutral", "negative", "mixed", "unclear"]},
                            "basis": {"type": "string"},
                        },
                        "required": ["start", "end", "basis"],
                    },
                },
                "required": ["customerQuestions", "objections", "buyingSignals", "commitments", "communicationIssues", "customerEngagement", "customerSentiment"],
            },
            "categories": {
                "type": "array",
                "description": "Stage 3 — exactly one entry per category, each judged on its own: " + ", ".join(f"{k} ({LABEL[k]})" for k in CATEGORY_KEYS) + ".",
                "items": {
                    "type": "object",
                    "properties": {
                        "key": {"type": "string", "enum": CATEGORY_KEYS},
                        "assessable": {
                            "type": "boolean",
                            "description": "False when the call gave no fair chance to show it (e.g. no objection was ever raised, so objection handling can't be judged). Never invent a judgement.",
                        },
                        "notAssessableReason": {"type": "string", "description": "Why, when not assessable; empty otherwise."},
                        "score": {
                            "type": "integer",
                            "description": "0-10 against professional sales standards. 5 = basic, expected behaviour. 8+ only for clearly skilled work shown in the quotes; 10 is rare. Ignored when not assessable.",
                        },
                        "rationale": {"type": "string", "description": "Why this mark, in one or two plain sentences (under 45 words): what happened and its effect on the customer or the sale."},
                        "evidence": {"type": "array", "maxItems": 2, "items": _EVIDENCE, "description": "1-2 quotes the mark rests on. A mark of 8+ needs at least one positive quote."},
                    },
                    "required": ["key", "assessable", "notAssessableReason", "score", "rationale", "evidence"],
                },
            },
            "challenge": {
                "type": "object",
                "description": "Stage 4 — what a demanding sales manager would challenge.",
                "properties": {
                    "missedOpportunities": {
                        "type": "array",
                        "maxItems": 4,
                        "description": "The most important ones (at most 4).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": MISSED_KINDS},
                                "text": {"type": "string"},
                                "lineId": {"type": "string", "description": "Where it happened; empty if it is about something that never happened (e.g. no next step)."},
                                "quote": {"type": "string", "description": "Exact words from that line, or empty."},
                                "betterApproach": {"type": "string", "description": "What to say or do instead, specific enough to use."},
                            },
                            "required": ["kind", "text", "lineId", "quote", "betterApproach"],
                        },
                    },
                    "seriousConcerns": {
                        "type": "array",
                        "description": "Only real, quotable problems: an unrealistic promise, incorrect information, unprofessional conduct. Empty if none.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": CONCERN_KINDS},
                                "text": {"type": "string"},
                                "lineId": {"type": "string"},
                                "quote": {"type": "string"},
                            },
                            "required": ["kind", "text", "lineId", "quote"],
                        },
                    },
                    "expertWouldHaveDone": {"type": "array", "maxItems": 2, "items": {"type": "string"}, "description": "What an experienced salesperson would have done differently in this call (1-2 points)."},
                },
                "required": ["missedOpportunities", "seriousConcerns", "expertWouldHaveDone"],
            },
            "conclusion": {
                "type": "object",
                "description": "Stage 5 — only now, the conclusion.",
                "properties": {
                    "outcome": {
                        "type": "object",
                        "properties": {
                            "result": {"type": "string", "enum": OUTCOMES, "description": "The business outcome. Agreeing to 'receive information' is information_only, not a sale."},
                            "explanation": {"type": "string"},
                            "performanceVsOutcome": {
                                "type": "string",
                                "description": "Keep the two apart: a good result can follow a weak call and a strong call can end without a sale (e.g. the customer had to leave). Say which applies here.",
                            },
                        },
                        "required": ["result", "explanation", "performanceVsOutcome"],
                    },
                    "verdict": {"type": "string", "description": "One honest sentence on how the agent did. Not softened."},
                    "strengths": {
                        "type": "array",
                        "maxItems": 4,
                        "description": "What the agent genuinely did well, each with its quote. Empty if nothing stood out — never pad.",
                        "items": {
                            "type": "object",
                            "properties": {"text": {"type": "string"}, "lineId": {"type": "string"}, "quote": {"type": "string"}},
                            "required": ["text", "lineId", "quote"],
                        },
                    },
                    "weaknesses": {
                        "type": "array",
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "severity": {"type": "string", "enum": ["critical", "major", "minor"]},
                                "lineId": {"type": "string"},
                                "quote": {"type": "string"},
                                "impact": {"type": "string", "description": "Its effect on the customer or the business."},
                            },
                            "required": ["text", "severity", "lineId", "quote", "impact"],
                        },
                    },
                    "coaching": {
                        "type": "array",
                        "maxItems": 3,
                        "description": "2-3 precise changes. Never 'improve communication' or 'listen better' — say exactly what to do differently and how.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "change": {"type": "string"},
                                "how": {"type": "string"},
                                "example": {"type": "string", "description": "Words they could actually say next time."},
                            },
                            "required": ["change", "how", "example"],
                        },
                    },
                    "nextActions": {
                        "type": "array",
                        "maxItems": 4,
                        "description": "Follow-ups this call calls for (send a quote, schedule a call, escalate…), at most 4. Things still to do — never mark anything done.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "owner": {"type": "string", "enum": ["agent", "customer", "manager"]},
                                "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                                "basis": {"type": "string", "description": "What in the call calls for it."},
                            },
                            "required": ["text", "owner", "priority", "basis"],
                        },
                    },
                    "summaryForAgent": {"type": "string", "description": "3-5 sentences, spoken to the agent directly: how the call went, the biggest problem, the one thing to change."},
                    "voiceScript": {"type": "string", "description": "The same, as a manager would say it out loud (60-120 words): the strongest point, the biggest miss, one focus. Plain speech, no lists."},
                },
                "required": ["outcome", "verdict", "strengths", "weaknesses", "coaching", "nextActions", "summaryForAgent", "voiceScript"],
            },
        },
        "required": ["understanding", "analysis", "categories", "challenge", "conclusion"],
    },
}

EVALUATION_SYSTEM_PROMPT = (
    "You are an experienced Sales Director and Quality Assurance manager reviewing a recorded customer call. "
    "Your job is to make the agent genuinely better at selling — not to make them feel good. Be objective, "
    "critical and fair.\n\n"
    "How to judge:\n"
    "- Judge substance, not style. Politeness, confidence, a long call, a friendly customer, positive words, "
    "following a script or ending without conflict do NOT earn marks by themselves.\n"
    "- 5 out of 10 is basic, expected work. Doing the job's normal duties earns about 5-6. 8+ only for "
    "clearly skilled work you can quote. 10 is rare.\n"
    "- Penalise what deserves it: talking without discovering needs (discovery, listening), unanswered "
    "questions (product knowledge), unrealistic promises (a serious concern), objections ignored (objection "
    "handling), buying signals missed (opportunity), no clear next step (closure).\n"
    "- Recognise genuinely excellent work and say exactly what made it excellent.\n"
    "- Keep the business outcome apart from the agent's performance. Never penalise the agent for what was "
    "outside their control (the customer had to leave, the line dropped, the customer was not the decision-maker).\n"
    "- If the call gave no fair chance to show a category (e.g. no objection was raised), mark it not "
    "assessable and say why — never invent a judgement or a middling score.\n"
    "- Every judgement rests on the transcript. Quote words EXACTLY as they appear in the line you name. Never "
    "invent a quote, a statement, a number, a time or an outcome. Mark interpretations as yours ('this suggests…').\n"
    "- The transcript may not separate speakers ('Unlabelled'): then work out who is speaking from what is said, "
    "and say so where it matters rather than guessing confidently.\n"
    "- Write plainly and directly, the way a respected manager talks: specific, never generic.\n"
    "- Be brief: short rationales, quotes of a few words. The conclusion (outcome, strengths, weaknesses, "
    "coaching, next actions) is required — leave room for it."
)

# Room for the whole answer (a transcript in Tamil or Hindi script costs several tokens a word); a
# cut-off answer is retried and then fails, never published as a hollow report.
EVALUATION_MAX_TOKENS = 14000


def _evaluation_input(lines_text: str, truncated: bool, meta: dict, context_blob: str, detected_events: list[str], summary: str) -> str:
    separation = (
        "Speakers are separated (Speaker 1, Speaker 2…); work out which one is the agent."
        if meta.get("speakersSeparated")
        else "The recording did not separate speakers: every line is 'Unlabelled'. Infer who is speaking from what is said."
    )
    return (
        f"Recording: {meta.get('categoryLabel') or meta.get('category') or 'call'}; length {clock(meta.get('durationSeconds'))}; "
        f"language {meta.get('languageCode') or 'unknown'}. {separation}\n"
        + ("Note: the transcript was too long and is cut short at the end.\n" if truncated else "")
        + f"\nCustomer / deal context from the CRM:\n{context_blob or '(none linked to this call)'}\n\n"
        f"Signals noticed during the call: {', '.join(detected_events) or '(none)'}\n\n"
        f"Call summary already written (for orientation only; judge from the transcript):\n{summary or '(none)'}\n\n"
        f"Transcript (line id, time into the call, speaker):\n{lines_text}"
    )


# ---- step 2: verifying quotes -----------------------------------------------------------


def _normalise(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "").lower()
    text = re.sub(r"[‘’“”'\"`]", "", text)
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _quoted_in(quote: str, text: str) -> bool:
    """The quote's words are in the text — in order, allowing "…" / "..." where words were left out."""
    parts = [_normalise(p) for p in re.split(r"\.\.\.|…", quote)]
    parts = [p for p in parts if p]
    if not parts or sum(len(p) for p in parts) < 3:
        return False
    haystack = _normalise(text)
    at = 0
    for part in parts:
        found = haystack.find(part, at)
        if found < 0:
            return False
        at = found + len(part)
    return True


def find_line(lines_by_id: dict[str, dict], order: list[str], line_id: str, quote: str) -> dict | None:
    """The line the quote really is in: the one named, or its neighbour (a model often cites the next line).
    None when the words are in neither — the quote is then not used."""
    if line_id not in lines_by_id:
        return None
    i = order.index(line_id)
    for j in (i, i - 1, i + 1):
        if 0 <= j < len(order):
            line = lines_by_id[order[j]]
            if _quoted_in(quote, line["text"]):
                return line
    return None


class _Verifier:
    def __init__(self, lines: list[dict]):
        self.by_id = {line["id"]: line for line in lines}
        self.order = [line["id"] for line in lines]
        self.checked = 0
        self.dropped: list[dict] = []

    def evidence(self, line_id: str, quote: str, where: str) -> dict | None:
        """A quote as the report keeps it: with the line's own time and speaker, or None when it isn't there."""
        if not quote or not line_id:
            return None
        self.checked += 1
        line = find_line(self.by_id, self.order, line_id, quote)
        if line is None:
            self.dropped.append({"where": where, "lineId": line_id, "quote": quote[:200]})
            return None
        return {"lineId": line["id"], "quote": quote.strip()[:300], "at": line.get("at"), "speaker": speaker_name(line.get("speaker"))}

    def line(self, line_id: str) -> dict | None:
        return self.by_id.get(line_id)


def verify(evaluation: dict, lines: list[dict]) -> tuple[dict, dict]:
    """Every quote checked against the transcript; what can't be found is dropped (and counted).
    Returns (the evaluation with verified evidence, the verification record)."""
    v = _Verifier(lines)
    out: dict[str, Any] = {k: evaluation.get(k) for k in ("understanding", "analysis")}

    categories: dict[str, dict] = {}
    for c in evaluation.get("categories") or []:
        key = c.get("key")
        if key not in WEIGHT or key in categories:
            continue
        evidence = []
        for e in c.get("evidence") or []:
            checked = v.evidence(e.get("lineId", ""), e.get("quote", ""), f"category:{key}")
            if checked:
                evidence.append({**checked, "judgement": e.get("judgement", "positive")})
        categories[key] = {
            "key": key,
            "assessable": bool(c.get("assessable")),
            "notAssessableReason": (c.get("notAssessableReason") or "").strip(),
            "score": max(0, min(10, int(c.get("score") or 0))),
            "rationale": (c.get("rationale") or "").strip(),
            "evidence": evidence,
        }
    # A category the model left out can't be judged.
    for key in CATEGORY_KEYS:
        categories.setdefault(key, {"key": key, "assessable": False, "notAssessableReason": "Not evaluated.", "score": 0, "rationale": "", "evidence": []})
    out["categories"] = [categories[k] for k in CATEGORY_KEYS]

    analysis = evaluation.get("analysis") or {}
    # Points in the analysis keep their line's time (the line must exist; they carry no quote of their own).
    def at_line(item: dict) -> dict:
        line = v.line(item.get("lineId", ""))
        return {**item, "at": line.get("at") if line else None, "speaker": speaker_name(line.get("speaker")) if line else None, "lineFound": line is not None}

    out["analysis"] = {
        **analysis,
        **{key: [at_line(x) for x in analysis.get(key) or []] for key in ("customerQuestions", "objections", "buyingSignals", "commitments", "communicationIssues")},
    }

    challenge = evaluation.get("challenge") or {}
    missed = []
    for m in challenge.get("missedOpportunities") or []:
        ev = v.evidence(m.get("lineId", ""), m.get("quote", ""), "missedOpportunity") if m.get("quote") else None
        line = v.line(m.get("lineId", ""))
        missed.append({**{k: m.get(k, "") for k in ("kind", "text", "betterApproach")}, "evidence": ev, "at": (ev or {}).get("at", line.get("at") if line else None)})
    concerns = []
    for s in challenge.get("seriousConcerns") or []:
        ev = v.evidence(s.get("lineId", ""), s.get("quote", ""), "seriousConcern")
        # A serious concern needs its words: an accusation without them is not kept.
        if ev:
            concerns.append({"kind": s.get("kind", "other"), "text": s.get("text", ""), "evidence": ev})
    out["challenge"] = {"missedOpportunities": missed, "seriousConcerns": concerns, "expertWouldHaveDone": challenge.get("expertWouldHaveDone") or []}

    conclusion = evaluation.get("conclusion") or {}
    outcome = conclusion.get("outcome") if isinstance(conclusion.get("outcome"), dict) else None
    strengths = []
    for s in conclusion.get("strengths") or []:
        ev = v.evidence(s.get("lineId", ""), s.get("quote", ""), "strength")
        # Praise needs proof: a strength whose words aren't in the call is not kept.
        if ev:
            strengths.append({"text": s.get("text", ""), "evidence": ev})
    weaknesses = []
    for w in conclusion.get("weaknesses") or []:
        ev = v.evidence(w.get("lineId", ""), w.get("quote", ""), "weakness") if w.get("quote") else None
        weaknesses.append({**{k: w.get(k, "") for k in ("text", "severity", "impact")}, "evidence": ev})
    out["conclusion"] = {
        "outcome": {
            "result": outcome.get("result") if outcome.get("result") in OUTCOMES else "unclear",
            "explanation": outcome.get("explanation", ""),
            "performanceVsOutcome": outcome.get("performanceVsOutcome", ""),
        }
        if outcome
        else None,
        "verdict": conclusion.get("verdict") or "",
        "strengths": strengths,
        "weaknesses": weaknesses,
        "coaching": [c for c in conclusion.get("coaching") or [] if isinstance(c, dict)],
        "nextActions": [a for a in conclusion.get("nextActions") or [] if isinstance(a, dict)],
        "summaryForAgent": conclusion.get("summaryForAgent") or "",
        "voiceScript": conclusion.get("voiceScript") or "",
    }

    record = {"quotesChecked": v.checked, "quotesDropped": len(v.dropped), "dropped": v.dropped[:20]}
    return out, record


# ---- step 3: the strict rules -----------------------------------------------------------


def _cap(categories: dict[str, dict], key: str, ceiling: int, rule: str, adjustments: list[dict]) -> None:
    c = categories[key]
    if c["assessable"] and c["score"] > ceiling:
        adjustments.append({"category": key, "from": c["score"], "to": ceiling, "by": "rule", "reason": rule})
        c["score"] = ceiling


def apply_rules(report: dict, adjustments: list[dict]) -> None:
    """The scoring rules, applied in code so no wording can talk past them. Records every change."""
    categories = {c["key"]: c for c in report["categories"]}
    analysis = report.get("analysis") or {}

    for c in categories.values():
        positive = [e for e in c["evidence"] if e.get("judgement") == "positive"]
        # A high mark needs at least one real quote showing the skill.
        if c["assessable"] and c["score"] >= 8 and not positive:
            _cap(categories, c["key"], 6, "A mark of 8+ needs a quote from the call showing it; none was found.", adjustments)

    objections = [o for o in analysis.get("objections") or [] if o.get("lineFound")]
    if any(o.get("handling") == "not_handled" for o in objections):
        _cap(categories, "objection_handling", 4, "An objection the customer raised was not handled.", adjustments)
    elif any(o.get("handling") == "partly" for o in objections):
        _cap(categories, "objection_handling", 7, "An objection was only partly handled.", adjustments)

    if any(not s.get("actedOn") for s in analysis.get("buyingSignals") or [] if s.get("lineFound")):
        _cap(categories, "opportunity", 6, "A buying signal was missed.", adjustments)

    unanswered = [q for q in analysis.get("customerQuestions") or [] if q.get("lineFound") and q.get("answered") == "no"]
    if unanswered:
        _cap(categories, "product_knowledge", 6, f"{len(unanswered)} customer question{'s' if len(unanswered) > 1 else ''} went unanswered.", adjustments)

    outcome = ((report.get("conclusion") or {}).get("outcome") or {}).get("result")
    # No agreed next step (and not because the call was cut short): closure can't be good.
    if outcome in ("information_only", "no_progress", "unclear") and not any(x.get("by") for x in analysis.get("commitments") or [] if x.get("lineFound")):
        _cap(categories, "closure", 5, "The call ended without a clear, agreed next step.", adjustments)


def score_of(report: dict) -> tuple[int | None, int]:
    """(score out of 100 over the assessable categories, coverage = their share of the weight)."""
    judged = [c for c in report["categories"] if c["assessable"]]
    coverage = sum(WEIGHT[c["key"]] for c in judged)
    if coverage == 0:
        return None, 0
    total = sum(c["score"] / 10 * WEIGHT[c["key"]] for c in judged)
    return int(round(total / coverage * 100)), coverage


def apply_overall_rules(report: dict, score: int | None, coverage: int, adjustments: list[dict]) -> int | None:
    if score is None:
        return None
    judged = [c for c in report["categories"] if c["assessable"]]
    strengths = report["conclusion"].get("strengths") or []
    # 90+ is earned across the board, with proof.
    if score >= 90 and (coverage < 80 or any(c["score"] < 8 for c in judged) or len(strengths) < 3):
        adjustments.append({"category": None, "from": score, "to": 89, "by": "rule", "reason": "90+ needs strong, quoted evidence across the categories (80% of the weight judged, every one 8+, three proven strengths)."})
        score = 89
    concerns = report["challenge"].get("seriousConcerns") or []
    # A serious mistake (an unrealistic promise, wrong information) keeps a call out of the good bands.
    if concerns and score > 59:
        adjustments.append({"category": None, "from": score, "to": 59, "by": "rule", "reason": f"Serious concern: {concerns[0]['text']}"})
        score = 59
    critical = [w for w in report["conclusion"].get("weaknesses") or [] if w.get("severity") == "critical" and w.get("evidence")]
    if critical and score > 69:
        adjustments.append({"category": None, "from": score, "to": 69, "by": "rule", "reason": f"Critical weakness: {critical[0]['text']}"})
        score = 69
    return score


# ---- step 4: the review ------------------------------------------------------------------

QA_CHECKS = [
    "score_matches_conversation",
    "high_scores_supported",
    "negatives_identified",
    "feedback_matches_transcript",
    "outcome_separate_from_performance",
    "no_unsupported_assumptions",
    "recommendations_relevant",
]

QA_TOOL = {
    "name": "review_call_evaluation",
    "description": "Quality-check a draft call evaluation against the transcript before it is published, and correct it.",
    "input_schema": {
        "type": "object",
        "properties": {
            "checks": {
                "type": "array",
                "description": "One entry per check: " + ", ".join(QA_CHECKS) + ".",
                "items": {
                    "type": "object",
                    "properties": {"check": {"type": "string", "enum": QA_CHECKS}, "passed": {"type": "boolean"}, "note": {"type": "string"}},
                    "required": ["check", "passed", "note"],
                },
            },
            "adjustments": {
                "type": "array",
                "description": "Categories whose mark the transcript does not support. Empty when every mark is right.",
                "items": {
                    "type": "object",
                    "properties": {
                        "key": {"type": "string", "enum": CATEGORY_KEYS},
                        "assessable": {"type": "boolean", "description": "False if the category should be not assessable after all."},
                        "score": {"type": "integer", "description": "The corrected mark 0-10 (ignored when not assessable)."},
                        "reason": {"type": "string"},
                    },
                    "required": ["key", "assessable", "score", "reason"],
                },
            },
            "removeClaims": {
                "type": "array",
                "description": "Statements in the draft the transcript does not support (index from 0 within its section).",
                "items": {
                    "type": "object",
                    "properties": {
                        "section": {"type": "string", "enum": ["strengths", "weaknesses", "missedOpportunities", "coaching", "nextActions"]},
                        "index": {"type": "integer"},
                        "reason": {"type": "string"},
                    },
                    "required": ["section", "index", "reason"],
                },
            },
            "verdict": {"type": "string", "description": "The one-sentence verdict, corrected if the draft's was too generous or too harsh; else repeat it."},
        },
        "required": ["checks", "adjustments", "removeClaims", "verdict"],
    },
}

QA_SYSTEM_PROMPT = (
    "You are the quality-assurance reviewer for call evaluations. A draft evaluation of a call is in front of you, "
    "with the transcript. Before it is published, check it the way a demanding Head of Sales would: Is any mark "
    "too generous for what the transcript shows? Are the weaknesses and missed opportunities really there and "
    "complete? Is the business outcome kept apart from the agent's performance? Does any statement go beyond the "
    "transcript? Are the recommendations about this call? Correct a mark only with a reason grounded in the "
    "transcript, in either direction — but most drafts err towards generosity. Do not repeat the draft's work; "
    "only correct it."
)


def _qa_input(lines_text: str, report: dict, record: dict, rule_adjustments: list[dict]) -> str:
    cats = "\n".join(
        f"- {c['key']} ({LABEL[c['key']]}, weight {WEIGHT[c['key']]}): "
        + (f"{c['score']}/10 — {c['rationale']}" if c["assessable"] else f"not assessable — {c['notAssessableReason']}")
        + "".join(f"\n    {e['judgement']} {e['lineId']}: \"{e['quote']}\"" for e in c["evidence"])
        for c in report["categories"]
    )
    concl = report["conclusion"]

    def numbered(items: list, fmt) -> str:
        return "\n".join(f"  [{i}] {fmt(x)}" for i, x in enumerate(items)) or "  (none)"

    return (
        f"Draft marks:\n{cats}\n\n"
        f"Rules already applied in code: {'; '.join(a['reason'] for a in rule_adjustments) or 'none'}\n"
        f"Quotes that were not found in the transcript and were removed: {record['quotesDropped']} of {record['quotesChecked']}\n\n"
        f"Outcome: {(concl.get('outcome') or {}).get('result')} — {(concl.get('outcome') or {}).get('explanation', '')}\n"
        f"Performance vs outcome: {(concl.get('outcome') or {}).get('performanceVsOutcome', '')}\n"
        f"Verdict: {concl.get('verdict', '')}\n\n"
        f"strengths:\n{numbered(concl.get('strengths') or [], lambda s: s['text'])}\n"
        f"weaknesses:\n{numbered(concl.get('weaknesses') or [], lambda w: w.get('severity', '') + ': ' + w.get('text', ''))}\n"
        f"missedOpportunities:\n{numbered(report['challenge'].get('missedOpportunities') or [], lambda m: m.get('text', ''))}\n"
        f"coaching:\n{numbered(concl.get('coaching') or [], lambda c: c.get('change', ''))}\n"
        f"nextActions:\n{numbered(concl.get('nextActions') or [], lambda a: a.get('text', ''))}\n\n"
        f"Transcript:\n{lines_text}"
    )


def apply_review(report: dict, review: dict, adjustments: list[dict]) -> list[dict]:
    """Applies the reviewer's corrections; returns its checks."""
    categories = {c["key"]: c for c in report["categories"]}
    for a in review.get("adjustments") or []:
        c = categories.get(a.get("key"))
        if not c:
            continue
        reason = (a.get("reason") or "").strip() or "Corrected in review."
        if not a.get("assessable"):
            if c["assessable"]:
                adjustments.append({"category": c["key"], "from": c["score"], "to": None, "by": "review", "reason": reason})
                c["assessable"] = False
                c["notAssessableReason"] = reason
            continue
        new = max(0, min(10, int(a.get("score") or 0)))
        if c["assessable"] and new != c["score"]:
            adjustments.append({"category": c["key"], "from": c["score"], "to": new, "by": "review", "reason": reason})
            c["score"] = new
    sections = {
        "strengths": report["conclusion"],
        "weaknesses": report["conclusion"],
        "coaching": report["conclusion"],
        "nextActions": report["conclusion"],
        "missedOpportunities": report["challenge"],
    }
    removed: dict[str, set[int]] = {}
    for r in review.get("removeClaims") or []:
        if r.get("section") in sections and isinstance(r.get("index"), int):
            removed.setdefault(r["section"], set()).add(r["index"])
    for section, indexes in removed.items():
        holder = sections[section]
        items = holder.get(section) or []
        holder[section] = [x for i, x in enumerate(items) if i not in indexes]
        if indexes & set(range(len(items))):
            adjustments.append({"category": None, "from": None, "to": None, "by": "review", "reason": f"Removed {len(indexes & set(range(len(items))))} unsupported statement(s) from {section}."})
    if (review.get("verdict") or "").strip():
        report["conclusion"]["verdict"] = review["verdict"].strip()
    return [c for c in review.get("checks") or [] if c.get("check") in QA_CHECKS]


# ---- the whole pipeline -----------------------------------------------------------------


def not_assessable_report(reason: str, meta: dict, lines: list[dict]) -> dict:
    return {
        "version": 2,
        "assessable": False,
        "notAssessableReason": reason,
        "score": None,
        "band": "not_assessable",
        "bandLabel": "Not assessable",
        "coverage": 0,
        "categories": [{"key": k, "label": LABEL[k], "weight": WEIGHT[k], "assessable": False, "notAssessableReason": reason, "score": None, "rationale": "", "evidence": []} for k in CATEGORY_KEYS],
        "recording": {**meta, "lines": len(lines)},
        "understanding": None,
        "analysis": None,
        "challenge": {"missedOpportunities": [], "seriousConcerns": [], "expertWouldHaveDone": []},
        "conclusion": {"strengths": [], "weaknesses": [], "coaching": [], "nextActions": [], "verdict": reason, "summaryForAgent": reason, "voiceScript": ""},
        "qa": {"checks": [], "adjustments": [], "quotesChecked": 0, "quotesDropped": 0, "reviewed": False},
    }


def too_little_to_judge(lines: list[dict]) -> str | None:
    spoken = [line for line in lines if (line.get("text") or "").strip()]
    words = sum(len(line["text"].split()) for line in spoken)
    if not spoken:
        return "No speech was captured on this call, so there is nothing to evaluate."
    if words < MIN_WORDS or len(spoken) < MIN_LINES:
        return f"Only {words} words were spoken — too little conversation to evaluate fairly."
    return None


def finish(report: dict, record: dict, adjustments: list[dict], checks: list[dict], reviewed: bool, meta: dict, lines: list[dict], truncated: bool) -> dict:
    # The rules again: a review can never lift a mark the rules capped.
    apply_rules(report, adjustments)
    score, coverage = score_of(report)
    score = apply_overall_rules(report, score, coverage, adjustments)
    band, band_label = band_of(score)
    report["categories"] = [
        {**c, "label": LABEL[c["key"]], "weight": WEIGHT[c["key"]], "score": c["score"] if c["assessable"] else None} for c in report["categories"]
    ]
    return {
        "version": 2,
        "assessable": score is not None,
        "notAssessableReason": None if score is not None else "None of the categories could be judged from this call.",
        "score": score,
        "band": band,
        "bandLabel": band_label,
        "coverage": coverage,
        "lowCoverage": score is not None and coverage < LOW_COVERAGE,
        "categories": report["categories"],
        "recording": {**meta, "lines": len(lines), "transcriptCut": truncated},
        "understanding": report.get("understanding"),
        "analysis": report.get("analysis"),
        "challenge": report.get("challenge"),
        "conclusion": report.get("conclusion"),
        "qa": {**record, "checks": checks, "adjustments": adjustments, "reviewed": reviewed},
    }


def evaluate_call(
    lines: list[dict],
    meta: dict,
    context_blob: str,
    detected_events: list[str],
    summary: str,
    *,
    organization_id: str | None,
    user_id: str,
    run=_run_forced_tool_extraction,
) -> dict:
    """The whole evaluation (see the module's docstring). `run` is the Claude call (replaced in tests)."""
    reason = too_little_to_judge(lines)
    if reason:
        return not_assessable_report(reason, meta, lines)
    lines_text, truncated = format_lines(lines)
    draft = run(
        EVALUATION_SYSTEM_PROMPT,
        EVALUATION_TOOL,
        [{"type": "text", "text": _evaluation_input(lines_text, truncated, meta, context_blob, detected_events, summary)}],
        name="call_intelligence_evaluate",
        organization_id=organization_id,
        user_id=user_id,
        max_tokens=EVALUATION_MAX_TOKENS,
        require_complete=True,
    )
    report, record = verify(draft, lines)
    adjustments: list[dict] = []
    apply_rules(report, adjustments)
    checks: list[dict] = []
    reviewed = False
    try:
        review = run(
            QA_SYSTEM_PROMPT,
            QA_TOOL,
            [{"type": "text", "text": _qa_input(lines_text, report, record, adjustments)}],
            name="call_intelligence_review",
            organization_id=organization_id,
            user_id=user_id,
        )
        checks = apply_review(report, review, adjustments)
        reviewed = True
    except Exception as exc:  # noqa: BLE001 - the rules still hold; the report says the review did not run
        adjustments.append({"category": None, "from": None, "to": None, "by": "review", "reason": f"The quality review could not run ({type(exc).__name__}); the code rules were still applied."})
    return finish(report, record, adjustments, checks, reviewed, meta, lines, truncated)


# ---- what older screens read ------------------------------------------------------------


def legacy_fields(evaluation: dict) -> dict:
    """The report in the AI Coach's earlier shape, which the Dialer, the spoken coach and the
    Call Library still read. Scores stay 0-10 per category; the overall is the new score ÷ 10."""
    concl = evaluation.get("conclusion") or {}
    challenge = evaluation.get("challenge") or {}
    analysis = evaluation.get("analysis") or {}
    rank = {"critical": 0, "major": 1, "minor": 2}
    weaknesses = sorted(concl.get("weaknesses") or [], key=lambda w: rank.get(w.get("severity"), 3))
    moments: list[dict] = []
    for s in (concl.get("strengths") or [])[:2]:
        moments.append({"momentType": "great_moment", "text": s["text"], "recommendation": "", "at": (s.get("evidence") or {}).get("at")})
    for m in (challenge.get("missedOpportunities") or [])[:3]:
        moments.append({"momentType": "missed_opportunity", "text": m.get("text", ""), "recommendation": m.get("betterApproach", ""), "at": m.get("at")})
    for b in (analysis.get("buyingSignals") or [])[:2]:
        moments.append({"momentType": "buying_signal", "text": b.get("signal", ""), "recommendation": "" if b.get("actedOn") else "Act on it: move the customer to a clear next step.", "at": b.get("at")})
    for c in (challenge.get("seriousConcerns") or [])[:2]:
        moments.append({"momentType": "risk_signal", "text": c.get("text", ""), "recommendation": "", "at": (c.get("evidence") or {}).get("at")})
    score = evaluation.get("score")
    return {
        "categoryScores": [
            {"category": c["key"], "score": c["score"], "rationale": c.get("rationale", "")}
            for c in evaluation.get("categories") or []
            if c.get("assessable") and c.get("score") is not None
        ],
        "overallScore": round(score / 10, 1) if score is not None else None,
        "whatWentWell": [s["text"] for s in concl.get("strengths") or []],
        "whatToImprove": [w.get("text", "") for w in weaknesses],
        "whatWouldHaveDoneDifferently": [c.get("example") or c.get("how", "") for c in concl.get("coaching") or []][:3] or list(challenge.get("expertWouldHaveDone") or [])[:3],
        "nextCallFocus": [c.get("change", "") for c in concl.get("coaching") or []][:3],
        "keyMoments": moments,
        "coachingSummary": concl.get("summaryForAgent") or concl.get("verdict") or "",
        "voiceScript": concl.get("voiceScript") or "",
    }

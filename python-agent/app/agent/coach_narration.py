"""The AI Coach's full spoken narration in an Indian language.

NestJS (backend/src/call-copilot/coach-narration.ts) builds the complete English
narration from the report saved on the call: overall result, what went well,
what to improve, every skill, serious concerns and missed opportunities,
coaching, next steps. This rewrites it in the language picked in the AI Coach
panel, section for section, so nothing the report says is dropped, and checks
the answer before it is spoken:

* every section comes back, in the language's own script, not English;
* the numbers (the score, each skill's mark, times, quantities) are still there.

Each section is its own short model call, run side by side, so a long report is
neither cut off at the output limit nor slow to start. Cached per language and
report version by NestJS, so a language is rewritten once per report.
"""

from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from app.agent.anthropic_client import _run_forced_tool_extraction

logger = logging.getLogger(__name__)

# Keys mirror app.integrations.sarvam_client.SUPPORTED_LANGUAGES: what the voice can speak.
LANGUAGE_NAMES = {
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

# Each language's own Unicode block: how "is this really Tamil?" is checked.
SCRIPT_RANGES: dict[str, tuple[int, int]] = {
    "hi": (0x0900, 0x097F),  # Devanagari
    "mr": (0x0900, 0x097F),  # Devanagari
    "bn": (0x0980, 0x09FF),  # Bengali
    "pa": (0x0A00, 0x0A7F),  # Gurmukhi
    "gu": (0x0A80, 0x0AFF),  # Gujarati
    "od": (0x0B00, 0x0B7F),  # Odia
    "ta": (0x0B80, 0x0BFF),  # Tamil
    "te": (0x0C00, 0x0C7F),  # Telugu
    "kn": (0x0C80, 0x0CFF),  # Kannada
    "ml": (0x0D00, 0x0D7F),  # Malayalam
}

# Names, products and the odd business word stay in English letters, so not every letter
# is in the language's script; a section mostly in English is a failed translation.
MIN_SCRIPT_SHARE = 0.5
MAX_PARALLEL = 4

NARRATION_TOOL = {
    "name": "write_spoken_section",
    "description": "Return this section of the coach's spoken feedback, rewritten in the requested language.",
    "input_schema": {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "The whole section in the requested language and its own script, as plain spoken sentences.",
            },
        },
        "required": ["text"],
    },
}

SYSTEM_PROMPT = (
    "You are a sales manager who speaks {language} natively. You are given one section of the spoken feedback "
    "on a salesperson's call, in English. Say the same thing in natural, spoken {language}, the way a fluent native "
    "speaker would say it out loud to the salesperson. It will be read aloud by a text-to-speech voice.\n"
    "Rules:\n"
    "- Keep everything: every sentence, point, score, reason, quote, time and action. Never drop, shorten, "
    "summarise or add anything.\n"
    "- Keep every number exactly as written with the digits 0-9: scores such as '34 out of 100' or '7 out of 10', "
    "minutes and seconds, quantities, prices, dates and percentages.\n"
    "- Keep people's names, company names, product names and brand names as they are.\n"
    "- Write in {language}'s own script. Use an English word only where {language} speakers normally say it in "
    "English in business (for example CRM, MOQ, quotation, follow-up), and keep those few. Do not mix in English "
    "otherwise.\n"
    "- Words quoted from the call: give their meaning in {language}, keeping names and numbers.\n"
    "- Plain sentences only: no lists, markdown, headings, symbols or emoji.\n"
    "- Speak to the salesperson directly, warm and direct."
)

RunFn = Callable[..., dict]


def script_share(text: str, language_code: str) -> float:
    """The share of the letters in `text` written in the language's own script (1.0 = all of them)."""
    low, high = SCRIPT_RANGES[language_code]
    letters = [ch for ch in text if ch.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for ch in letters if low <= ord(ch) <= high) / len(letters)


_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")


def missing_numbers(source: str, translated: str) -> list[str]:
    """Numbers in the English that the rewrite lost (a score must never change or vanish)."""
    have = set(_NUMBER.findall(translated))
    return [n for n in dict.fromkeys(_NUMBER.findall(source)) if n not in have]


def _clean(text: str) -> str:
    text = re.sub(r"[*_`#>|]+", " ", text or "")
    return re.sub(r"\s+", " ", text).strip()


def translate_section(
    language_code: str,
    section: dict,
    *,
    organization_id: str | None,
    user_id: str,
    run: RunFn = _run_forced_tool_extraction,
) -> str:
    language = LANGUAGE_NAMES[language_code]
    source = section["text"]
    prompt = SYSTEM_PROMPT.format(language=language)
    last_problem = ""
    for attempt in range(2):
        note = f"\n\nYour last answer was rejected: {last_problem}. Write the whole section again in {language}." if last_problem else ""
        result = run(
            prompt,
            NARRATION_TOOL,
            [{"type": "text", "text": f"Section: {section.get('title') or section.get('id')}\n\n{source}\n\nRewrite it in {language}.{note}"}],
            name="call_copilot_voice_script",
            organization_id=organization_id,
            user_id=user_id,
            require_complete=True,
        )
        text = _clean(str((result or {}).get("text") or ""))
        if not text:
            last_problem = "it was empty"
            continue
        share = script_share(text, language_code)
        if share < MIN_SCRIPT_SHARE:
            last_problem = f"it was not written in {language} script"
            logger.warning("Coach narration %s/%s: only %.0f%% %s script (attempt %s)", section.get("id"), language_code, share * 100, language, attempt + 1)
            continue
        lost = missing_numbers(source, text)
        if lost and attempt == 0:
            last_problem = f"these numbers were missing: {', '.join(lost)}"
            continue
        if lost:
            logger.warning("Coach narration %s/%s kept without numbers %s", section.get("id"), language_code, lost)
        return text
    raise ValueError(f"The {section.get('title') or section.get('id')} section could not be written in {language}: {last_problem}.")


def translate_narration(
    language_code: str,
    sections: list[dict],
    *,
    organization_id: str | None,
    user_id: str,
    run: RunFn = _run_forced_tool_extraction,
) -> list[dict]:
    """Every section rewritten in the language, in the same order; raises if any one fails (a partial
    narration is never returned as if it were the whole report)."""
    if language_code == "en":
        return [dict(s) for s in sections]
    if language_code not in SCRIPT_RANGES:
        raise ValueError(f"'{language_code}' is not a supported narration language.")

    def one(section: dict) -> dict:
        return {
            "id": section["id"],
            "title": section.get("title", ""),
            "text": translate_section(language_code, section, organization_id=organization_id, user_id=user_id, run=run),
        }

    with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL, max(1, len(sections)))) as pool:
        return list(pool.map(one, sections))

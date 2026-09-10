"""Thin wrapper around Sarvam AI's Speech-to-Text and Text-to-Speech REST
APIs (https://docs.sarvam.ai/) — verified against their current API
reference at implementation time, not assumed from older examples.

This module owns ONLY the HTTP call to Sarvam. It has no idea about
conversations, agents, or billing — that's app/routes/voice.py's job, and
the existing chat pipeline's job for anything downstream of a transcript.
"""

import base64
from typing import Optional

import requests

from app.config import settings
from app.memory import integration_store

_BASE_URL = "https://api.sarvam.ai"
_TIMEOUT_SECONDS = 30

# Sarvam's REST STT/TTS endpoints take BCP-47 codes (ta-IN, en-IN, hi-IN, ...).
# This app's own UI/DB only ever needs to know the short ISO code — this map
# is the single place that translation happens, and the single place a new
# language gets added later (Telugu, Kannada, ...).
SUPPORTED_LANGUAGES: dict[str, str] = {
    "ta": "ta-IN",
    "en": "en-IN",
    "hi": "hi-IN",
    "te": "te-IN",
    "kn": "kn-IN",
    "ml": "ml-IN",
    "bn": "bn-IN",
    "mr": "mr-IN",
    "gu": "gu-IN",
    "pa": "pa-IN",
    "od": "od-IN",
}


class SarvamApiError(Exception):
    """Raised for any Sarvam call failure. `user_message` is always safe to
    show directly to an end user — it never contains the API key, a raw
    stack trace, or Sarvam's internal error payload verbatim."""

    def __init__(self, user_message: str, status_code: Optional[int] = None):
        super().__init__(user_message)
        self.user_message = user_message
        self.status_code = status_code


def resolve_language_code(language: str) -> str:
    """Accepts either a short code ('ta') or an already-BCP-47 one ('ta-IN')
    — the frontend always sends the short code, but this stays lenient for
    direct API testing. Raises SarvamApiError (400-shaped) for anything not
    in SUPPORTED_LANGUAGES, per the explicit "never silently use the wrong
    language" requirement."""
    if language in SUPPORTED_LANGUAGES:
        return SUPPORTED_LANGUAGES[language]
    if language in SUPPORTED_LANGUAGES.values():
        return language
    supported = ", ".join(sorted(SUPPORTED_LANGUAGES.keys()))
    raise SarvamApiError(f"'{language}' is not a supported voice language. Supported: {supported}.", status_code=400)


def _require_api_key() -> str:
    # Platform-wide credential ONLY (organizationId="platform"), same exact
    # rule as anthropic_client.py._resolve_api_key — no static .env fallback,
    # no arbitrary-organization credential. Set via Admin-haive Settings ->
    # AI Provider -> Sarvam.
    key = integration_store.get_api_key("sarvam", organization_id="platform")
    if not key:
        raise SarvamApiError("Sarvam AI provider is not configured. Please connect Sarvam from Platform Admin Settings.", status_code=503)
    return key


def transcribe_audio(file_bytes: bytes, filename: str, content_type: str, language: str) -> dict:
    """POST https://api.sarvam.ai/speech-to-text — multipart/form-data.
    Returns {"transcript": str, "language_code": str}."""
    # Validate the language BEFORE checking server config — a client sending
    # an unsupported language should always see that specific error, never
    # masked by an unrelated "not configured" one.
    language_code = resolve_language_code(language)
    api_key = _require_api_key()

    try:
        response = requests.post(
            f"{_BASE_URL}/speech-to-text",
            headers={"api-subscription-key": api_key},
            data={
                "model": settings.sarvam_stt_model,
                "language_code": language_code,
                # codemix — the exact mode Sarvam documents for mixed-language
                # speech (e.g. Tamil+English in one utterance) — preserves the
                # user's own language rather than forcing a translation to
                # English (see the "mixed language support" requirement).
                "mode": "codemix",
            },
            files={"file": (filename, file_bytes, content_type or "application/octet-stream")},
            timeout=_TIMEOUT_SECONDS,
        )
    except requests.exceptions.Timeout:
        raise SarvamApiError("Sarvam AI took too long to respond. Please try again.", status_code=504) from None
    except requests.exceptions.RequestException:
        raise SarvamApiError("Unable to connect to Sarvam AI. Please try again.", status_code=502) from None

    if response.status_code == 403:
        raise SarvamApiError("Voice service authentication failed.", status_code=502)
    if not response.ok:
        raise SarvamApiError("Speech could not be recognized. Please try again.", status_code=502)

    data = response.json()
    return {
        "transcript": data.get("transcript") or "",
        "language_code": data.get("language_code") or language_code,
    }


def synthesize_speech(text: str, language: str, speaker: Optional[str] = None) -> bytes:
    """POST https://api.sarvam.ai/text-to-speech — JSON body. Sarvam returns
    the audio as a base64 string inside audios[0]; this decodes it and
    returns raw WAV bytes."""
    language_code = resolve_language_code(language)
    api_key = _require_api_key()

    payload: dict = {
        "text": text,
        "language_code": language_code,
        "model": settings.sarvam_tts_model,
        "output_audio_codec": "wav",
    }
    if speaker:
        payload["speaker"] = speaker

    try:
        response = requests.post(
            f"{_BASE_URL}/text-to-speech",
            headers={"api-subscription-key": api_key, "Content-Type": "application/json"},
            json=payload,
            timeout=_TIMEOUT_SECONDS,
        )
    except requests.exceptions.Timeout:
        raise SarvamApiError("Sarvam AI took too long to respond. Please try again.", status_code=504) from None
    except requests.exceptions.RequestException:
        raise SarvamApiError("Unable to connect to Sarvam AI. Please try again.", status_code=502) from None

    if response.status_code == 403:
        raise SarvamApiError("Voice service authentication failed.", status_code=502)
    if not response.ok:
        raise SarvamApiError("Unable to generate speech for this response. Please try again.", status_code=502)

    data = response.json()
    audios = data.get("audios") or []
    if not audios:
        raise SarvamApiError("Unable to generate speech for this response. Please try again.", status_code=502)

    return base64.b64decode(audios[0])

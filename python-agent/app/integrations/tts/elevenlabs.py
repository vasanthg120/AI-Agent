"""ElevenLabs adapter — the Australian, American and British English voices
Sarvam can't speak.

The voice catalog (backend/src/voice/catalog) deliberately holds no ElevenLabs
voice ids: every account's voice library differs and ElevenLabs renames and
retires voices. A catalog entry is a *selector* — {accent, gender, variant} —
resolved here against the connected account's own voice list. No match means
the voice is reported unavailable (never a made-up one) and the backend falls
back to the organization's default.

API shapes below are from docs.elevenlabs.io (text-to-speech convert, list
voices v2). Only verifiable end to end with a connected key.
"""

import hashlib
import logging
import re
import threading
import time
from typing import Optional
from urllib.parse import quote

import requests

from app.config import settings
from app.integrations.tts.base import TtsError, TtsResult, VoiceAvailability
from app.memory import integration_store

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.elevenlabs.io"
_TIMEOUT_SECONDS = 30
# Listing voices backs the settings page's availability check (NestJS gives up
# on it after 8s) — it must fail fast rather than hold a request for the full
# synthesis timeout.
_LIST_TIMEOUT_SECONDS = 10
# mp3 rather than wav: wav_* output formats are tier-restricted on ElevenLabs,
# mp3_44100_128 is its documented default and works on every plan. Browsers
# play both through the same <audio> element.
_OUTPUT_FORMAT = "mp3_44100_128"
_MEDIA_TYPE = "audio/mpeg"

_VOICE_LIST_TTL_SECONDS = 600
_VOICE_LIST_PAGE_SIZE = 100  # API maximum
_VOICE_LIST_MAX_PAGES = 5  # 500 voices — far beyond any account's usable set; bounds a runaway pagination loop

# personality -> (stability, style, speed). Lower stability = more expressive and
# variable delivery; style exaggerates the speaker's own manner; speed is
# ElevenLabs' 0.7-1.2 range. Tuned presets meant to be adjusted by ear, not
# fixed truth. Unset personality sends no voice_settings at all, so the voice
# keeps the delivery ElevenLabs stored for it.
PERSONALITY_PRESETS: dict[str, tuple[float, float, float]] = {
    "professional": (0.65, 0.10, 1.00),
    "friendly": (0.45, 0.35, 1.03),
    "conversational": (0.42, 0.30, 1.00),
    "confident": (0.60, 0.40, 1.00),
    "empathetic": (0.55, 0.25, 0.93),
    "energetic": (0.30, 0.55, 1.10),
    "calm": (0.75, 0.05, 0.90),
}
_SIMILARITY_BOOST = 0.75

# Words in a voice's labels (use case, descriptive tag, ...) that make it read
# as a business voice. Used only to tell the "Professional" variant apart from
# the plain one when an account has more than one matching voice.
_PROFESSIONAL_HINTS = ("professional", "news", "narrat", "informative", "corporate", "business", "customer", "authoritative")

_voice_cache_lock = threading.Lock()
_voice_cache: dict = {"fingerprint": None, "at": 0.0, "voices": []}


def _norm(value) -> str:
    return str(value or "").strip().lower()


def _require_api_key() -> str:
    # Platform-wide credential ONLY (organizationId="platform"), same rule as
    # sarvam_client._require_api_key — set via Platform Admin -> AI Provider.
    key = integration_store.get_api_key("elevenlabs", organization_id="platform")
    if not key:
        raise TtsError("ElevenLabs isn't connected — an administrator needs to add its key in Platform Admin.", 503)
    return key


def _error_status(response: requests.Response) -> str:
    """ElevenLabs' machine-readable error tag (detail.status), when it sends one."""
    try:
        detail = response.json().get("detail")
    except (ValueError, AttributeError):
        return ""
    return _norm(detail.get("status")) if isinstance(detail, dict) else ""


def _missing_permission(response: requests.Response) -> str:
    """The permission name from ElevenLabs' "missing the permission voices_read"
    message. Only ever a bare identifier (safe to show), never other text."""
    try:
        message = str(response.json().get("detail", {}).get("message", ""))
    except (ValueError, AttributeError):
        return ""
    # ElevenLabs permission names are snake_case with at least one underscore
    # (voices_read, text_to_speech) — requiring that keeps stray words out.
    match = re.search(r"missing the permission\s+([a-z]+(?:_[a-z]+)+)", message)
    return match.group(1) if match else ""


def _call(method: str, path: str, api_key: str, timeout: float = _TIMEOUT_SECONDS, **kwargs) -> requests.Response:
    """One ElevenLabs request. Returns the response only on success; every
    failure becomes a TtsError whose message is safe to show a user — the real
    status and body go to the log, never to the caller."""
    try:
        response = requests.request(
            method,
            f"{_BASE_URL}{path}",
            headers={"xi-api-key": api_key, **kwargs.pop("headers", {})},
            timeout=timeout,
            **kwargs,
        )
    except requests.exceptions.Timeout:
        logger.warning("ElevenLabs %s %s timed out after %ss", method, path, timeout)
        raise TtsError("ElevenLabs took too long to respond. Please try again.", 504) from None
    except requests.exceptions.RequestException as exc:
        logger.warning("ElevenLabs %s %s connection error: %s", method, path, exc)
        raise TtsError("Unable to connect to ElevenLabs. Please try again.", 502) from None

    if response.ok:
        return response

    logger.warning("ElevenLabs %s %s failed: status=%s body=%s", method, path, response.status_code, response.text[:500])
    error_status = _error_status(response)
    if error_status == "quota_exceeded":
        raise TtsError("The ElevenLabs character quota has been used up. An administrator needs to top it up.", 429)
    if error_status == "missing_permissions":
        # A valid but restricted key (ElevenLabs lets you scope keys) — a distinct
        # problem from a bad key: reconnecting the same key won't fix it.
        permission = _missing_permission(response)
        raise TtsError(
            f"The saved ElevenLabs key is missing the {permission or 'required'} permission. "
            "Enable it on the key in ElevenLabs, then reconnect it in Platform Admin.",
            502,
        )
    if response.status_code in (401, 403):
        raise TtsError("ElevenLabs rejected its saved key — an administrator needs to reconnect it in Platform Admin.", 502)
    if response.status_code == 429:
        raise TtsError("ElevenLabs is busy right now. Please try again in a moment.", 429)
    if response.status_code == 402:
        raise TtsError("This voice needs a paid ElevenLabs plan.", 502)
    raise TtsError(
        "Unable to generate speech for this response. Please try again.",
        response.status_code if 400 <= response.status_code < 500 else 502,
    )


def ping() -> None:
    """The cheapest real call with the stored key (list one voice) — what
    Platform Admin's "Verify" button runs. Raises TtsError when it fails."""
    _call("GET", "/v2/voices", _require_api_key(), timeout=_LIST_TIMEOUT_SECONDS, params={"page_size": 1})


def _fetch_account_voices(api_key: str) -> list[dict]:
    voices: list[dict] = []
    page_token: Optional[str] = None
    for _ in range(_VOICE_LIST_MAX_PAGES):
        params: dict = {"page_size": _VOICE_LIST_PAGE_SIZE}
        if page_token:
            params["next_page_token"] = page_token
        body = _call("GET", "/v2/voices", api_key, timeout=_LIST_TIMEOUT_SECONDS, params=params).json()
        voices.extend(body.get("voices") or [])
        page_token = body.get("next_page_token")
        if not body.get("has_more") or not page_token:
            break
    return voices


def _account_voices(api_key: str) -> list[dict]:
    # Cached per key: reconnecting a different ElevenLabs account changes the
    # fingerprint, so its voices are never mixed up with the old account's.
    fingerprint = hashlib.sha256(api_key.encode()).hexdigest()[:16]
    with _voice_cache_lock:
        fresh = time.monotonic() - _voice_cache["at"] < _VOICE_LIST_TTL_SECONDS
        if _voice_cache["fingerprint"] == fingerprint and fresh:
            return _voice_cache["voices"]
    voices = _fetch_account_voices(api_key)  # network call kept outside the lock
    with _voice_cache_lock:
        _voice_cache.update(fingerprint=fingerprint, at=time.monotonic(), voices=voices)
    return voices


def _accent_matches(label: str, wanted: str) -> bool:
    # "american-southern" / "british essex" still count as their base accent;
    # an exact label is preferred in _rank.
    return label == wanted or label.startswith(f"{wanted}-") or label.startswith(f"{wanted} ")


def _sounds_professional(voice: dict) -> bool:
    text = " ".join(_norm(v) for v in (voice.get("labels") or {}).values())
    return any(hint in text for hint in _PROFESSIONAL_HINTS)


def _rank(voice: dict, accent: str, prefer_professional: bool) -> tuple:
    # Deterministic order (never dict/API ordering) so a card always maps to the
    # same voice: exact accent, ElevenLabs' own premade voices (usable on every
    # plan, unlike library voices), then the requested register, then name.
    labels = voice.get("labels") or {}
    return (
        _norm(labels.get("accent")) != accent,
        _norm(voice.get("category")) != "premade",
        _sounds_professional(voice) != prefer_professional,
        _norm(voice.get("name")),
        _norm(voice.get("voice_id")),
    )


def _pick_voice(voices: list[dict], voice_ref: dict) -> Optional[dict]:
    accent, gender = _norm(voice_ref.get("accent")), _norm(voice_ref.get("gender"))
    if not accent or not gender:
        return None
    matches = [
        v
        for v in voices
        if v.get("voice_id")
        and _norm((v.get("labels") or {}).get("gender")) == gender
        and _accent_matches(_norm((v.get("labels") or {}).get("accent")), accent)
    ]
    if not matches:
        return None
    standard = min(matches, key=lambda v: _rank(v, accent, prefer_professional=False))
    if _norm(voice_ref.get("variant")) != "professional":
        return standard
    # "Professional" is a second, business-sounding voice when the account has
    # one; otherwise the same voice — the professional personality preset still
    # sets it apart in delivery.
    by_professional_rank = sorted(matches, key=lambda v: _rank(v, accent, prefer_professional=True))
    return next((v for v in by_professional_rank if v["voice_id"] != standard["voice_id"]), standard)


def _no_match(voice_ref: dict) -> TtsError:
    return TtsError(
        f"The connected ElevenLabs account has no {_norm(voice_ref.get('accent')).title()} "
        f"{_norm(voice_ref.get('gender'))} voice yet.",
        404,
    )


def _language_base(language: str) -> str:
    return _norm(language).split("-")[0]


class ElevenLabsTtsProvider:
    id = "elevenlabs"

    def is_configured(self) -> bool:
        return bool(integration_store.get_api_key("elevenlabs", organization_id="platform"))

    def check_voices(self, voice_refs: list[dict]) -> list[VoiceAvailability]:
        try:
            voices = _account_voices(_require_api_key())
        except TtsError as err:
            # One provider-wide answer for every voice — not-connected, bad key,
            # unreachable — so each card can show the real reason.
            return [VoiceAvailability(False, err.user_message)] * len(voice_refs)
        return [
            VoiceAvailability(True)
            if _pick_voice(voices, ref)
            else VoiceAvailability(False, _no_match(ref).user_message)
            for ref in voice_refs
        ]

    def synthesize(self, text: str, voice_ref: dict, language: str, personality: Optional[str]) -> TtsResult:
        # The backend sends non-English speech (Tamil, Hindi, ...) to Sarvam;
        # reaching here in another language is a routing bug, and an English
        # voice quietly mispronouncing it would be worse than a clear error.
        if _language_base(language) != "en":
            raise TtsError("This voice only speaks English.", 400)

        api_key = _require_api_key()
        voice = _pick_voice(_account_voices(api_key), voice_ref)
        if voice is None:
            raise _no_match(voice_ref)

        body: dict = {"text": text, "model_id": settings.elevenlabs_tts_model}
        preset = PERSONALITY_PRESETS.get(personality or "")
        if preset:
            stability, style, speed = preset
            body["voice_settings"] = {
                "stability": stability,
                "similarity_boost": _SIMILARITY_BOOST,
                "style": style,
                "speed": speed,
                "use_speaker_boost": True,
            }

        response = _call(
            "POST",
            f"/v1/text-to-speech/{quote(str(voice['voice_id']), safe='')}",
            api_key,
            params={"output_format": _OUTPUT_FORMAT},
            headers={"Accept": _MEDIA_TYPE},
            json=body,
        )
        if not response.content:
            raise TtsError("Unable to generate speech for this response. Please try again.", 502)
        return TtsResult(audio=response.content, media_type=_MEDIA_TYPE)

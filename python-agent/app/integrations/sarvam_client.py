"""Thin wrapper around Sarvam AI's Speech-to-Text and Text-to-Speech REST
APIs (https://docs.sarvam.ai/) — verified against their current API
reference at implementation time, not assumed from older examples.

This module owns ONLY the HTTP call to Sarvam. It has no idea about
conversations, agents, or billing — that's app/routes/voice.py's job, and
the existing chat pipeline's job for anything downstream of a transcript.
"""

import base64
import json
import logging
import os
import tempfile
from typing import Optional

import requests
from sarvamai import SarvamAI
from sarvamai.speech_to_text_job.job import SpeechToTextJob

from app.config import settings
from app.memory import integration_store

logger = logging.getLogger(__name__)

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
            # A real browser's MediaRecorder reports mimeType as
            # "audio/webm;codecs=opus" (the ';codecs=' parameter included) —
            # both VoiceInputModal.tsx and useSegmentedRecording.ts pick this
            # as their first candidate since it's what Chrome/Edge/Firefox
            # actually support. Sarvam's own allow-list only contains the
            # bare "audio/webm" (confirmed via its own 400 error body), so it
            # rejects the codec-qualified string outright — every real
            # recording failed this way while every synthetic test using a
            # bare "audio/webm" string (this file's own earlier manual tests
            # included) passed, which is why it looked healthy until now.
            files={"file": (filename, file_bytes, (content_type or "application/octet-stream").split(";")[0].strip())},
            timeout=_TIMEOUT_SECONDS,
        )
    except requests.exceptions.Timeout:
        logger.warning("Sarvam speech-to-text timed out after %ss", _TIMEOUT_SECONDS)
        raise SarvamApiError("Sarvam AI took too long to respond. Please try again.", status_code=504) from None
    except requests.exceptions.RequestException as exc:
        logger.warning("Sarvam speech-to-text connection error: %s", exc)
        raise SarvamApiError("Unable to connect to Sarvam AI. Please try again.", status_code=502) from None

    if response.status_code == 403:
        logger.warning("Sarvam speech-to-text auth failed: body=%s", response.text[:500])
        raise SarvamApiError("Voice service authentication failed.", status_code=502)
    if not response.ok:
        # Logged with the REAL upstream status/body (a 429 rate-limit, a
        # transient 5xx, a malformed-request 400, ...) even though the
        # user-facing message stays generic — this is the one place that
        # tells you WHY a segment failed after the fact, since the frontend
        # only ever sees "A moment of audio could not be transcribed."
        # Previously this was hardcoded to 502 regardless of what Sarvam
        # actually returned, so every failure looked identical in hindsight.
        logger.warning(
            "Sarvam speech-to-text call failed: status=%s body=%s", response.status_code, response.text[:500]
        )
        raise SarvamApiError("Speech could not be recognized. Please try again.", status_code=response.status_code)

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
        logger.warning("Sarvam text-to-speech timed out after %ss", _TIMEOUT_SECONDS)
        raise SarvamApiError("Sarvam AI took too long to respond. Please try again.", status_code=504) from None
    except requests.exceptions.RequestException as exc:
        logger.warning("Sarvam text-to-speech connection error: %s", exc)
        raise SarvamApiError("Unable to connect to Sarvam AI. Please try again.", status_code=502) from None

    if response.status_code == 403:
        logger.warning("Sarvam text-to-speech auth failed: body=%s", response.text[:500])
        raise SarvamApiError("Voice service authentication failed.", status_code=502)
    if not response.ok:
        # See transcribe_audio's identical comment — real status/body logged,
        # generic message kept for the caller, real status_code propagated
        # instead of a hardcoded 502.
        logger.warning(
            "Sarvam text-to-speech call failed: status=%s body=%s", response.status_code, response.text[:500]
        )
        raise SarvamApiError("Unable to generate speech for this response. Please try again.", status_code=response.status_code)

    data = response.json()
    audios = data.get("audios") or []
    if not audios:
        logger.warning("Sarvam text-to-speech returned no audio: body=%s", response.text[:500])
        raise SarvamApiError("Unable to generate speech for this response. Please try again.", status_code=502)

    return base64.b64decode(audios[0])


# --- Batch STT (uploaded call recordings) ---------------------------------
#
# transcribe_audio() above wraps the SYNCHRONOUS /speech-to-text endpoint,
# which Sarvam's own docs describe as "for quick responses under 30 seconds"
# — exactly right for a live call's ~7s segments, categorically wrong for a
# 10-30+ minute uploaded recording. Sarvam's separate Batch STT API is built
# for that case (files up to 2 hours, optional speaker diarization). Unlike
# the sync endpoint above (a single well-documented REST call, hand-rolled
# directly), the batch workflow's exact HTTP mechanics (a presigned-URL file
# upload step) aren't documented in a way that's safe to hand-roll — this
# uses Sarvam's own official `sarvamai` SDK instead, confirmed against its
# actual installed source (not just docs) at implementation time:
# SpeechToTextJobClient.create_job(...) -> SpeechToTextJob, whose
# .upload_files(file_paths=[...]) takes real filesystem paths (hence the
# temp-file write below — FastAPI's UploadFile arrives as bytes/a spooled
# file, not a path), .start() kicks off processing, .get_status() and
# .download_outputs(dir) are stateless-by-job_id (a fresh SpeechToTextJob(job_id,
# client) instance in a LATER, separate request can call them — confirmed via
# SpeechToTextJob.__init__(self, job_id, client) accepting just an id), which
# is exactly what this app's create-job-then-poll-separately split needs
# across two separate FastAPI requests.


def _sarvam_sdk_client() -> SarvamAI:
    return SarvamAI(api_subscription_key=_require_api_key())


def start_batch_transcription(
    file_bytes: bytes,
    filename: str,
    language: str,
    *,
    with_diarization: bool = True,
    num_speakers: int = 2,
) -> str:
    """Creates a Sarvam batch STT job, uploads the recording, and starts
    processing — returns immediately with a job_id once started; the actual
    transcription runs asynchronously on Sarvam's side (routes/call_copilot.py's
    caller polls get_batch_job_status separately, never blocking one HTTP
    request for the job's full duration)."""
    language_code = resolve_language_code(language)
    client = _sarvam_sdk_client()

    ext = os.path.splitext(filename)[1] or ".webm"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name

        try:
            job = client.speech_to_text_job.create_job(
                model="saaras:v4",
                mode="transcribe",
                language_code=language_code,
                with_diarization=with_diarization,
                num_speakers=num_speakers if with_diarization else None,
            )
            job.upload_files(file_paths=[tmp_path])
            job.start()
        except Exception as exc:  # noqa: BLE001 - any SDK/HTTP failure here is a real, user-facing Sarvam error
            logger.warning("Sarvam batch STT job creation failed: %s", exc)
            raise SarvamApiError("Could not start processing this recording. Please try again.", status_code=502) from exc

        return job.job_id
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


def get_batch_job_status(job_id: str) -> dict:
    """Returns {"state": "queued"|"processing"|"completed"|"failed", "errorMessage": str|None}.
    Sarvam's own job_state values (confirmed via the SDK's JobStatusResponse
    type) are "Accepted"/"Pending"/"Running"/"Completed"/"Failed" — normalized
    to a smaller set here since the caller only needs to distinguish
    not-done/done/failed, not Sarvam's internal queueing stages."""
    client = _sarvam_sdk_client()
    job = SpeechToTextJob(job_id=job_id, client=client.speech_to_text_job)
    try:
        status = job.get_status()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Sarvam batch STT status check failed for job %s: %s", job_id, exc)
        raise SarvamApiError("Could not check the recording's processing status.", status_code=502) from exc

    state = (status.job_state or "").lower()
    if state in ("accepted", "pending", "running"):
        normalized = "processing"
    elif state == "completed":
        normalized = "completed"
    elif state == "failed":
        normalized = "failed"
    else:
        normalized = "processing"  # unknown/new Sarvam state — treat as still-in-progress, never silently "done"

    return {"state": normalized, "errorMessage": status.error_message if normalized == "failed" else None}


def download_batch_job_result(job_id: str) -> dict:
    """Once get_batch_job_status(job_id) reports "completed": downloads the
    output JSON and returns {"transcript": str, "entries": [{"text","speaker","startSeconds","endSeconds"}]}.
    `entries` is the diarized breakdown (empty list if diarization wasn't
    requested/available — caller falls back to the single `transcript` field
    in that case)."""
    client = _sarvam_sdk_client()
    job = SpeechToTextJob(job_id=job_id, client=client.speech_to_text_job)

    with tempfile.TemporaryDirectory() as tmp_dir:
        try:
            job.download_outputs(tmp_dir)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Sarvam batch STT result download failed for job %s: %s", job_id, exc)
            raise SarvamApiError("Could not retrieve the transcription result.", status_code=502) from exc

        transcript_parts: list[str] = []
        entries: list[dict] = []
        for name in os.listdir(tmp_dir):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(tmp_dir, name), "r", encoding="utf-8") as f:
                data = json.load(f)
            transcript_parts.append(data.get("transcript") or "")
            diarized = data.get("diarized_transcript") or {}
            for entry in diarized.get("entries") or []:
                entries.append(
                    {
                        "text": entry.get("transcript") or "",
                        "speaker": entry.get("speaker_id"),
                        "startSeconds": entry.get("start_time_seconds"),
                        "endSeconds": entry.get("end_time_seconds"),
                    }
                )

        return {"transcript": " ".join(p for p in transcript_parts if p), "entries": entries}

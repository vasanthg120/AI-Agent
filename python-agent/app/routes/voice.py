from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from app.integrations.sarvam_client import SarvamApiError, SUPPORTED_LANGUAGES, transcribe_audio
from app.integrations.tts import DEFAULT_PROVIDER, PERSONALITIES, TtsError, VoiceAvailability, get_provider
from app.security import get_current_user

router = APIRouter()

# Generous but bounded — a voice utterance is a short chat turn, not a file
# upload; this also matches the browser MediaRecorder use case this endpoint
# is actually built for (a few seconds to ~2 minutes of speech).
_MAX_AUDIO_BYTES = 20 * 1024 * 1024


class TranscribeResponse(BaseModel):
    transcript: str
    languageCode: str


@router.post("/voice/transcribe", response_model=TranscribeResponse)
async def transcribe(
    audio: UploadFile = File(...),
    languageCode: str = Form(...),
    user: dict = Depends(get_current_user),
):
    content = await audio.read()
    if not content:
        raise HTTPException(422, "The recording was empty. Please try again.")
    if len(content) > _MAX_AUDIO_BYTES:
        raise HTTPException(422, "This recording is too long — please keep it under 2 minutes.")

    try:
        result = transcribe_audio(content, audio.filename or "audio", audio.content_type or "", languageCode)
    except SarvamApiError as err:
        raise HTTPException(err.status_code or 502, err.user_message) from None

    if not result["transcript"].strip():
        raise HTTPException(422, "Speech could not be recognized. Please try again.")

    return TranscribeResponse(transcript=result["transcript"], languageCode=result["language_code"])


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2500)
    languageCode: str
    # Which engine speaks, which of its voices, and in what manner — all
    # resolved by NestJS from the caller's Voice & Accent configuration (see
    # backend/src/voice/voice-config.service.ts). Omitted, this is exactly the
    # behavior from before voice configuration existed: Sarvam's own default
    # speaker.
    provider: str = DEFAULT_PROVIDER
    voiceRef: dict = Field(default_factory=dict)
    personality: str | None = None

    @field_validator("personality")
    @classmethod
    def _known_personality(cls, value: str | None) -> str | None:
        if value is not None and value not in PERSONALITIES:
            raise ValueError(f"personality must be one of: {', '.join(PERSONALITIES)}")
        return value


@router.post("/voice/speak")
def speak(body: SpeakRequest, user: dict = Depends(get_current_user)):
    try:
        result = get_provider(body.provider).synthesize(body.text, body.voiceRef, body.languageCode, body.personality)
    except TtsError as err:
        raise HTTPException(err.status_code or 502, err.user_message) from None

    # media_type comes from the provider — Sarvam returns WAV, ElevenLabs MP3.
    return Response(content=result.audio, media_type=result.media_type)


class AvailabilityVoice(BaseModel):
    voiceId: str
    provider: str
    voiceRef: dict = Field(default_factory=dict)


class AvailabilityRequest(BaseModel):
    voices: list[AvailabilityVoice] = Field(..., max_length=64)


@router.post("/voice/availability")
def availability(body: AvailabilityRequest, user: dict = Depends(get_current_user)):
    """Whether each catalog voice can be spoken right now — the provider's key
    is on file and it actually has that voice. Makes no synthesis calls (no
    cost); NestJS caches the answer briefly and uses it to grey out cards and
    to fall back when a chosen voice has gone away."""
    by_provider: dict[str, list[AvailabilityVoice]] = {}
    for voice in body.voices:
        by_provider.setdefault(voice.provider, []).append(voice)

    results: dict[str, dict] = {}
    for provider_id, voices in by_provider.items():
        try:
            checks = get_provider(provider_id).check_voices([v.voiceRef for v in voices])
        except TtsError as err:
            checks = [VoiceAvailability(False, err.user_message)] * len(voices)
        for voice, check in zip(voices, checks):
            results[voice.voiceId] = {"available": check.available, "reason": check.reason}
    return {"voices": results}


@router.get("/voice/languages")
def list_languages(user: dict = Depends(get_current_user)):
    return {"languages": sorted(SUPPORTED_LANGUAGES.keys())}

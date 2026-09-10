from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.integrations.sarvam_client import SarvamApiError, SUPPORTED_LANGUAGES, synthesize_speech, transcribe_audio
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
    speaker: str | None = None


@router.post("/voice/speak")
def speak(body: SpeakRequest, user: dict = Depends(get_current_user)):
    try:
        audio_bytes = synthesize_speech(body.text, body.languageCode, body.speaker)
    except SarvamApiError as err:
        raise HTTPException(err.status_code or 502, err.user_message) from None

    return Response(content=audio_bytes, media_type="audio/wav")


@router.get("/voice/languages")
def list_languages(user: dict = Depends(get_current_user)):
    return {"languages": sorted(SUPPORTED_LANGUAGES.keys())}

"""Real-Time AI Sales Call Copilot — python-agent's four endpoints, called by
backend/src/call-copilot's NestJS module (session lifecycle, GridFS storage,
and Socket.IO relay all live there; this side only ever does one thing per
call: transcribe a segment, fetch context once, analyze a window, or
summarize the whole call).
"""

import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.agent.call_copilot_analysis import analyze_call_segment, summarize_call
from app.config import settings
from app.integrations.sarvam_client import SarvamApiError, transcribe_audio
from app.memory.rate_limiter import allow as rate_limit_allow
from app.security import get_current_user
from app.tools.business_search_tool import run as business_search_run

logger = logging.getLogger(__name__)
router = APIRouter()

# Same "a voice utterance is a short chat turn" sizing rationale as
# routes/voice.py, scaled down — a call-copilot segment is a ~6-8 second
# clip (see the frontend's stop/restart MediaRecorder cadence), not a full
# chat-turn-length utterance.
_MAX_SEGMENT_BYTES = 5 * 1024 * 1024


class ContextRequest(BaseModel):
    sessionId: str
    query: str
    dealId: str | None = None
    contactId: str | None = None


class ContextResponse(BaseModel):
    contextBlob: str


@router.post("/call-copilot/context", response_model=ContextResponse)
def get_context(body: ContextRequest, user: dict = Depends(get_current_user)):
    """Fetched ONCE at call start (see call-copilot.service.ts) — never
    re-fetched mid-call. Reuses business_search_tool.run() directly as a
    plain function call (no execute_tool()/tool-loop round trip needed,
    same as this tool's own docstring already documents it's built for),
    which already merges CRM + shared documents + business knowledge +
    Mem0 memory into one context blob."""
    result = business_search_run(
        {"query": body.query, "source": "all"},
        {"user_id": user["sub"], "organization_id": user.get("organizationId")},
    )
    return ContextResponse(contextBlob=result)


class TranscribeResponse(BaseModel):
    transcript: str


@router.post("/call-copilot/transcribe", response_model=TranscribeResponse)
async def transcribe_segment(
    audio: UploadFile = File(...),
    languageCode: str = Form(...),
    user: dict = Depends(get_current_user),
):
    content = await audio.read()
    if not content:
        # An empty/silent segment is normal (a pause in conversation) — not
        # an error, just nothing to transcribe this cycle.
        return TranscribeResponse(transcript="")
    if len(content) > _MAX_SEGMENT_BYTES:
        raise HTTPException(422, "Audio segment too large.")

    try:
        result = transcribe_audio(content, audio.filename or "segment", audio.content_type or "", languageCode)
    except SarvamApiError as err:
        raise HTTPException(err.status_code or 502, err.user_message) from None

    return TranscribeResponse(transcript=result["transcript"])


class AnalyzeRequest(BaseModel):
    sessionId: str
    contextBlob: str
    transcriptWindow: str
    alreadyDetected: list[str] = []


class AnalyzeResponse(BaseModel):
    skipped: bool
    sentiment: str | None = None
    events: list[dict] = []
    recommendations: list[dict] = []


@router.post("/call-copilot/analyze", response_model=AnalyzeResponse)
def analyze(body: AnalyzeRequest, user: dict = Depends(get_current_user)):
    """The throttle decision lives HERE, not in NestJS — rate_limiter.allow()
    is Redis infra this app already owns, so backend just calls this after
    every new transcribed segment and trusts the response to say whether
    anything actually ran. Two independent gates, both must pass:
    (1) at most one real analysis per call_copilot_analysis_interval_seconds
    for this session, (2) at least call_copilot_min_new_words of new
    transcript this cycle — a silent stretch of a call shouldn't burn a
    Claude call just because the clock ran out."""
    word_count = len(body.transcriptWindow.split())
    if word_count < settings.call_copilot_min_new_words:
        return AnalyzeResponse(skipped=True)

    if not rate_limit_allow(
        f"call_copilot_analysis:{body.sessionId}",
        1,
        settings.call_copilot_analysis_interval_seconds,
    ):
        return AnalyzeResponse(skipped=True)

    try:
        result = analyze_call_segment(
            body.contextBlob,
            body.transcriptWindow,
            body.alreadyDetected,
            organization_id=user.get("organizationId"),
            user_id=user["sub"],
        )
    except Exception:
        logger.exception("Call copilot analysis failed for session %s", body.sessionId)
        # A failed analysis cycle must never take down the call session —
        # the transcript keeps flowing either way; this cycle's coaching
        # signals are just skipped, same as a throttled one from the
        # frontend's point of view (see call-copilot.gateway.ts's
        # 'call:warning' handling).
        return AnalyzeResponse(skipped=True)

    return AnalyzeResponse(
        skipped=False,
        sentiment=result.get("sentiment"),
        events=result.get("events", []),
        recommendations=result.get("recommendations", []),
    )


class SummarizeRequest(BaseModel):
    sessionId: str
    contextBlob: str
    fullTranscript: str
    detectedEvents: list[str] = []


class SummarizeResponse(BaseModel):
    summary: str
    keyTakeaways: list[str]
    followUpActions: list[dict]


@router.post("/call-copilot/summarize", response_model=SummarizeResponse)
def summarize(body: SummarizeRequest, user: dict = Depends(get_current_user)):
    if not body.fullTranscript.strip():
        return SummarizeResponse(summary="No speech was transcribed during this call.", keyTakeaways=[], followUpActions=[])

    result = summarize_call(
        body.contextBlob,
        body.fullTranscript,
        body.detectedEvents,
        organization_id=user.get("organizationId"),
        user_id=user["sub"],
    )
    return SummarizeResponse(
        summary=result.get("summary", ""),
        keyTakeaways=result.get("keyTakeaways", []),
        followUpActions=result.get("followUpActions", []),
    )

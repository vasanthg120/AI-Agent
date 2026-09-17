"""Real-Time AI Sales Call Copilot — python-agent's four endpoints, called by
backend/src/call-copilot's NestJS module (session lifecycle, GridFS storage,
and Socket.IO relay all live there; this side only ever does one thing per
call: transcribe a segment, fetch context once, analyze a window, or
summarize the whole call).
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.agent.call_copilot_analysis import analyze_call_segment, summarize_call
from app.config import settings
from app.integrations.sarvam_client import (
    SarvamApiError,
    download_batch_job_result,
    get_batch_job_status,
    start_batch_transcription,
    transcribe_audio,
)
from app.memory.rate_limiter import allow as rate_limit_allow
from app.rag.embeddings import embed
from app.rag.retriever import retrieve_call_recordings
from app.rag.splitter import split_text
from app.rag.vector_store import delete_by_document_id, upsert_chunks
from app.security import get_current_user
from app.tools.business_search_tool import run as business_search_run

logger = logging.getLogger(__name__)
router = APIRouter()

# Same "a voice utterance is a short chat turn" sizing rationale as
# routes/voice.py, scaled down — a call-copilot segment is a ~6-8 second
# clip (see the frontend's stop/restart MediaRecorder cadence), not a full
# chat-turn-length utterance.
_MAX_SEGMENT_BYTES = 5 * 1024 * 1024

# Deterministic prefix for a call session's Qdrant document_id — lets
# /call-copilot/index re-index the same session idempotently (delete then
# re-upsert, never accumulating stale duplicate chunks) and lets /search
# recover the sessionId from a hit's document_id with no extra payload field.
_CALL_DOCUMENT_ID_PREFIX = "call_session:"


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
    # "live": both throttle gates apply (real-time pacing). "batch": the
    # interval gate is skipped — an uploaded recording's analysis passes run
    # in a tight loop over an already-complete transcript, not paced against
    # a live clock, so there's no "wait for the next interval" to obey. The
    # min-new-words gate still applies in both modes (a near-empty window
    # isn't worth a Claude call either way). Defaults to "live" so every
    # existing caller's behavior is byte-for-byte unchanged.
    mode: Literal["live", "batch"] = "live"


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
    anything actually ran. Two independent gates for live mode, both must
    pass: (1) at most one real analysis per call_copilot_analysis_interval_seconds
    for this session, (2) at least call_copilot_min_new_words of new
    transcript this cycle — a silent stretch of a call shouldn't burn a
    Claude call just because the clock ran out. Batch mode (uploaded
    recordings) skips gate (1) — see AnalyzeRequest.mode."""
    word_count = len(body.transcriptWindow.split())
    if word_count < settings.call_copilot_min_new_words:
        return AnalyzeResponse(skipped=True)

    if body.mode == "live" and not rate_limit_allow(
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
    headline: str
    outcome: str
    summaryPoints: list[str]
    customerNeeds: list[str]
    concernsRaised: list[str]
    keyTakeaways: list[str]
    followUpActions: list[dict]


@router.post("/call-copilot/summarize", response_model=SummarizeResponse)
def summarize(body: SummarizeRequest, user: dict = Depends(get_current_user)):
    if not body.fullTranscript.strip():
        return SummarizeResponse(
            headline="No speech was transcribed during this call.",
            outcome="not_applicable",
            summaryPoints=[],
            customerNeeds=[],
            concernsRaised=[],
            keyTakeaways=[],
            followUpActions=[],
        )

    result = summarize_call(
        body.contextBlob,
        body.fullTranscript,
        body.detectedEvents,
        organization_id=user.get("organizationId"),
        user_id=user["sub"],
    )
    return SummarizeResponse(
        headline=result.get("headline", ""),
        outcome=result.get("outcome", "not_applicable"),
        summaryPoints=result.get("summaryPoints", []),
        customerNeeds=result.get("customerNeeds", []),
        concernsRaised=result.get("concernsRaised", []),
        keyTakeaways=result.get("keyTakeaways", []),
        followUpActions=result.get("followUpActions", []),
    )


# --- Uploaded recordings (batch STT) --------------------------------------
#
# A whole pre-recorded call is orders of magnitude longer than the ~7s clips
# /call-copilot/transcribe above is sized for (Sarvam's sync endpoint is
# documented as "for quick responses under 30 seconds") — these two routes
# instead drive Sarvam's separate Batch STT API (files up to 2 hours, see
# sarvam_client.py's own comment). Job creation/upload/start is fast (well
# under NestJS's 60s HttpModule timeout); the actual transcription happens
# asynchronously on Sarvam's side, polled by the second route — never one
# long-blocking request.


class UploadTranscribeJobResponse(BaseModel):
    jobId: str


@router.post("/call-copilot/upload/transcribe-job", response_model=UploadTranscribeJobResponse)
async def create_upload_transcribe_job(
    audio: UploadFile = File(...),
    languageCode: str = Form(...),
    user: dict = Depends(get_current_user),
):
    content = await audio.read()
    if not content:
        raise HTTPException(422, "The uploaded recording is empty.")

    try:
        job_id = start_batch_transcription(content, audio.filename or "recording", languageCode)
    except SarvamApiError as err:
        raise HTTPException(err.status_code or 502, err.user_message) from None

    return UploadTranscribeJobResponse(jobId=job_id)


class UploadTranscribeSegment(BaseModel):
    sequence: int
    text: str
    speaker: str | None = None
    startSeconds: float | None = None
    endSeconds: float | None = None


class UploadTranscribeJobStatusResponse(BaseModel):
    status: Literal["processing", "completed", "failed"]
    segments: list[UploadTranscribeSegment] = []
    error: str | None = None


@router.get("/call-copilot/upload/transcribe-job/{job_id}", response_model=UploadTranscribeJobStatusResponse)
def get_upload_transcribe_job(job_id: str, user: dict = Depends(get_current_user)):
    """NestJS polls this every ~8-10s (see call-copilot-upload.service.ts).
    Only downloads the actual result once Sarvam reports the job complete —
    every earlier poll is a cheap status-only check."""
    try:
        status = get_batch_job_status(job_id)
    except SarvamApiError as err:
        raise HTTPException(err.status_code or 502, err.user_message) from None

    if status["state"] == "failed":
        return UploadTranscribeJobStatusResponse(status="failed", error=status["errorMessage"] or "Transcription failed.")
    if status["state"] == "processing":
        return UploadTranscribeJobStatusResponse(status="processing")

    try:
        result = download_batch_job_result(job_id)
    except SarvamApiError as err:
        raise HTTPException(err.status_code or 502, err.user_message) from None

    if result["entries"]:
        segments = [
            UploadTranscribeSegment(
                sequence=i,
                text=e["text"],
                speaker=e["speaker"],
                startSeconds=e["startSeconds"],
                endSeconds=e["endSeconds"],
            )
            for i, e in enumerate(result["entries"])
        ]
    else:
        # Diarization wasn't requested/available — fall back to the single
        # whole-file transcript as one segment, same shape either way.
        segments = [UploadTranscribeSegment(sequence=0, text=result["transcript"])]

    return UploadTranscribeJobStatusResponse(status="completed", segments=segments)


# --- Qdrant indexing + search (Call Library) ------------------------------


class IndexCallRequest(BaseModel):
    sessionId: str
    fullTranscript: str
    # Pre-joined by NestJS from headline + summaryPoints + keyTakeaways —
    # this route stays agnostic to the summary's exact shape.
    summaryText: str
    recordedAt: str


class IndexCallResponse(BaseModel):
    vectorDocumentId: str
    chunkCount: int


@router.post("/call-copilot/index", response_model=IndexCallResponse)
def index_call_session(body: IndexCallRequest, user: dict = Depends(get_current_user)):
    """Called from CallCopilotService.endSession() (fire-and-forget, both the
    live and uploaded-recording paths converge there) — indexes the call's
    transcript and summary into the shared Qdrant collection so it surfaces
    in the Call Library's search. Reuses split_text/embed/upsert_chunks
    completely unchanged; only the source_type values are new."""
    organization_id = user.get("organizationId")
    document_id = f"{_CALL_DOCUMENT_ID_PREFIX}{body.sessionId}"
    # Deterministic id -> re-indexing (e.g. a re-run) overwrites cleanly
    # instead of accumulating duplicate chunks from a prior index call.
    delete_by_document_id(document_id)

    chunk_count = 0
    transcript_chunks = split_text(body.fullTranscript) if body.fullTranscript.strip() else []
    if transcript_chunks:
        upsert_chunks(
            document_id,
            user["sub"],
            f"Call — {body.recordedAt}",
            transcript_chunks,
            embed(transcript_chunks),
            source_type="call_recording",
            organization_id=organization_id,
        )
        chunk_count += len(transcript_chunks)

    summary_chunks = split_text(body.summaryText) if body.summaryText.strip() else []
    if summary_chunks:
        upsert_chunks(
            document_id,
            user["sub"],
            f"Call Summary — {body.recordedAt}",
            summary_chunks,
            embed(summary_chunks),
            source_type="call_recording_summary",
            organization_id=organization_id,
        )
        chunk_count += len(summary_chunks)

    return IndexCallResponse(vectorDocumentId=document_id, chunkCount=chunk_count)


class SearchCallsRequest(BaseModel):
    query: str


class SearchCallHit(BaseModel):
    sessionId: str
    score: float
    snippet: str
    sourceType: str


class SearchCallsResponse(BaseModel):
    hits: list[SearchCallHit]


@router.post("/call-copilot/search", response_model=SearchCallsResponse)
def search_calls(body: SearchCallsRequest, user: dict = Depends(get_current_user)):
    organization_id = user.get("organizationId")
    if not organization_id:
        raise HTTPException(400, "organizationId is required")

    raw_hits = retrieve_call_recordings(body.query, organization_id, user["sub"])
    hits: list[SearchCallHit] = []
    seen_sessions: set[str] = set()
    for hit in raw_hits:
        document_id = hit.get("document_id", "")
        if not document_id.startswith(_CALL_DOCUMENT_ID_PREFIX):
            continue
        session_id = document_id[len(_CALL_DOCUMENT_ID_PREFIX):]
        # One session can match on both a transcript chunk AND a summary
        # chunk — keep only the highest-scoring hit per session, since the
        # Library shows one row per call, not one row per matched chunk.
        if session_id in seen_sessions:
            continue
        seen_sessions.add(session_id)
        hits.append(
            SearchCallHit(
                sessionId=session_id,
                score=hit.get("score", 0.0),
                snippet=(hit.get("text") or "")[:280],
                sourceType=hit.get("source_type", "call_recording"),
            )
        )

    return SearchCallsResponse(hits=hits)

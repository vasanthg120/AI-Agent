import io
import mimetypes
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from pypdf import PdfReader

from app.agent.anthropic_client import answer_business_question, extract_business_document, extract_business_document_from_text
from app.models.schemas import (
    BusinessDocumentExtractResponse,
    BusinessKnowledgeChatResponse,
    BusinessKnowledgeChatSource,
    BusinessProfileSyncResponse,
    SourceRef,
)
from app.rag.embeddings import embed
from app.rag.loader import load_text
from app.rag.retriever import retrieve_business_knowledge
from app.rag.splitter import split_text
from app.rag.vector_store import delete_by_document_id, upsert_chunks
from app.security import get_current_user

router = APIRouter()

# Deterministic per-org point id — a business profile is a singleton per
# organization, so re-syncing after every save should update the same
# Qdrant document rather than accumulating stale copies (same uuid5-over-a-
# fixed-namespace idea as app.rag.vector_store.memory_point_id).
_PROFILE_NAMESPACE = uuid.NAMESPACE_URL

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
_TEXT_EXTENSIONS = {".pptx", ".xlsx", ".xls", ".csv", ".docx", ".html", ".htm", ".txt", ".md"}

# Same flagged assumption as finance.py's identical guardrail — re-confirm
# against live Anthropic docs before relying on these long-term.
_MAX_FILE_BYTES = 28 * 1024 * 1024
_MAX_PDF_PAGES = 100


class BusinessProfileSyncRequest(BaseModel):
    organizationId: str
    text: str


class BusinessKnowledgeChatRequest(BaseModel):
    organizationId: str
    question: str
    # Threaded through to traced_llm_call so NestJS's settle() (see
    # backend/src/billing/reservation.service.ts) can find and price this
    # call's agent_executions row — same requestId contract chat.py already
    # uses, just initiated from NestJS instead of Python for this route.
    requestId: str = ""


@router.post("/business-knowledge/profile/sync", response_model=BusinessProfileSyncResponse)
def sync_business_profile(payload: BusinessProfileSyncRequest, user: dict = Depends(get_current_user)):
    if not payload.organizationId:
        raise HTTPException(400, "organizationId is required")

    document_id = str(uuid.uuid5(_PROFILE_NAMESPACE, f"business_profile:{payload.organizationId}"))
    # Idempotent no-op the first time a given org syncs; on every later save
    # this correctly drops the previous chunk set first — otherwise an edit
    # that shortens the profile would leave stale chunks from the longer
    # previous version still retrievable alongside the new ones.
    delete_by_document_id(document_id)

    chunks = split_text(payload.text)
    if chunks:
        vectors = embed(chunks)
        upsert_chunks(
            document_id,
            "*",  # shared org-wide, not private to whoever last saved it
            "Business Profile",
            chunks,
            vectors,
            source_type="business_profile",
            organization_id=payload.organizationId,
        )

    return BusinessProfileSyncResponse(documentId=document_id, chunkCount=len(chunks))


@router.post("/business-knowledge/chat", response_model=BusinessKnowledgeChatResponse)
def chat_business_knowledge(payload: BusinessKnowledgeChatRequest, user: dict = Depends(get_current_user)):
    """Dedicated, business-knowledge-only grounded Q&A — distinct from the
    general chat agent's search_business_context tool, which mixes in CRM/
    Outlook/documents/memories. Retrieval is org-scoped by
    retrieve_business_knowledge (app.rag.retriever) exactly like every other
    business-knowledge read path; this route only adds the numbered-citation
    formatting and the single grounded LLM call.
    """
    if not payload.organizationId:
        raise HTTPException(400, "organizationId is required")

    hits = retrieve_business_knowledge(payload.question, payload.organizationId)

    context_blocks: list[str] = []
    sources: list[BusinessKnowledgeChatSource] = []
    for i, hit in enumerate(hits, start=1):
        context_blocks.append(f"[{i}] ({hit.get('source_type', 'business_knowledge')}) {hit.get('text', '')}")
        sources.append(
            BusinessKnowledgeChatSource(
                index=i,
                sourceType=hit.get("source_type", "business_knowledge"),
                documentId=hit.get("document_id"),
                filename=hit.get("filename"),
                snippet=(hit.get("text") or "")[:280],
            )
        )

    answer = answer_business_question(
        payload.question,
        context_blocks,
        organization_id=payload.organizationId,
        user_id=user.get("sub", ""),
        request_id=payload.requestId,
    )
    return BusinessKnowledgeChatResponse(answer=answer, sources=sources)


@router.post("/business-knowledge/documents/extract", response_model=BusinessDocumentExtractResponse)
async def extract_business_knowledge_document(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    organization_id = user.get("organizationId")
    if not organization_id:
        raise HTTPException(400, "organizationId is required for business document extraction")
    user_id = user.get("sub", "")

    content = await file.read()
    filename = file.filename or "document"
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if len(content) > _MAX_FILE_BYTES:
        raise HTTPException(422, "This document exceeds the size limit for direct processing — split it into smaller files and re-upload")

    text = ""
    if ext == ".pdf":
        try:
            page_count = len(PdfReader(io.BytesIO(content)).pages)
        except Exception:  # noqa: BLE001 - a corrupt/unreadable PDF should 422, not 500
            raise HTTPException(422, "Could not read this PDF — it may be corrupted") from None
        if page_count > _MAX_PDF_PAGES:
            raise HTTPException(
                422,
                f"This PDF has {page_count} pages, over the {_MAX_PDF_PAGES}-page limit for direct "
                "processing — split it into smaller files and re-upload",
            )
        extracted = extract_business_document(content, "application/pdf", filename, organization_id=organization_id, user_id=user_id)
        text = load_text(filename, content)  # text layer, if any — free, already read the bytes above
    elif ext in _IMAGE_EXTENSIONS:
        mime_type = mimetypes.guess_type(filename)[0] or "image/png"
        extracted = extract_business_document(content, mime_type, filename, organization_id=organization_id, user_id=user_id)
    elif ext in _TEXT_EXTENSIONS:
        text = load_text(filename, content)
        if not text.strip():
            raise HTTPException(422, "Could not extract any text from the uploaded document")
        extracted = extract_business_document_from_text(text, filename, organization_id=organization_id, user_id=user_id)
    else:
        raise HTTPException(422, f"Unsupported file type '{ext}' for business knowledge document extraction")

    if not text.strip():
        # Pure image scan with no text layer — same fallback idea as
        # finance.py's _synthesize_rag_text, built from the AI's own summary
        # so the document stays findable via RAG.
        text = f"{extracted.get('title', filename)}\n{extracted.get('summary', '')}"

    document_id = str(uuid.uuid4())
    chunks = split_text(text)
    vector_chunk_count = 0
    if chunks:
        vectors = embed(chunks)
        upsert_chunks(
            document_id,
            "*",  # org-wide asset, not private to the uploader — same reasoning as business_profile
            filename,
            chunks,
            vectors,
            source_type="business_knowledge_document",
            organization_id=organization_id,
        )
        vector_chunk_count = len(chunks)

    return BusinessDocumentExtractResponse(vectorDocumentId=document_id, vectorChunkCount=vector_chunk_count, **extracted)


@router.post("/business-knowledge/documents/discard-source")
def discard_business_document_source(payload: SourceRef, user: dict = Depends(get_current_user)):
    delete_by_document_id(payload.documentId)
    return {"status": "discarded"}

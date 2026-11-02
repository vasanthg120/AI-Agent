import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.agent.anthropic_client import extract_role, extract_role_from_description
from app.models.schemas import (
    RoleGenerateFromDescriptionRequest,
    RoleGenerateFromDescriptionResponse,
    RoleGenerateResponse,
    SourceRef,
)
from app.rag.embeddings import embed
from app.rag.loader import load_text
from app.rag.splitter import split_text
from app.rag.vector_store import delete_by_document_id, reassign_owner, upsert_chunks
from app.security import get_current_user

router = APIRouter()


@router.post("/roles/generate", response_model=RoleGenerateResponse)
async def generate_role(
    file: UploadFile = File(...),
    user_id: str = Form(...),
    user: dict = Depends(get_current_user),
):
    content = await file.read()
    text = load_text(file.filename, content)
    if not text.strip():
        raise HTTPException(422, "Could not extract any text from the uploaded document")

    extracted = extract_role(text, organization_id=user.get("organizationId"), user_id=user_id)

    chunks = split_text(text)
    document_id = str(uuid.uuid4())
    if chunks:
        vectors = embed(chunks)
        # Private (real user_id, not "*") until Nest promotes it on activation —
        # keeps drafts out of everyone else's search_business_context results.
        upsert_chunks(document_id, user_id, file.filename, chunks, vectors)

    return RoleGenerateResponse(
        documentId=document_id,
        chunks=len(chunks),
        sourceDocumentName=file.filename,
        **extracted,
    )


# Agent Builder Phase 1 — Describe method. No file, no Qdrant document; the
# generated persona still gets reviewed/edited in the same frontend form as
# the document path before Nest ever persists it.
@router.post("/roles/generate-from-description", response_model=RoleGenerateFromDescriptionResponse)
def generate_role_from_description(
    payload: RoleGenerateFromDescriptionRequest,
    user: dict = Depends(get_current_user),
):
    extracted = extract_role_from_description(
        payload.description, organization_id=user.get("organizationId"), user_id=payload.user_id
    )
    return RoleGenerateFromDescriptionResponse(**extracted)


@router.post("/roles/publish-source")
def publish_source(payload: SourceRef, user: dict = Depends(get_current_user)):
    reassign_owner(payload.documentId, "*", user.get("organizationId"))
    return {"status": "published"}


@router.post("/roles/discard-source")
def discard_source(payload: SourceRef, user: dict = Depends(get_current_user)):
    delete_by_document_id(payload.documentId)
    return {"status": "discarded"}

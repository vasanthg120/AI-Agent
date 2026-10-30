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
from app.memory.mongo_client import get_db
from app.rag.vector_store import delete_by_document_id, reassign_owner, upsert_chunks
from app.security import assert_user_id_matches, get_current_user

router = APIRouter()


def _assert_may_manage_source(document_id: str, user: dict) -> None:
    """publish-source/discard-source take only a documentId — a caller-
    controlled value with no owner tag of its own once a role is activated
    (Qdrant's document-type points go from a real uploader user_id to the
    shared "*" sentinel on publish, see reassign_owner — so checking the
    Qdrant point's own payload can't be this check: it would correctly
    authorize nothing once a role goes active, breaking the legitimate
    delete-an-active-role path). The real, persisted ownership record is the
    AgentRole document itself (backend's agent_roles collection, which this
    agent already reads elsewhere — see app.agent.personas.resolve_persona):
    every sourceDocumentId was set exactly once, by backend/src/agent-roles/
    agent-roles.service.ts's generateDraft(), onto an AgentRole scoped to a
    real organizationId. Requiring a matching AgentRole in the caller's own
    org — the same organizationId-scoped lookup
    agent-roles.service.ts's own update()/remove() already perform before
    ever calling these routes — mirrors that existing authorization model
    exactly, using data no caller can forge, rather than comparing two
    fields the request itself supplied. Admin is also required, matching
    every other Agent Builder mutation (@Roles('admin') on generate/
    generate-from-description/create/update/remove)."""
    organization_id = user.get("organizationId")
    roles = user.get("roles") or []
    if not organization_id or "admin" not in roles:
        raise HTTPException(403, "Not authorized to manage this role source.")
    owning_role = get_db().agent_roles.find_one(
        {"sourceDocumentId": document_id, "organizationId": organization_id}
    )
    if not owning_role:
        raise HTTPException(403, "Not authorized to manage this role source.")


@router.post("/roles/generate", response_model=RoleGenerateResponse)
async def generate_role(
    file: UploadFile = File(...),
    user_id: str = Form(...),
    user: dict = Depends(get_current_user),
):
    # user_id tags the uploaded document's Qdrant points as this user's own
    # private draft (see upsert_chunks below) — without this check, any
    # caller able to reach this route directly could attribute arbitrary
    # uploaded content to someone else's id, which would then surface in
    # THAT person's own search_business_context results as if it were their
    # own saved document (document-type Qdrant points carry no
    # organization_id, so this would not even stay within one tenant).
    assert_user_id_matches(user_id, user)
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
    # No Qdrant document on this path (see the comment above this route) —
    # user_id here only labels a telemetry trace, but the same check is
    # applied for consistency with generate_role above and in case a future
    # change starts using it for something identity-sensitive.
    assert_user_id_matches(payload.user_id, user)
    extracted = extract_role_from_description(
        payload.description, organization_id=user.get("organizationId"), user_id=payload.user_id
    )
    return RoleGenerateFromDescriptionResponse(**extracted)


@router.post("/roles/publish-source")
def publish_source(payload: SourceRef, user: dict = Depends(get_current_user)):
    _assert_may_manage_source(payload.documentId, user)
    reassign_owner(payload.documentId, "*")
    return {"status": "published"}


@router.post("/roles/discard-source")
def discard_source(payload: SourceRef, user: dict = Depends(get_current_user)):
    _assert_may_manage_source(payload.documentId, user)
    delete_by_document_id(payload.documentId)
    return {"status": "discarded"}

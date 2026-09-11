from fastapi import APIRouter, Depends, HTTPException

from app.agent.anthropic_client import analyze_email
from app.models.schemas import EmailAnalysisResponse
from app.rag.retriever import retrieve_business_knowledge_as_context
from app.security import get_current_user

router = APIRouter()


# Body is the deterministic per-email + CRM-correlation payload
# backend/src/email-intelligence/email-intelligence.service.ts assembled —
# accepted as a raw dict, same reasoning as /customer-activity/analyze and
# /finance/analyze (internal trusted input, shape owned on the NestJS side;
# the output shape is what's contractually enforced, via EMAIL_INTENT_TOOL's
# forced tool_choice). This route is also the one place real-time RAG
# retrieval (Phase 14a's retrieve_business_knowledge_as_context) feeds into
# this specific analysis — a plain function call, not a new chat tool, since
# this is a one-shot structured-output pass, not an agentic tool loop.
@router.post("/email-intelligence/analyze", response_model=EmailAnalysisResponse)
def analyze(payload: dict, user: dict = Depends(get_current_user)):
    organization_id = user.get("organizationId")
    if not organization_id:
        raise HTTPException(400, "organizationId is required for email analysis")

    email = payload.get("email") or {}
    query = f"{email.get('subject', '')} {email.get('preview', '')}".strip()
    kb_context = retrieve_business_knowledge_as_context(query, organization_id) if query else ""

    return EmailAnalysisResponse(
        **analyze_email(
            {**payload, "businessKnowledgeContext": kb_context},
            organization_id=organization_id,
            user_id=user.get("sub", ""),
            request_id=payload.get("request_id", ""),
        )
    )

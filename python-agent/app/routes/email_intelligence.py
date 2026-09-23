from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.agent.anthropic_client import analyze_email, generate_sla_breach_followup_draft
from app.integrations import ms_graph
from app.memory import outlook_store
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


class SlaBreachFollowupDraftRequest(BaseModel):
    subject: str = ""
    bodyPreview: str = ""
    fromAddress: str = ""
    conversationId: str | None = None
    priority: str = "medium"
    # Pre-built by NestJS (backend/src/email-intelligence/email-intelligence.service.ts's
    # createSlaBreachFollowUp) via the existing CustomerActivityService —
    # this route never talks to CRM itself, no new CRM API here.
    crmContext: str | None = None
    requestId: str = ""


class SlaBreachFollowupDraftResponse(BaseModel):
    draftReply: str
    # Real, not hardcoded — the frontend's "AI used relevant context"
    # indicator (Review draft drawer) reflects exactly what was actually
    # available for this specific draft, never an always-checked placeholder.
    usedThreadMessages: int
    usedCrmContext: bool
    usedBusinessKnowledge: bool


# The AI Follow-up Agent's one new generation call (SLA-breach trigger,
# distinct from the existing /business-intelligence/followups/draft's
# post-reply "just checking in" nudge — see anthropic_client.
# SLA_BREACH_FOLLOWUP_SYSTEM_PROMPT's own comment for why). Composes three
# already-existing primitives — ms_graph's Outlook thread read, the existing
# Business Knowledge retriever, and the existing forced-tool-choice LLM call
# shape — no new agent, no new RAG, no new Outlook auth.
@router.post("/email-intelligence/follow-ups/sla-breach-draft", response_model=SlaBreachFollowupDraftResponse)
def sla_breach_followup_draft(payload: SlaBreachFollowupDraftRequest, user: dict = Depends(get_current_user)):
    organization_id = user.get("organizationId")
    user_id = user.get("sub", "")
    if not organization_id:
        raise HTTPException(400, "organizationId is required")

    thread_messages: list[dict] = []
    token = None
    if user_id:
        try:
            token = outlook_store.get_valid_access_token(user_id)
        except Exception:
            # A stale/invalid stored Outlook refresh token must never break
            # draft generation — thread context is best-effort, exactly like
            # ms_graph.list_conversation_messages()'s own error handling below.
            token = None
    if token and payload.conversationId:
        thread_messages = ms_graph.list_conversation_messages(token, payload.conversationId, top=20)

    thread_text = "\n\n".join(
        f"[{m.get('from', {}).get('emailAddress', {}).get('address', '')} — {m.get('receivedDateTime', '')}]\n{m.get('bodyPreview', '')}"
        for m in thread_messages
    )

    query = f"{payload.subject} {payload.bodyPreview}".strip()
    kb_context = retrieve_business_knowledge_as_context(query, organization_id) if query else ""

    result = generate_sla_breach_followup_draft(
        {
            "subject": payload.subject,
            "latestCustomerMessage": payload.bodyPreview,
            "fromAddress": payload.fromAddress,
            "priority": payload.priority,
            "emailThread": thread_text or None,
            "crmContext": payload.crmContext,
            "businessKnowledgeContext": kb_context or None,
        },
        organization_id=organization_id,
        user_id=user_id,
        request_id=payload.requestId,
    )

    return SlaBreachFollowupDraftResponse(
        draftReply=result["draftReply"],
        usedThreadMessages=len(thread_messages),
        usedCrmContext=bool(payload.crmContext),
        usedBusinessKnowledge=bool(kb_context),
    )

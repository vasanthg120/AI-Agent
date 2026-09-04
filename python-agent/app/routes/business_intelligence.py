from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.agent.anthropic_client import analyze_followup_priorities, compare_vendor_customer_pricing, generate_followup_draft
from app.security import get_current_user

router = APIRouter()


class FollowupDraftResponse(BaseModel):
    draftReply: str


# Body is the deterministic follow-up context NestJS's generateFollowUpDraft
# assembled (businessName, originalSubject/bodyPreview, our previous reply,
# daysSinceSent) — same raw-dict convention as /followups/analyze above.
# Separate from that route: this one generates an actual draft email body
# for one specific follow-up, on demand, never bundled into the cached
# daily summary.
@router.post("/business-intelligence/followups/draft", response_model=FollowupDraftResponse)
def draft_followup(payload: dict, user: dict = Depends(get_current_user)):
    return FollowupDraftResponse(
        **generate_followup_draft(payload, organization_id=user.get("organizationId"), user_id=user.get("sub", ""))
    )


class TodaysPriority(BaseModel):
    title: str
    rationale: str
    relatedId: str | None = None
    relatedType: str


class OverdueFollowUp(BaseModel):
    followUpId: str
    note: str


class HighPriorityCustomer(BaseModel):
    businessName: str
    businessKey: str | None = None
    reason: str


class FollowupPrioritiesResponse(BaseModel):
    todaysPriorities: list[TodaysPriority]
    overdueFollowUps: list[OverdueFollowUp]
    highPriorityCustomers: list[HighPriorityCustomer]
    recommendedActions: list[str]
    aiSummary: str


# The request body is the deterministic follow-up/deal/quote/customer-risk
# payload NestJS's ai-followup-summary.service.ts already assembled —
# accepted as a raw dict, same reason /customer-activity/analyze and
# /finance/analyze already do (internal trusted input whose shape is owned
# on the NestJS side; the output shape is what's contractually enforced,
# via FOLLOWUP_PRIORITIES_TOOL's forced tool_choice).
@router.post("/business-intelligence/followups/analyze", response_model=FollowupPrioritiesResponse)
def analyze_followups(payload: dict, user: dict = Depends(get_current_user)):
    return FollowupPrioritiesResponse(
        **analyze_followup_priorities(payload, organization_id=user.get("organizationId"), user_id=user.get("sub", ""))
    )


class TransactionNote(BaseModel):
    dealId: str
    commentary: str


class FlaggedTransaction(BaseModel):
    dealId: str
    reason: str


class VendorCustomerCompareResponse(BaseModel):
    transactionNotes: list[TransactionNote]
    aggregateNarrative: str
    flaggedTransactions: list[FlaggedTransaction]


# Body is the currently-filtered, already-computed transaction rows from
# VendorProfitabilityService.getOverview — stateless, on-demand only, no
# server-side cache (see compare_vendor_customer_pricing's own comment).
@router.post("/business-intelligence/vendor-profitability/compare", response_model=VendorCustomerCompareResponse)
def compare_vendor_customer(payload: dict, user: dict = Depends(get_current_user)):
    return VendorCustomerCompareResponse(
        **compare_vendor_customer_pricing(payload, organization_id=user.get("organizationId"), user_id=user.get("sub", ""))
    )

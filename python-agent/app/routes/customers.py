from fastapi import APIRouter, Depends

from app.agent.anthropic_client import analyze_customer, brief_deal
from app.security import get_current_user

router = APIRouter()


# The body is the fact sheet NestJS's customer-directory.service.ts assembled
# for one customer across every connected CRM and the mailbox - internal,
# trusted input; the output shape is enforced by CUSTOMER_ANALYSIS_TOOL's
# forced tool choice. Billing is reserved and settled by the backend around
# this call (request_id links the usage).
@router.post("/customers/analyze")
def analyze(payload: dict, user: dict = Depends(get_current_user)):
    return analyze_customer(
        payload,
        organization_id=user.get("organizationId"),
        user_id=user.get("sub", ""),
        request_id=payload.get("request_id", ""),
    )


# One deal's fact sheet, assembled by NestJS's deal-insight.service.ts (the
# deal, its quotations, CRM notes, emails, calls and history) - internal,
# trusted input; DEAL_BRIEF_TOOL's forced tool choice fixes the output shape.
# Only run when someone clicks "Analyse" (billed by the backend around it).
@router.post("/deals/brief")
def deal_brief(payload: dict, user: dict = Depends(get_current_user)):
    return brief_deal(
        payload,
        organization_id=user.get("organizationId"),
        user_id=user.get("sub", ""),
        request_id=payload.get("request_id", ""),
    )

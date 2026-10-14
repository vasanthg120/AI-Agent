from fastapi import APIRouter, Depends

from app.agent.anthropic_client import analyze_customer
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

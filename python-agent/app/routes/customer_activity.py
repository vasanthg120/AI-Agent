from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.agent.anthropic_client import analyze_customer_activity
from app.security import get_current_user

router = APIRouter()


class Prioritization(BaseModel):
    businessName: str
    rationale: str


class MissedEmail(BaseModel):
    emailId: str
    subject: str
    note: str


class CustomerActivityResponse(BaseModel):
    prioritization: list[Prioritization]
    missedImportantEmails: list[MissedEmail]
    aiSummary: str


# The request body is the deterministic activity payload NestJS's
# customer-activity.service.ts already assembled (business table, unactioned
# items, lost reasons, correlated emails) — accepted as a raw dict rather
# than a strictly-typed model since it's internal trusted input whose exact
# shape is defined and owned on the NestJS side, not user input needing
# validation here. The output shape is what's contractually enforced, via
# CUSTOMER_ACTIVITY_TOOL's forced tool_choice.
@router.post("/customer-activity/analyze", response_model=CustomerActivityResponse)
def analyze(payload: dict, user: dict = Depends(get_current_user)):
    return CustomerActivityResponse(
        **analyze_customer_activity(
            payload,
            organization_id=user.get("organizationId"),
            user_id=user.get("sub", ""),
            request_id=payload.get("request_id", ""),
        )
    )

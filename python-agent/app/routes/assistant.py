"""Haive's voice assistant: the spoken business briefing (see app.agent.briefing).
Follow-up questions go through the normal chat agent, in the conversation the
briefing opens."""

from fastapi import APIRouter, Depends

from app.agent.briefing import compose_briefing
from app.security import get_current_user

router = APIRouter()


@router.post("/assistant/briefing")
def briefing(payload: dict, user: dict = Depends(get_current_user)) -> dict:
    return compose_briefing(
        payload.get("facts") or {},
        organization_id=user.get("organizationId"),
        user_id=user.get("sub", ""),
        request_id=payload.get("request_id", ""),
        style=payload.get("style") or "concise",
    )

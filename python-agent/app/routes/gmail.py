from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from requests import HTTPError

from app.integrations import google_mail
from app.memory import gmail_store
from app.security import get_current_user

router = APIRouter()


class SendReplyRequest(BaseModel):
    messageId: str
    comment: str


@router.post("/gmail/send-reply")
def send_reply(payload: SendReplyRequest, user: dict = Depends(get_current_user)):
    """Mirrors routes/outlook.py's /outlook/send-reply exactly: dispatches a
    real reply to the original sender of `messageId` via the Gmail API (see
    google_mail.reply_to_message). Intended to be called only from a backend
    flow reachable after a human has explicitly approved AND then explicitly
    confirmed sending (the same contract Email Intelligence's Outlook send
    button already uses) — this route has no independent safety gate of its
    own, it trusts the caller already enforced that."""
    token = gmail_store.get_valid_access_token(user.get("sub", ""))
    if not token:
        raise HTTPException(400, "Gmail is not connected for this user")

    try:
        google_mail.reply_to_message(token, payload.messageId, payload.comment)
    except HTTPError as exc:
        # Surfaced honestly (e.g. insufficient scope on a not-yet-reconnected
        # account, or a message id that no longer exists) — never silently
        # treated as success.
        status = exc.response.status_code if exc.response is not None else 502
        detail = exc.response.text if exc.response is not None else str(exc)
        raise HTTPException(status, f"Failed to send reply via Gmail: {detail}") from exc

    return {"sent": True}

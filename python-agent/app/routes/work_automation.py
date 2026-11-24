"""AI helpers for the NestJS work-automation module (automatic To-Do & EOD).

NestJS owns all business logic and persistence; these endpoints only (a) write
the narrative of an EOD report from records NestJS has already verified, and
(b) read the signed-in user's Outlook calendar for a day. Neither endpoint
invents or changes task state.
"""

import base64
import re
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from requests import HTTPError

from app.config import settings
from app.integrations import ms_graph
from app.memory import gmail_store, outlook_store
from app.security import get_current_user

router = APIRouter()

EOD_SUMMARY_SYSTEM_PROMPT = """You write the short narrative summary of one employee's end-of-day report.

Strict rules:
- Use ONLY the records in the JSON you are given. Every number, name, customer and task you mention must appear there.
- Never claim something was completed unless it is listed under "completed". Never infer completion.
- Do not invent meetings, calls, replies, amounts, reasons or intentions.
- If a section is empty, say nothing about it or state plainly that nothing was recorded.
- Mention overdue and blocked work plainly, and the top next-day priorities.
- The "assessment.headline" tells you how to read the day. If it is "sync_unreliable", say the data could not be read and that nothing can be concluded. If it is "no_assigned_work", say nothing is assigned in the connected platforms. If it is "no_completed_work", say work is assigned but none was verified complete. NEVER describe an employee as unproductive, idle or underperforming, and never treat missing data as missing effort.
- 4 to 8 sentences, plain text, no markdown, no greeting, no sign-off."""


class EodSummaryRequest(BaseModel):
    employee_name: str
    date: str
    completed: list[dict] = []
    pending: list[dict] = []
    overdue: list[dict] = []
    blocked: list[dict] = []
    awaiting_verification: list[dict] = []
    meetings: list[dict] = []
    customer_followups: dict = {}
    crm_updates: list[dict] = []
    next_day_priorities: list[dict] = []
    data_gaps: list[str] = []
    # How to read the day: headline is one of worked | no_completed_work | no_assigned_work | sync_unreliable.
    assessment: dict = {}


class EodSummaryResponse(BaseModel):
    summary: str


def build_summary_input(payload: EodSummaryRequest) -> str:
    """The exact, bounded text the model sees (also what the unit test pins)."""
    import json

    body = payload.model_dump()
    # Bound each list so one huge day cannot blow the prompt.
    for key, value in list(body.items()):
        if isinstance(value, list):
            body[key] = value[:40]
    return json.dumps(body, default=str)[:30000]


@router.post("/work/eod-summary", response_model=EodSummaryResponse)
def eod_summary(payload: EodSummaryRequest, user: dict = Depends(get_current_user)):
    # Imported here so this module stays light to import (the Anthropic client pulls in every agent tool).
    from app.agent.anthropic_client import _client, _resolve_api_key

    api_key = _resolve_api_key()
    if not api_key:
        raise RuntimeError("No Anthropic API key configured")
    response = _client(api_key).messages.create(
        model=settings.anthropic_model,
        max_tokens=600,
        system=EOD_SUMMARY_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": build_summary_input(payload)}],
    )
    text = "".join(b.text for b in response.content if getattr(b, "type", "") == "text").strip()
    return EodSummaryResponse(summary=text)


class MeetingsRequest(BaseModel):
    start: str  # ISO 8601 instant (UTC), inclusive
    end: str  # ISO 8601 instant (UTC), exclusive


class Meeting(BaseModel):
    title: str
    start: str
    end: str
    organizer: str | None = None


class MeetingsResponse(BaseModel):
    connected: bool
    source: str = "outlook_calendar"
    meetings: list[Meeting] = []


def _iso(value: str) -> str:
    # Validates and normalizes; raises ValueError (-> 422/500) on garbage instead of passing it to Graph.
    return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()


@router.post("/work/meetings", response_model=MeetingsResponse)
def meetings(payload: MeetingsRequest, user: dict = Depends(get_current_user)):
    """The signed-in user's Outlook calendar events between two instants. connected=false (and no
    meetings) when the user has no Outlook connection — never an error, never fabricated."""
    token = outlook_store.get_valid_access_token(user.get("sub", "")) if settings.ms_graph_client_id else None
    if not token:
        return MeetingsResponse(connected=False)
    data = ms_graph.graph_get(
        "/me/calendarView",
        token,
        params={
            "startDateTime": _iso(payload.start),
            "endDateTime": _iso(payload.end),
            "$top": 50,
            "$orderby": "start/dateTime",
            "$select": "subject,start,end,organizer,isCancelled",
        },
    )
    items = [
        Meeting(
            title=e.get("subject", "") or "(no title)",
            start=e.get("start", {}).get("dateTime", ""),
            end=e.get("end", {}).get("dateTime", ""),
            organizer=(e.get("organizer", {}).get("emailAddress", {}) or {}).get("name"),
        )
        for e in data.get("value", [])
        if not e.get("isCancelled")
    ]
    return MeetingsResponse(connected=True, meetings=items)


# ---- sending the EOD report from the employee's own connected mailbox ----

_EMAIL = re.compile(r"^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$")
GRAPH_BASE = ms_graph.GRAPH_BASE
GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"


class SendMailRequest(BaseModel):
    channel: str  # "outlook" | "gmail"
    to: list[str]
    subject: str
    html: str
    text: str


def _validated_recipients(to: list[str]) -> list[str]:
    cleaned = [a.strip() for a in to]
    if not cleaned or len(cleaned) > 5 or not all(_EMAIL.match(a) for a in cleaned):
        raise HTTPException(422, "A report goes to one to five valid email addresses.")
    return cleaned


def _send_outlook(token: str, to: list[str], subject: str, html: str) -> None:
    # Graph's /me/sendMail answers 202 with an empty body, so it is not built on graph_post (which parses JSON).
    response = requests.post(
        f"{GRAPH_BASE}/me/sendMail",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "message": {
                "subject": subject,
                "body": {"contentType": "HTML", "content": html},
                "toRecipients": [{"emailAddress": {"address": a}} for a in to],
            },
            "saveToSentItems": True,
        },
        timeout=30,
    )
    response.raise_for_status()


def _send_gmail(token: str, to: list[str], subject: str, html: str, text: str) -> None:
    mime = MIMEMultipart("alternative")
    mime["To"] = ", ".join(to)
    mime["Subject"] = subject
    mime.attach(MIMEText(text, "plain", "utf-8"))
    mime.attach(MIMEText(html, "html", "utf-8"))
    raw = base64.urlsafe_b64encode(mime.as_bytes()).decode("ascii")
    response = requests.post(GMAIL_SEND_URL, headers={"Authorization": f"Bearer {token}"}, json={"raw": raw}, timeout=30)
    response.raise_for_status()


@router.post("/work/send-mail")
def send_mail(payload: SendMailRequest, user: dict = Depends(get_current_user)):
    """Sends one email FROM the token's own user's connected mailbox. Only the user's own mailbox is
    ever used (the token's sub), so one employee can never send as another. Fails with a clear status
    when the mailbox is not connected or lacks send permission, so the caller can try the next channel."""
    to = _validated_recipients(payload.to)
    user_id = user.get("sub", "")
    if payload.channel == "outlook":
        token = outlook_store.get_valid_access_token(user_id)
        sender = lambda: _send_outlook(token, to, payload.subject, payload.html)  # noqa: E731
    elif payload.channel == "gmail":
        token = gmail_store.get_valid_access_token(user_id)
        sender = lambda: _send_gmail(token, to, payload.subject, payload.html, payload.text)  # noqa: E731
    else:
        raise HTTPException(422, "channel must be outlook or gmail")
    if not token:
        raise HTTPException(400, f"{payload.channel} is not connected for this user")
    try:
        sender()
    except HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        detail = exc.response.text[:300] if exc.response is not None else str(exc)
        raise HTTPException(status, f"Failed to send via {payload.channel}: {detail}") from exc
    return {"sent": True, "channel": payload.channel}


# ---- Gmail: actionable threads for the To-Do ----


class KnownThread(BaseModel):
    threadId: str
    kind: str
    lastMessageId: str | None = None
    lastMessageAt: str | None = None
    reason: str | None = None


class GmailActionsRequest(BaseModel):
    lookback_days: int = 7
    known: list[KnownThread] = []


def _call_model(system: str, tool: dict, user_text: str) -> dict:
    from app.agent.anthropic_client import _client, _resolve_api_key

    response = _client(_resolve_api_key()).messages.create(
        model=settings.anthropic_routing_model,
        max_tokens=2048,
        system=system,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
        messages=[{"role": "user", "content": user_text}],
    )
    block = next((b for b in response.content if b.type == "tool_use"), None)
    if block is None:
        raise ValueError("The model did not return a tool result")
    return block.input


@router.post("/work/gmail-actions")
def gmail_actions(payload: GmailActionsRequest, user: dict = Depends(get_current_user)):
    """Actionable Gmail threads of the token's own user (their active connected mailbox). Reads only; never
    sends or changes mail. connected=false when there is no usable connection."""
    from app.integrations import gmail_actions as ga
    from app.integrations.google_mail import gmail_get

    token = gmail_store.get_valid_access_token(user.get("sub", ""))
    if not token:
        return {"connected": False, "mailbox": None, "open": [], "resolved": [], "classifier": "n/a", "complete": False, "scanned": 0}
    try:
        return ga.run(
            token,
            lookback_days=max(1, min(payload.lookback_days, 30)),
            known=[k.model_dump() for k in payload.known],
            gmail_get=gmail_get,
            call_model=_call_model,
        )
    except HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        raise HTTPException(status, f"Gmail refused the read: {exc.response.text[:200] if exc.response is not None else exc}") from exc

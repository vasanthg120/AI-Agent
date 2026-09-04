from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from requests import HTTPError

from app.integrations import ms_graph
from app.memory import outlook_store
from app.security import get_current_user

router = APIRouter()


@router.get("/outlook/calendar-events")
def calendar_events(days: int = 7, user: dict = Depends(get_current_user)):
    """Plain data read for the product UI (Manager/Consultant dashboard's
    Team Calendar / Today's Meetings) — deliberately separate from
    calendar_tool.py's chat-tool action, which uses an unbounded $top=10
    list rather than a real date range. Returns connected: false (not an
    error) when the caller hasn't linked Outlook, so the dashboard can show
    a real "connect your calendar" prompt instead of an empty list that
    looks like "no meetings today"."""
    token = outlook_store.get_valid_access_token(user.get("sub", ""))
    if not token:
        return {"connected": False, "events": []}

    now = datetime.now(timezone.utc)
    data = ms_graph.graph_get(
        "/me/calendarview",
        token,
        params={
            "startDateTime": now.isoformat(),
            "endDateTime": (now + timedelta(days=days)).isoformat(),
            "$orderby": "start/dateTime",
            "$select": "subject,start,end",
            "$top": 50,
        },
    )
    events = [
        {
            "id": e.get("id", ""),
            "title": e.get("subject", ""),
            "start": e.get("start", {}).get("dateTime", ""),
            "end": e.get("end", {}).get("dateTime", ""),
        }
        for e in data.get("value", [])
    ]
    return {"connected": True, "events": events}


def _map_message(m: dict) -> dict:
    return {
        "id": m.get("id", ""),
        "subject": m.get("subject", ""),
        "from": (m.get("from") or {}).get("emailAddress", {}).get("address", ""),
        "to": [
            (r.get("emailAddress") or {}).get("address", "")
            for r in m.get("toRecipients") or []
        ],
        "receivedAt": m.get("receivedDateTime", ""),
        "preview": m.get("bodyPreview", ""),
        "isRead": m.get("isRead", True),
        "importance": m.get("importance", "normal"),
        # Graph groups every message in a thread under one conversationId —
        # captured so the backend can tell "this inbound email was replied to
        # directly in Outlook" apart from "still sitting unanswered", by
        # cross-referencing against /outlook/sent-since below. Without this,
        # a reply sent from the real Outlook client (not through this app's
        # own approve/send flow) is invisible and the email eventually gets
        # misclassified as missed even though it was genuinely handled.
        "conversationId": m.get("conversationId", ""),
    }


def _map_sent_message(m: dict) -> dict:
    return {
        "id": m.get("id", ""),
        "conversationId": m.get("conversationId", ""),
        "sentAt": m.get("sentDateTime", ""),
    }


@router.get("/outlook/todays-emails")
def todays_emails(user: dict = Depends(get_current_user)):
    """Powers the Deal Performance page's Customer Activity tab (Phase 11) —
    deliberately separate from outlook_tool.py's chat-tool "emails" action,
    which fetches an unbounded "most recent 10" with no date filter and no
    isRead/importance/toRecipients. This is the first caller anywhere in
    this codebase to use a real $filter date range plus isRead/importance
    on /me/mailFolders/inbox/messages. Same connected:false (not an error)
    convention as calendar_events above.

    Scoped to /me/mailFolders/inbox/messages, NOT the mailbox-wide
    /me/messages — Graph's unscoped /me/messages spans every folder (Sent
    Items, Drafts, Deleted Items included), which silently pulled the
    mailbox owner's own outbound mail into "inbound emails to triage". Email
    Intelligence's Layer 1 self-send gate (fromAddress == mailboxEmail)
    already tags those 'internal'/no-draft-needed rather than mis-analyzing
    them, but every one still burns a scan slot and, worse, can crowd out
    genuinely new inbound customer mail once $top is reached — this was a
    real, confirmed cause of a connected mailbox appearing to have "no mail
    to read" when the inbox actually had unanalyzed customer replies sitting
    past the truncation point."""
    token = outlook_store.get_valid_access_token(user.get("sub", ""))
    if not token:
        return {"connected": False, "emails": []}

    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    data = ms_graph.graph_get(
        "/me/mailFolders/inbox/messages",
        token,
        params={
            "$filter": f"receivedDateTime ge {today_start.isoformat()}",
            "$select": "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,importance,conversationId",
            "$orderby": "receivedDateTime desc",
            "$top": 100,
        },
    )
    return {"connected": True, "emails": [_map_message(m) for m in data.get("value", [])]}


@router.get("/outlook/messages-since")
def messages_since(since: str, user: dict = Depends(get_current_user)):
    """Parameterized sibling of todays_emails() for Phase 14b's scheduled
    Email Intelligence poller (backend/src/email-intelligence/
    email-intelligence-poller.service.ts) — NestJS computes the lookback
    window and passes `since` as a ready-to-use ISO8601 instant; this route
    just forwards it into Graph's $filter verbatim. Same connected:false
    (not an error) convention, same $select/shape as todays_emails.

    Single page only, no @odata.nextLink follow — `since` can now cover up
    to MAX_SYNC_BACKFILL_DAYS (see email-intelligence-sync.service.ts's
    resolveSyncSince), so $top is raised from the old fixed-24h-window value
    of 100 to give a wider window realistic headroom before silently
    dropping the oldest messages in range (ordered desc, so a truncation
    always drops the tail of the window, never the newest mail).

    Scoped to /me/mailFolders/inbox/messages, not the mailbox-wide
    /me/messages — see todays_emails' own comment for why: unscoped
    /me/messages includes Sent Items, so every sync was quietly spending
    part of its $top budget (and a chunk of every mailbox owner's "new mail"
    count) on their own already-sent replies instead of new inbound
    customer mail, sometimes crowding out the real thing entirely."""
    token = outlook_store.get_valid_access_token(user.get("sub", ""))
    if not token:
        return {"connected": False, "emails": []}

    data = ms_graph.graph_get(
        "/me/mailFolders/inbox/messages",
        token,
        params={
            "$filter": f"receivedDateTime ge {since}",
            "$select": "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,importance,conversationId",
            "$orderby": "receivedDateTime desc",
            "$top": 250,
        },
    )
    return {"connected": True, "emails": [_map_message(m) for m in data.get("value", [])]}


@router.get("/outlook/sent-since")
def sent_since(since: str, user: dict = Depends(get_current_user)):
    """Sent Items since `since`, id-light (conversationId + sentAt only) —
    powers EmailIntelligenceSyncService's external-reply detection: a
    conversationId here that matches a still-pending inbound item means that
    email was replied to directly in the real Outlook client, not through
    this app's own approve/send flow, and should stop counting as missed.
    Same connected:false convention as the routes above."""
    token = outlook_store.get_valid_access_token(user.get("sub", ""))
    if not token:
        return {"connected": False, "items": []}

    data = ms_graph.graph_get(
        "/me/mailFolders/sentitems/messages",
        token,
        params={
            "$filter": f"sentDateTime ge {since}",
            "$select": "id,conversationId,sentDateTime",
            "$orderby": "sentDateTime desc",
            "$top": 200,
        },
    )
    return {"connected": True, "items": [_map_sent_message(m) for m in data.get("value", [])]}


@router.get("/outlook/message/{message_id}/body")
def message_body(message_id: str, user: dict = Depends(get_current_user)):
    """Full body content for one message — fetched live from Graph, never
    stored (EmailIntelligenceItem only ever persists the short bodyPreview
    snippet captured at ingest, not the full email). Called only from the
    backend's EmailAnalyticsController full-body route, itself only
    reachable by someone already authorized to see this email's summary —
    this route trusts that gate already ran, same as send-reply above
    trusts its caller already enforced approval."""
    token = outlook_store.get_valid_access_token(user.get("sub", ""))
    if not token:
        raise HTTPException(400, "Outlook is not connected for this user")

    try:
        data = ms_graph.graph_get(f"/me/messages/{message_id}", token, params={"$select": "body"})
    except HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        detail = exc.response.text if exc.response is not None else str(exc)
        raise HTTPException(status, f"Failed to fetch message body: {detail}") from exc

    body = data.get("body") or {}
    return {"contentType": body.get("contentType", "text"), "content": body.get("content", "")}


class SendReplyRequest(BaseModel):
    messageId: str
    comment: str


@router.post("/outlook/send-reply")
def send_reply(payload: SendReplyRequest, user: dict = Depends(get_current_user)):
    """Phase 14d — dispatches a real reply to the original sender of
    `messageId` via Microsoft Graph (see ms_graph.reply_to_message). Called
    only from backend/src/email-intelligence/email-intelligence.service.ts's
    send(), itself only reachable after a human has explicitly approved AND
    then explicitly confirmed sending — this route has no independent
    safety gate of its own, it trusts the caller already enforced that."""
    token = outlook_store.get_valid_access_token(user.get("sub", ""))
    if not token:
        raise HTTPException(400, "Outlook is not connected for this user")

    try:
        ms_graph.reply_to_message(token, payload.messageId, payload.comment)
    except HTTPError as exc:
        # Surfaced honestly (e.g. insufficient scope on a not-yet-reconnected
        # account, or a message id that no longer exists) — never silently
        # treated as success.
        status = exc.response.status_code if exc.response is not None else 502
        detail = exc.response.text if exc.response is not None else str(exc)
        raise HTTPException(status, f"Failed to send reply via Outlook: {detail}") from exc

    return {"sent": True}

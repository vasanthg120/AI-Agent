from datetime import datetime, timedelta, timezone
from urllib.parse import quote

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


def _addresses(recipients: list | None) -> list[str]:
    return [a for a in ((r.get("emailAddress") or {}).get("address", "") for r in recipients or []) if a]


# The reply headers of a message. Graph only exposes In-Reply-To / References
# through these two MAPI properties (they are present on sent mail too, which
# `internetMessageHeaders` is not).
_IN_REPLY_TO = "String 0x1042"
_REFERENCES = "String 0x1039"
_REPLY_HEADERS_EXPAND = f"singleValueExtendedProperties($filter=id eq '{_IN_REPLY_TO}' or id eq '{_REFERENCES}')"


def _threading(m: dict) -> dict:
    """What ties a message to the one it answers, independent of its subject:
    its own Message-ID, and the Message-IDs it replies to / refers back to."""
    props = {p.get("id"): p.get("value") or "" for p in m.get("singleValueExtendedProperties") or []}
    return {
        "internetMessageId": m.get("internetMessageId", "") or "",
        "inReplyTo": (props.get(_IN_REPLY_TO) or "").strip(),
        "references": (props.get(_REFERENCES) or "").split(),
    }


def _map_message(m: dict) -> dict:
    sender = (m.get("from") or {}).get("emailAddress", {})
    return {
        "id": m.get("id", ""),
        "subject": m.get("subject", ""),
        "from": sender.get("address", ""),
        "fromName": sender.get("name", ""),
        "to": _addresses(m.get("toRecipients")),
        "cc": _addresses(m.get("ccRecipients")),
        **_threading(m),
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
        # Kept so sent mail can be shown and reasoned over (who it went to,
        # what was promised), not only used to detect that a reply happened.
        "subject": m.get("subject", ""),
        "from": (m.get("from") or {}).get("emailAddress", {}).get("address", ""),
        "to": _addresses(m.get("toRecipients")),
        "cc": _addresses(m.get("ccRecipients")),
        "preview": m.get("bodyPreview", ""),
        **_threading(m),
    }


_INBOX_SELECT = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,importance,conversationId,internetMessageId,parentFolderId,isDraft"
_SENT_SELECT = "id,conversationId,sentDateTime,subject,from,toRecipients,ccRecipients,bodyPreview,internetMessageId"


def _walk(path: str, token: str, params: dict, max_items: int) -> tuple[list[dict], bool]:
    """A paged read that also asks for the reply headers. A mailbox that
    refuses that extra (a 400) is read without it rather than not at all."""
    try:
        return ms_graph.graph_get_all(path, token, params={**params, "$expand": _REPLY_HEADERS_EXPAND}, max_items=max_items)
    except HTTPError as exc:
        if exc.response is None or exc.response.status_code != 400:
            raise
        return ms_graph.graph_get_all(path, token, params=params, max_items=max_items)


def _received(token: str, date_filter: str, top: int, max_items: int) -> tuple[list[dict], bool]:
    """Mail other people sent to this mailbox, wherever it now sits. Rules and
    people move mail out of the Inbox (into project folders, the archive), and
    it still needs an answer there - so the whole mailbox is read and only the
    folders that are never inbound (Sent, Drafts, Deleted, Junk, Outbox) are
    left out. If those folders cannot be identified, the Inbox alone is read."""
    params = {"$filter": date_filter, "$select": _INBOX_SELECT, "$orderby": "receivedDateTime desc", "$top": top}
    not_inbound = set(ms_graph.folder_ids(token).values())
    if not not_inbound:
        return _walk("/me/mailFolders/inbox/messages", token, params, max_items)
    messages, truncated = _walk("/me/messages", token, params, max_items)
    return [m for m in messages if m.get("parentFolderId") not in not_inbound and not m.get("isDraft")], truncated
# One sync/import never walks more than this many messages per folder; when a
# mailbox has more in the window the response says so (`truncated`).
_MAX_SYNC_MESSAGES = 2000
_MAX_HISTORY_MESSAGES = 5000


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

    # Paged: every message in the window is returned (Graph's @odata.nextLink
    # is followed), not just the newest page - a busy mailbox used to lose
    # the older part of the window past the first 250.
    messages, truncated = _received(token, f"receivedDateTime ge {since}", 250, _MAX_SYNC_MESSAGES)
    return {
        "connected": True,
        "emails": [_map_message(m) for m in messages],
        "truncated": truncated,
        "mailboxAddresses": ms_graph.mailbox_addresses(token),
    }


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

    messages, truncated = _walk(
        "/me/mailFolders/sentitems/messages",
        token,
        {"$filter": f"sentDateTime ge {since}", "$select": _SENT_SELECT, "$orderby": "sentDateTime desc", "$top": 250},
        _MAX_SYNC_MESSAGES,
    )
    return {
        "connected": True,
        "items": [_map_sent_message(m) for m in messages],
        "truncated": truncated,
        "mailboxAddresses": ms_graph.mailbox_addresses(token),
    }


class MessageRef(BaseModel):
    id: str
    internetMessageId: str | None = None


class MessagesStateRequest(BaseModel):
    messages: list[MessageRef]


@router.post("/outlook/messages-state")
def messages_state(payload: MessagesStateRequest, user: dict = Depends(get_current_user)):
    """Where each of these messages is now: still in the mailbox ("present"),
    in Deleted Items / Junk ("deleted"), moved to another folder under a new id
    ("moved", with `newId`), or no longer in the mailbox at all ("gone").
    "unknown" means Outlook could not say right now - the caller changes
    nothing for those. Ids and read state only; no content is read."""
    token = outlook_store.get_valid_access_token(user.get("sub", ""))
    if not token:
        return {"connected": False, "states": []}
    refs = payload.messages[:200]
    folders = ms_graph.folder_ids(token)
    trash = {folders.get("deleteditems"), folders.get("junkemail")} - {None}

    def describe(message: dict, original_id: str) -> dict:
        state = "deleted" if message.get("parentFolderId") in trash else ("present" if message.get("id") == original_id else "moved")
        return {"id": original_id, "state": state, "newId": message.get("id") if state == "moved" else None, "isRead": message.get("isRead")}

    states: list[dict] = []
    lookups: list[MessageRef] = []
    found = ms_graph.graph_batch_get(token, [f"/me/messages/{ref.id}?$select=id,parentFolderId,isRead" for ref in refs])
    for ref, (status, body) in zip(refs, found):
        if status == 200:
            states.append(describe(body, ref.id))
        elif status in (400, 404) and ref.internetMessageId:
            # Outlook gives a message a new id when it moves folders; its Message-ID never changes.
            lookups.append(ref)
        else:
            states.append({"id": ref.id, "state": "gone" if status == 404 else "unknown", "newId": None, "isRead": None})
    if lookups:
        urls = []
        for ref in lookups:
            message_id = (ref.internetMessageId or "").replace("'", "''")
            urls.append(f"/me/messages?$filter=internetMessageId eq '{quote(message_id, safe='')}'&$select=id,parentFolderId,isRead&$top=5")
        for ref, (status, body) in zip(lookups, ms_graph.graph_batch_get(token, urls)):
            matches = body.get("value") or [] if status == 200 else None
            if matches is None:
                states.append({"id": ref.id, "state": "unknown", "newId": None, "isRead": None})
            elif not matches:
                states.append({"id": ref.id, "state": "gone", "newId": None, "isRead": None})
            else:
                # Prefer a copy that is still filed somewhere over one in the bin.
                live = next((m for m in matches if m.get("parentFolderId") not in trash), matches[0])
                states.append(describe(live, ref.id))
    return {"connected": True, "states": states}


@router.get("/outlook/history")
def history(folder: str, since: str, until: str | None = None, user: dict = Depends(get_current_user)):
    """Older mail for the AI Email Inbox's history import: every message of
    one folder ("inbox" or "sent") between `since` and `until`, walked page by
    page. Metadata and the short preview only - same shape as the sync routes
    above, so nothing new is exposed. `truncated` is True when the window held
    more than the per-import cap; the caller then imports a shorter window."""
    if folder not in ("inbox", "sent"):
        raise HTTPException(400, "folder must be 'inbox' or 'sent'")
    token = outlook_store.get_valid_access_token(user.get("sub", ""))
    if not token:
        return {"connected": False, "messages": [], "truncated": False}

    field = "receivedDateTime" if folder == "inbox" else "sentDateTime"
    date_filter = f"{field} ge {since}" + (f" and {field} lt {until}" if until else "")
    try:
        if folder == "inbox":
            messages, truncated = _received(token, date_filter, 500, _MAX_HISTORY_MESSAGES)
        else:
            messages, truncated = _walk(
                "/me/mailFolders/sentitems/messages",
                token,
                {"$filter": date_filter, "$select": _SENT_SELECT, "$orderby": f"{field} desc", "$top": 500},
                _MAX_HISTORY_MESSAGES,
            )
    except HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        if status in (401, 403):
            raise HTTPException(status, "Outlook refused access to this mailbox. Reconnect Outlook on the Integrations page.") from exc
        raise HTTPException(502, "Outlook could not be read right now. Please try again in a minute.") from exc
    mapper = _map_message if folder == "inbox" else _map_sent_message
    return {"connected": True, "messages": [mapper(m) for m in messages], "truncated": truncated, "mailboxAddresses": ms_graph.mailbox_addresses(token)}


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

import hashlib
import html
import re
import time

import requests

from app.cache import cache
from app.config import settings

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

# Read endpoints worth caching. Outlook data is per-user (unlike CRM's
# shared data), so the cache key below is scoped to the calling token.
# /me/mailFolders/inbox/messages is the Inbox-scoped sibling outlook.py's
# todays_emails/messages_since moved to (see their own comments) — kept
# cacheable alongside /me/messages so that move didn't silently drop caching
# for Email Intelligence's two highest-traffic Graph calls.
_CACHEABLE_PATHS = {"/me/messages", "/me/mailFolders/inbox/messages", "/me/contacts"}


# Graph answers 429 when a mailbox is throttled and 503/504 during brief
# outages; all three are safe to repeat for a read. Retry-After is honoured.
_RETRY_STATUSES = (429, 503, 504)


def _get_with_retry(url: str, access_token: str, params: dict | None = None, timeout: int = 30) -> requests.Response:
    response: requests.Response | None = None
    for attempt in range(4):
        try:
            response = requests.get(url, headers={"Authorization": f"Bearer {access_token}"}, params=params, timeout=timeout)
        except (requests.ConnectionError, requests.Timeout):
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
            continue
        if response.status_code in _RETRY_STATUSES and attempt < 3:
            time.sleep(min(float(response.headers.get("Retry-After") or 2 * (attempt + 1)), 20))
            continue
        break
    assert response is not None
    return response


def graph_get(path: str, access_token: str, params: dict | None = None) -> dict:
    cacheable = path in _CACHEABLE_PATHS
    key = None
    if cacheable:
        # Hash the token rather than using it raw as part of the key — it's
        # a bearer credential and Redis keys are visible via KEYS/MONITOR/logs.
        token_hash = hashlib.sha256(access_token.encode()).hexdigest()[:16]
        key = cache.cache_key(f"outlook:{token_hash}", path, params or {})
        hit = cache.get_json(key)
        if hit is not None:
            return hit

    response = _get_with_retry(f"{GRAPH_BASE}{path}", access_token, params, timeout=15)
    response.raise_for_status()
    body = response.json()

    if key is not None:
        cache.set_json(key, body, settings.outlook_cache_ttl_seconds)
    return body


def graph_get_all(path: str, access_token: str, params: dict | None = None, max_items: int = 2000) -> tuple[list[dict], bool]:
    """Every item of a Graph list, following @odata.nextLink (Graph returns one
    page per request and a continuation link for the rest). Returns
    (items, truncated): `truncated` is True when `max_items` was reached with
    more still available, so a caller can say so instead of silently presenting
    a partial list as complete. Never cached - a paged walk is always a
    deliberate, fresh read. Throttling (429) and brief outages are retried
    honouring Retry-After."""
    items: list[dict] = []
    url: str | None = f"{GRAPH_BASE}{path}"
    query = params
    while url:
        response = _get_with_retry(url, access_token, query)
        response.raise_for_status()
        body = response.json()
        items.extend(body.get("value", []))
        # The continuation link already carries every query option.
        url = body.get("@odata.nextLink")
        query = None
        if len(items) >= max_items:
            return items[:max_items], bool(url) or len(items) > max_items
    return items, False


def _token_scope(access_token: str) -> str:
    # Never the raw token: it is a bearer credential and cache keys are visible.
    return hashlib.sha256(access_token.encode()).hexdigest()[:16]


def mailbox_addresses(access_token: str) -> list[str]:
    """Every address this mailbox receives and sends as - its primary address,
    sign-in name and aliases - lower-cased. A mailbox often sends from an alias
    that differs from the address it signed in with, so "is this message from
    us?" must never be decided against one address alone. Cached for a day."""
    key = cache.cache_key(f"outlook:{_token_scope(access_token)}", "/me#addresses", {})
    hit = cache.get_json(key)
    if hit is not None:
        return hit
    response = _get_with_retry(f"{GRAPH_BASE}/me", access_token, {"$select": "mail,userPrincipalName,proxyAddresses,otherMails"}, timeout=15)
    if response.status_code != 200:
        return []
    me = response.json()
    found: list[str] = []
    for value in [me.get("mail"), me.get("userPrincipalName"), *(me.get("proxyAddresses") or [])]:
        address = str(value or "").strip().lower()
        if address.startswith("smtp:"):
            address = address[5:]
        if "@" in address and ":" not in address and address not in found:
            found.append(address)
    cache.set_json(key, found, 24 * 3600)
    return found


# Folders whose contents are never "mail somebody sent us".
_NOT_INBOUND_FOLDERS = ("sentitems", "drafts", "deleteditems", "junkemail", "outbox")


def folder_ids(access_token: str) -> dict[str, str]:
    """Graph ids of the well-known folders above, by name (cached for a day).
    Empty when they cannot be read, so a caller falls back to the Inbox alone."""
    key = cache.cache_key(f"outlook:{_token_scope(access_token)}", "/me/mailFolders#wellknown", {})
    hit = cache.get_json(key)
    if hit is not None:
        return hit
    found: dict[str, str] = {}
    for name in _NOT_INBOUND_FOLDERS:
        response = _get_with_retry(f"{GRAPH_BASE}/me/mailFolders/{name}", access_token, {"$select": "id"}, timeout=15)
        if response.status_code == 200 and response.json().get("id"):
            found[name] = response.json()["id"]
    # Sent Items and Deleted Items always exist; without them the mailbox-wide
    # read cannot be told apart from the user's own mail, so report nothing.
    if "sentitems" not in found or "deleteditems" not in found:
        return {}
    cache.set_json(key, found, 24 * 3600)
    return found


def graph_batch_get(access_token: str, urls: list[str]) -> list[tuple[int, dict]]:
    """Several GETs in as few round trips as Graph allows (20 per $batch).
    Returns (status, body) per url, in order; a part that could not be asked at
    all comes back as status 0."""
    results: list[tuple[int, dict]] = [(0, {})] * len(urls)
    for start in range(0, len(urls), 20):
        chunk = urls[start : start + 20]
        payload = {"requests": [{"id": str(i), "method": "GET", "url": url} for i, url in enumerate(chunk)]}
        for attempt in range(3):
            response = requests.post(f"{GRAPH_BASE}/$batch", headers={"Authorization": f"Bearer {access_token}"}, json=payload, timeout=30)
            if response.status_code in _RETRY_STATUSES and attempt < 2:
                time.sleep(min(float(response.headers.get("Retry-After") or 2 * (attempt + 1)), 20))
                continue
            break
        if response.status_code != 200:
            continue
        for part in response.json().get("responses", []):
            body = part.get("body") if isinstance(part.get("body"), dict) else {}
            results[start + int(part.get("id", 0))] = (int(part.get("status", 0)), body)
    return results


def graph_post(path: str, access_token: str, json_body: dict) -> dict:
    response = requests.post(
        f"{GRAPH_BASE}{path}",
        headers={"Authorization": f"Bearer {access_token}"},
        json=json_body,
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def _comment_html(text: str) -> str:
    """A plain-text reply as HTML for Graph's /reply `comment`. Graph drops the
    comment as-is into the reply's HTML body, so plain text arrives as one
    run-on paragraph: every line break and blank line is lost, and a "<" or
    "&" in the text would be read as markup. One <div> per line (an empty line
    a <div><br></div>), the same markup Outlook writes for a typed reply, keeps
    it laid out exactly as it was written. The font is set explicitly because
    the comment otherwise inherits the original email's body styles."""
    rows = []
    for line in text.strip().replace("\r\n", "\n").split("\n"):
        escaped = html.escape(line.rstrip(), quote=False).replace("\t", "    ")
        # Runs of spaces (an indent, a lined-up column) would collapse to one.
        escaped = re.sub(r" {2,}", lambda run: "&nbsp;" * len(run.group()), escaped)
        rows.append(f"<div>{escaped or '<br>'}</div>")
    # A blank line before the quoted original, as Outlook leaves one.
    rows.append("<div><br></div>")
    return '<div style="font-family:Calibri,Arial,Helvetica,sans-serif; font-size:11pt; line-height:1.4; color:#000000">' + "".join(rows) + "</div>"


def _body_content_type(access_token: str, message_id: str) -> str:
    """"html" or "text": the format of the message being replied to. Defaults to
    html (nearly all mail) when it cannot be read; the reply itself would then
    report the real problem."""
    response = _get_with_retry(f"{GRAPH_BASE}/me/messages/{message_id}", access_token, {"$select": "body"}, timeout=15)
    if response.status_code != 200:
        return "html"
    return str((response.json().get("body") or {}).get("contentType") or "html").lower()


def reply_to_message(access_token: str, message_id: str, comment: str) -> None:
    """Phase 14d — sends a reply to the ORIGINAL SENDER ONLY (Graph's own
    /reply endpoint, not /replyAll) with the given comment as the reply body.
    Graph handles recipient resolution, the "RE:" subject prefix, and
    quoting the original message automatically — deliberately not
    reconstructed manually via /me/sendMail. Requires the Mail.Send scope
    (see backend/src/outlook/outlook.service.ts's GRAPH_SCOPES) — a token
    issued before that scope was added will fail this call with a real
    Graph permission error, which the caller should surface honestly.

    Deliberately NOT built on graph_post() — Graph's /reply returns 202
    Accepted with an empty body on success, and graph_post()'s every other
    caller assumes response.json() always succeeds (true for /me/events,
    which this app's only other graph_post caller targets). Calling
    response.json() on that empty body would raise a JSON decode error and
    misreport a genuinely successful send as a failure.

    `comment` is the reply as written, in plain text. It is sent as HTML
    (_comment_html) unless the original is a plain-text email, whose reply is
    plain text too and keeps its line breaks as they are."""
    if _body_content_type(access_token, message_id) != "text":
        comment = _comment_html(comment)
    # Only a throttled request (429) is repeated: Graph refused it outright, so
    # nothing was sent. A timeout or 5xx is NOT retried - the reply may already
    # have gone out, and sending it twice is worse than reporting a failure.
    for attempt in range(3):
        response = requests.post(
            f"{GRAPH_BASE}/me/messages/{message_id}/reply",
            headers={"Authorization": f"Bearer {access_token}"},
            json={"comment": comment},
            timeout=30,
        )
        if response.status_code == 429 and attempt < 2:
            time.sleep(min(float(response.headers.get("Retry-After") or 3 * (attempt + 1)), 20))
            continue
        break
    response.raise_for_status()


def list_conversation_messages(access_token: str, conversation_id: str, top: int = 20) -> list[dict]:
    """All messages in one Outlook conversation thread, oldest first — used
    by the AI Follow-up draft flow so the model sees the real back-and-forth
    (customer -> employee -> customer -> ...) instead of only the latest
    message. Falls back to an empty list on any Graph error (missing scope,
    rate limit, malformed id) — the caller treats "no thread" as a normal,
    valid outcome and drafts from the single email it already has instead."""
    try:
        data = graph_get(
            "/me/messages",
            access_token,
            params={
                "$filter": f"conversationId eq '{conversation_id}'",
                "$orderby": "receivedDateTime asc",
                "$top": top,
                "$select": "from,receivedDateTime,bodyPreview,subject",
            },
        )
    except requests.RequestException:
        return []
    return data.get("value", [])


def list_recent_messages(access_token: str, top: int = 50) -> list[dict]:
    """Recent inbox messages for the RAG business sync job — includes `id`
    (needed for a deterministic Qdrant point id) alongside the fields
    outlook_tool.py already selects for on-demand chat lookups."""
    data = graph_get(
        "/me/messages",
        access_token,
        params={
            "$top": top,
            "$orderby": "receivedDateTime desc",
            "$select": "id,subject,from,receivedDateTime,bodyPreview",
        },
    )
    return data.get("value", [])

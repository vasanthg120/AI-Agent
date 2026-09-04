import hashlib

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

    response = requests.get(
        f"{GRAPH_BASE}{path}",
        headers={"Authorization": f"Bearer {access_token}"},
        params=params,
        timeout=15,
    )
    response.raise_for_status()
    body = response.json()

    if key is not None:
        cache.set_json(key, body, settings.outlook_cache_ttl_seconds)
    return body


def graph_post(path: str, access_token: str, json_body: dict) -> dict:
    response = requests.post(
        f"{GRAPH_BASE}{path}",
        headers={"Authorization": f"Bearer {access_token}"},
        json=json_body,
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


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
    misreport a genuinely successful send as a failure."""
    response = requests.post(
        f"{GRAPH_BASE}/me/messages/{message_id}/reply",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"comment": comment},
        timeout=15,
    )
    response.raise_for_status()


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

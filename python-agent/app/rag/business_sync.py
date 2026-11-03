import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from qdrant_client.http import models as qmodels

from app.config import settings
from app.integrations import ms_graph
from app.memory import outlook_store
from app.memory.mongo_client import get_db
from app.rag import embeddings, vector_store
from app.tools import crm_account_tool, crm_deal_tool, crm_note_tool, crm_quote_tool, crm_tool

logger = logging.getLogger(__name__)

# Fixed constant (never change) — same source_type:record_id always maps to
# the same point id, so re-syncing a record updates it in place instead of
# duplicating it.
_POINT_NAMESPACE = uuid.NAMESPACE_URL

# CRM data has no single owner within a business — every point still gets a
# user_id so every query filter is a plain match with no null-field special
# casing; "*" means "shared within this point's business", which is why these
# points also carry organization_id (see settings.crm_rag_organization_id and
# business_search_tool._search_filter).
_SHARED_USER = "*"


def _point_id(source_type: str, record_id: str) -> str:
    return str(uuid.uuid5(_POINT_NAMESPACE, f"{source_type}:{record_id}"))


def _record_id(record: dict) -> str | None:
    rid = record.get("_id") or record.get("id")
    return str(rid) if rid else None


def _record_to_text(label: str, record: dict, skip: frozenset = frozenset({"_id", "id"})) -> str:
    parts = [
        f"{k.replace('_', ' ')}: {v}"
        for k, v in record.items()
        if k not in skip and v not in (None, "", [])
    ]
    return f"{label} — " + "; ".join(parts)


def _records_to_pairs(label: str, records: list) -> list[tuple[str, str]]:
    pairs = []
    for record in records:
        if not isinstance(record, dict):
            continue
        rid = _record_id(record)
        if not rid:
            continue
        pairs.append((rid, _record_to_text(label, record)))
    return pairs


def _extract_records(body, keys: tuple[str, ...]) -> list:
    """CRM list endpoints vary in their wrapper shape; try each known key
    before giving up, rather than hard-coding one assumed shape."""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for key in keys:
            value = body.get(key)
            if isinstance(value, list):
                return value
    return []


def _embed_and_build_points(
    source_type: str, id_text_pairs: list[tuple[str, str]], user_id: str = _SHARED_USER
) -> list[qmodels.PointStruct]:
    if not id_text_pairs:
        return []
    texts = [text for _, text in id_text_pairs]
    vectors = embeddings.embed(texts)
    synced_at = datetime.now(timezone.utc).isoformat()
    return [
        qmodels.PointStruct(
            id=_point_id(source_type, record_id),
            vector=vector,
            payload={
                "source_type": source_type,
                "user_id": user_id,
                **({"organization_id": settings.crm_rag_organization_id} if user_id == _SHARED_USER else {}),
                "record_id": record_id,
                "text": text,
                "synced_at": synced_at,
            },
        )
        for (record_id, text), vector in zip(id_text_pairs, vectors)
    ]


def _sync_list_endpoint(
    source_type: str, label: str, fetch_page, record_keys: tuple[str, ...], limit: int = 100
) -> tuple[int, list[str]]:
    """Pages through a CRM list endpoint (fetch_page(offset, limit) -> raw
    body) until a page comes back short or the page cap is hit, embedding
    and upserting each page as it goes."""
    total = 0
    ids: list[str] = []
    offset = 0
    for _ in range(settings.rag_sync_max_pages):
        body = fetch_page(offset, limit)
        records = _extract_records(body, record_keys)
        if not records:
            break
        pairs = _records_to_pairs(label, records)
        points = _embed_and_build_points(source_type, pairs)
        if points:
            vector_store.upsert_points(points)
        total += len(points)
        ids.extend(rid for rid, _ in pairs)
        if len(records) < limit:
            break
        offset += limit
    return total, ids


def _sync_notes_for_contacts(contact_ids: list[str]) -> int:
    if not contact_ids:
        return 0

    def fetch(contact_id: str) -> list[dict]:
        try:
            return crm_note_tool._fetch_raw_notes(contact_id)
        except Exception:
            logger.exception("Note sync failed for contact %s", contact_id)
            return []

    # Same pattern as app/agent/graph.py's tools_node — one HTTP call per
    # contact, independent and I/O-bound, so run them concurrently instead
    # of sequentially (this is a background job, not a live request, but
    # there's no reason to pay N round-trips serially either way).
    with ThreadPoolExecutor(max_workers=min(len(contact_ids), 8) or 1) as executor:
        results = list(executor.map(fetch, contact_ids))

    pairs: list[tuple[str, str]] = []
    for contact_id, notes in zip(contact_ids, results):
        for i, note in enumerate(notes):
            if not isinstance(note, dict):
                continue
            note_id = _record_id(note) or f"{contact_id}:{i}"
            pairs.append((note_id, _record_to_text("CRM Note", note)))

    points = _embed_and_build_points("crm_note", pairs)
    if points:
        vector_store.upsert_points(points)
    return len(points)


def sync_crm() -> dict:
    """Each CRM module is wrapped independently — one endpoint failing (e.g.
    quotes down) must not abort the others. Skipped unless it's known which
    business this CRM belongs to: indexing it for nobody in particular is how one
    business's records would become searchable by another."""
    if not settings.crm_rag_organization_id:
        if settings.crm_base_url:
            logger.warning("CRM_BASE_URL is set but CRM_RAG_ORGANIZATION_ID is not, so that CRM isn't indexed for AI search.")
        return {"skipped": "no organization for the configured CRM"}

    summary: dict = {}
    contact_ids: list[str] = []

    try:
        fields = crm_tool._LIST_DEFAULT_FIELDS + ["_id"]
        count, contact_ids = _sync_list_endpoint(
            "crm_contact",
            "CRM Contact",
            lambda offset, limit: crm_tool._fetch_raw_contacts(search_after=offset, limit=limit, fields=fields),
            ("data",),
        )
        summary["contacts"] = count
    except Exception:
        logger.exception("CRM contact sync failed")
        summary["contacts"] = "error"

    try:
        summary["notes"] = _sync_notes_for_contacts(contact_ids)
    except Exception:
        logger.exception("CRM note sync failed")
        summary["notes"] = "error"

    try:
        fields = crm_deal_tool._LIST_DEFAULT_FIELDS + ["_id"]
        count, _ids = _sync_list_endpoint(
            "crm_deal",
            "CRM Deal",
            lambda offset, limit: crm_deal_tool._fetch_raw_deals(offset=offset, page_limit=limit, fields=fields),
            ("deal", "deals", "data"),
        )
        summary["deals"] = count
    except Exception:
        logger.exception("CRM deal sync failed")
        summary["deals"] = "error"

    try:
        fields = crm_account_tool._LIST_DEFAULT_FIELDS + ["_id"]
        count, _ids = _sync_list_endpoint(
            "crm_account",
            "CRM Account",
            lambda offset, limit: crm_account_tool._fetch_raw_accounts(offset=offset, limit=limit, fields=fields),
            ("data", "accounts", "account"),
        )
        summary["accounts"] = count
    except Exception:
        logger.exception("CRM account sync failed")
        summary["accounts"] = "error"

    try:
        count, _ids = _sync_list_endpoint(
            "crm_quote",
            "CRM Quote",
            lambda offset, limit: crm_quote_tool._fetch_raw_quotes(start_after=offset, limit=limit),
            ("quotes",),
        )
        summary["quotes"] = count
    except Exception:
        logger.exception("CRM quote sync failed")
        summary["quotes"] = "error"

    return summary


def sync_outlook_for_user(user_id: str) -> int:
    # Wrapped end-to-end (not just the Graph call) — this runs inside a
    # ThreadPoolExecutor.map in sync_all(); an uncaught exception here would
    # propagate on iteration and abort every other user's sync too, and
    # CRM sync already degrades per-module on failure, so Outlook should too.
    try:
        token = outlook_store.get_valid_access_token(user_id)
        if not token:
            return 0

        messages = ms_graph.list_recent_messages(token, top=50)

        pairs = []
        for message in messages:
            message_id = message.get("id")
            if not message_id:
                continue
            sender = (message.get("from") or {}).get("emailAddress", {}).get("address", "")
            subject = message.get("subject", "")
            preview = message.get("bodyPreview", "")
            pairs.append((message_id, f"Email from {sender} — subject: {subject} — {preview}"))

        points = _embed_and_build_points("outlook_email", pairs, user_id=user_id)
        if points:
            vector_store.upsert_points(points)
        return len(points)
    except Exception:
        logger.exception("Outlook sync failed for user %s", user_id)
        return 0


def sync_all() -> dict:
    crm_summary = sync_crm()

    # Nobody is working in an archived business, so its mail isn't re-indexed.
    archived = [str(org["_id"]) for org in get_db().organizations.find({"status": "archived"}, {"_id": 1})]
    user_ids = get_db().outlook_connections.distinct("userId", {"isActive": True, "organizationId": {"$nin": archived}})
    with ThreadPoolExecutor(max_workers=min(len(user_ids), 8) or 1) as executor:
        list(executor.map(sync_outlook_for_user, user_ids))

    return {"crm": crm_summary, "outlook_users_synced": len(user_ids)}

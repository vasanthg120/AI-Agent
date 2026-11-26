"""Server-side check behind the Zapier preview-then-confirm approval.

`confirmed=true` is written by the model, so on its own it proves nothing: the
model could send it on its first call, or preview and confirm back to back.
A write is allowed only when this organization's user was previewed the same
action with the same inputs in this conversation during an EARLIER turn
(a different request_id, i.e. the user has sent a message since), and each
preview approves one run.

It does not read what the user replied; judging "yes" from "no" is still the
model's job.

Fails closed: without a full identity (e.g. calls over /mcp have no
request_id) or without Mongo, nothing is approved.
"""

import hashlib
import json
from datetime import datetime, timedelta, timezone

from app.memory.mongo_client import get_db

TTL = timedelta(minutes=30)
_IDENTITY = ("organization_id", "user_id", "conversation_id")


def _collection():
    return get_db().zapier_approvals


def _scope(context: dict, tool_name: str) -> dict | None:
    if not all(context.get(key) for key in (*_IDENTITY, "request_id")):
        return None
    return {**{key: context[key] for key in _IDENTITY}, "tool_name": tool_name}


def _key(scope: dict, arguments: dict) -> str:
    canonical = json.dumps([scope, arguments], sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def record_preview(context: dict, tool_name: str, arguments: dict) -> None:
    scope = _scope(context, tool_name)
    if scope is None:
        return
    now = datetime.now(timezone.utc)
    collection = _collection()
    collection.delete_many({"expiresAt": {"$lte": now}})
    # $setOnInsert: previewing the same thing again must not move it into the
    # current turn and so cancel an approval the user has just given.
    collection.update_one(
        {"_id": _key(scope, arguments)},
        {"$setOnInsert": {**scope, "arguments": arguments, "request_id": context["request_id"], "expiresAt": now + TTL}},
        upsert=True,
    )


def consume(context: dict, tool_name: str, arguments: dict) -> bool:
    """True once per earlier-turn preview. Atomic, so parallel identical calls
    can't both use it."""
    scope = _scope(context, tool_name)
    if scope is None:
        return False
    return (
        _collection().find_one_and_delete(
            {
                "_id": _key(scope, arguments),
                "request_id": {"$ne": context["request_id"]},
                "expiresAt": {"$gt": datetime.now(timezone.utc)},
            }
        )
        is not None
    )


def earlier_previews(context: dict, tool_name: str) -> list[dict]:
    """Inputs still awaiting approval from earlier turns. Chat history keeps only
    message text, so the model may need these to repeat them exactly."""
    scope = _scope(context, tool_name)
    if scope is None:
        return []
    found = _collection().find(
        {
            **scope,
            "request_id": {"$ne": context["request_id"]},
            "expiresAt": {"$gt": datetime.now(timezone.utc)},
        }
    )
    return [doc["arguments"] for doc in found][:5]

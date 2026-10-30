from bson import ObjectId

from app.cache.cache import cache_key, get_json, set_json
from app.config import settings
from app.memory.mongo_client import get_db

# Short-term "conversation state" cache — a burst of agent activity within
# one turn (e.g. the orchestrator's specialist fan-out, app.agent.orchestrator)
# would otherwise re-read the same conversation doc from Mongo several times
# in a few seconds. Deliberately short: the backend appends the user's and
# assistant's messages right after this read, so a longer TTL would risk
# serving stale history on the next turn.
_TTL_SECONDS = 15


def get_recent_messages(
    conversation_id: str,
    user_id: str | None,
    organization_id: str | None,
    limit: int = settings.conversation_history_limit,
) -> list[dict]:
    """Reads conversation history the NestJS backend already persisted.

    The backend owns writes to this collection (it appends both the user's
    message and the agent's reply after each turn); the agent only reads it
    to reconstruct context for the LangGraph loop.

    Scoped by BOTH user_id and organization_id (always the JWT-sub-verified
    and JWT-derived values from the calling route — see chat.py's
    _assert_user_id_matches — never trusted as client-supplied on their own)
    so a conversation_id belonging to someone else can never be read into
    this turn's context: Conversation.userId is this collection's actual
    ownership key (see conversation.schema.ts's own comment — a user id is
    unique deployment-wide, not just per org), organizationId is kept as a
    second, redundant check. Without this, any guessed/known ObjectId would
    silently work, since conversation_id alone isn't secret. Also folded
    into the cache key so a cache hit can't bypass the check within the TTL.
    """
    if not organization_id or not user_id:
        return []

    key = cache_key(
        "conversation", conversation_id, {"limit": limit, "organization_id": organization_id, "user_id": user_id}
    )
    cached = get_json(key)
    if cached is not None:
        return cached

    try:
        doc = get_db().conversations.find_one(
            {"_id": ObjectId(conversation_id), "organizationId": organization_id, "userId": user_id}
        )
    except Exception:
        return []
    messages = doc.get("messages", [])[-limit:] if doc else []
    set_json(key, messages, _TTL_SECONDS)
    return messages

"""Mem0-backed long-term User Memory — the engine behind both the explicit
`remember` tool (app.tools.memory_tool) and the `memory` source in
search_business_context (app.tools.business_search_tool), plus two new
automatic behaviors wired in app.routes.chat: auto-retrieve before a turn and
auto-extract after one, so the agent no longer has to be explicitly told to
save or search for something (see the Mem0 integration doc this replaces the
old hand-rolled app.memory.user_memory storage with).

Deliberately reuses existing infra rather than introducing a second stack:
- LLM: Anthropic, via settings.anthropic_routing_model — the same cheaper/
  faster model already used for one-shot judgment calls (classify_request,
  critique_response in app.agent.anthropic_client); Mem0's fact-extraction/
  consolidation call is exactly that kind of call.
- Embedder: the same sentence-transformers model app.rag.embeddings already
  loads (settings.embedding_model), via Mem0's "huggingface" provider, which
  loads a plain SentenceTransformer locally when no huggingface_base_url is
  set (confirmed against mem0.embeddings.huggingface.HuggingFaceEmbedding) —
  no OpenAI embeddings, no new API cost. This is a second in-memory copy of
  the model (Mem0 doesn't share app.rag.embeddings' cached instance), a small
  known memory cost for keeping Mem0 self-contained rather than fighting its
  embedder interface.
- Vector store: Qdrant, the exact same QdrantClient instance app.rag.vector_store
  already maintains (via get_client()), but a separate collection
  (settings.qdrant_mem0_collection) — Mem0 owns its own point schema/ids
  internally, incompatible with the source_type-discriminated scheme
  app.rag.hybrid_search/retriever depend on in the shared collection.

Known limitation: Mem0 OSS keeps a small local SQLite file as its own
add/update/delete history audit log (separate from memory content itself,
which lives in Qdrant above) — acceptable for now under the same
single-instance assumption app.main's BackgroundScheduler already documents;
revisit if python-agent is ever run as multiple replicas.
"""

import logging
import os
from functools import lru_cache

# Must be set before `mem0` is first imported anywhere in the process — it's
# read once at module import time (mem0.memory.telemetry). Mem0 defaults to
# ON (anonymized usage events to its own PostHog project); the whole point
# of choosing self-hosted OSS over Mem0 Cloud was no new third-party data
# flow, so this stays off unless an operator explicitly opts back in.
os.environ.setdefault("MEM0_TELEMETRY", "False")

from mem0 import Memory  # noqa: E402 - must follow the telemetry env var above

from app.config import settings
from app.memory import integration_store
from app.rag import embeddings, vector_store

logger = logging.getLogger(__name__)

# Same literal text as anthropic_client.py's _ANTHROPIC_NOT_CONFIGURED_MESSAGE
# — not imported from there to avoid a circular import (anthropic_client.py
# -> app.tools.registry -> business_search_tool -> this module).
_ANTHROPIC_NOT_CONFIGURED_MESSAGE = "Anthropic AI provider is not configured. Please connect Anthropic from Platform Admin Settings."


@lru_cache
def get_memory() -> Memory:
    # Same platform-only credential rule as anthropic_client.py._resolve_api_key
    # — resolved once here (this whole Memory engine is @lru_cache'd, matching
    # its pre-existing behavior of reading a module-level settings value once
    # per process), not re-checked per Mem0 call. MongoDB remains the source
    # of truth; only the read timing differs from the main chat path's
    # per-call resolution.
    api_key = integration_store.get_api_key("anthropic", organization_id="platform")
    if not api_key:
        raise RuntimeError(_ANTHROPIC_NOT_CONFIGURED_MESSAGE)
    return Memory.from_config(
        {
            "llm": {
                "provider": "anthropic",
                "config": {
                    "model": settings.anthropic_routing_model,
                    "api_key": api_key,
                },
            },
            "embedder": {
                "provider": "huggingface",
                "config": {
                    "model": settings.embedding_model,
                },
            },
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "collection_name": settings.qdrant_mem0_collection,
                    "embedding_model_dims": embeddings.vector_size(),
                    "client": vector_store.get_client(),
                },
            },
        }
    )


def add_from_turn(user_id: str, user_message: str, assistant_reply: str) -> None:
    """Automatic extraction — called fire-and-forget after a chat turn (see
    app.routes.chat) with the raw exchange; Mem0's own LLM call decides what,
    if anything, is worth keeping and whether it's a new fact, an update to
    an existing one, or a duplicate to skip. Never raises — a memory-layer
    failure must never surface as a chat error since this always runs after
    the user-visible reply is already computed."""
    if not user_id:
        return
    try:
        get_memory().add(
            [
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": assistant_reply},
            ],
            user_id=user_id,
            infer=True,
        )
    except Exception:
        logger.exception("Mem0 auto-extraction failed for user_id=%s", user_id)


def add_explicit(user_id: str, text: str) -> str:
    """Explicit save — backs app.memory.user_memory.save_memory (the
    `remember` tool's storage). Unlike add_from_turn, a caller here is
    already telling us this is worth remembering, but infer=True still runs
    Mem0's own dedup/update logic against existing memories rather than a
    blind insert, so calling `remember` twice with near-duplicate text
    updates one memory instead of accumulating duplicates forever.

    Returns a single id for memory_tool.py's "Saved to long-term memory
    (id=...)" message — the first affected memory's id, or "unchanged" when
    Mem0 decides this exact fact is already known (no new/updated result).
    """
    result = get_memory().add([{"role": "user", "content": text}], user_id=user_id, infer=True)
    results = result.get("results") or []
    return results[0]["id"] if results else "unchanged"


def search(query: str, user_id: str, limit: int = 5) -> list[str]:
    """Relevant-memory lookup — backs both the automatic pre-turn retrieval
    in app.routes.chat and the explicit `memory` source in
    search_business_context. Returns plain memory text strings (callers
    format them however fits their context), and degrades to an empty list
    on any failure — a memory-layer outage must never break a chat turn or a
    tool call."""
    if not user_id:
        return []
    try:
        result = get_memory().search(query, filters={"user_id": user_id}, top_k=limit)
        return [hit["memory"] for hit in result.get("results", [])]
    except Exception:
        logger.exception("Mem0 search failed for user_id=%s", user_id)
        return []


def list_all(user_id: str, limit: int = 50) -> list[dict]:
    result = get_memory().get_all(filters={"user_id": user_id}, top_k=limit)
    return result.get("results", [])


def delete(user_id: str, memory_id: str) -> None:
    # Mem0's delete() takes only a memory_id (no ownership check) — verify
    # this id actually belongs to user_id first, preserving the same
    # per-user boundary the old Mongo-scoped delete_one({..., "userId":
    # user_id}) enforced, so one user can never delete another's memory by
    # guessing/enumerating ids.
    owned_ids = {m["id"] for m in list_all(user_id, limit=1000)}
    if memory_id not in owned_ids:
        return
    get_memory().delete(memory_id)

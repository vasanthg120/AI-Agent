"""Long-term memory: durable per-user facts/preferences the agent keeps
across conversations (see app.tools.memory_tool's `remember` tool).

Backed by Mem0 (app.memory.mem0_client) rather than a hand-rolled Mongo +
Qdrant dual-write — Mem0 owns extraction, dedup, and update/delete decisions
so calling `remember` twice with a near-duplicate fact updates one memory
instead of accumulating rows forever, which the old raw-insert version never
did. Function signatures kept identical to the pre-Mem0 version so
app.tools.memory_tool needs no changes.
"""

from app.memory import mem0_client


def save_memory(user_id: str, text: str, memory_type: str = "fact") -> str:
    # memory_type (preference/fact/episodic, see memory_tool.py's SPEC) isn't
    # a Mem0 concept — folded into the text itself isn't needed either, since
    # Mem0 classifies/extracts the content on its own merits regardless of
    # this app-level label. Kept as a parameter for interface compatibility
    # with memory_tool.py's existing call site.
    return mem0_client.add_explicit(user_id, text)


def list_memories(user_id: str, limit: int = 50) -> list[dict]:
    return mem0_client.list_all(user_id, limit=limit)


def delete_memory(user_id: str, memory_id: str) -> None:
    mem0_client.delete(user_id, memory_id)

"""The dynamic engine's user-facing streaming contract.

master_agent's events are INTERNAL: they carry full unredacted sub-agent
results, the planner's reasoning and task details. None is ever forwarded
as-is. Each is rebuilt here from an explicit list of safe fields, and anything
not listed (including a future event type) is dropped.

Each internal event produces at most one outgoing event, so nothing is shown
twice:

  internal                      sent to the client
  delegation_started            plan            {agents}
  understanding                 reasoning       {text}  (fixed text only)
  tool_execution                progress        {tool}  (registered names only)
  agent_progress: done          agent_done      {agent}
  agent_created                 agent_created   {agent, agent_id, depth}
  agent_progress: running       agent_progress  {agent, agent_id, status}   ("agent started")
  agent_progress: retrying      agent_progress  {agent, agent_id, status, attempt}
  agent_progress: failed        agent_progress  {agent, agent_id, status, attempt?}
  validation                    validation      {agent, agent_id, status}
  agent_completed               nothing (agent_done already reports it)

Final completion is app.routes.chat's own "done" frame.

backend/src/chat/stream-events.ts mirrors the fields;
tests/fixtures/dynamic_stream_contract.json pins the exact output and is read
by the NestJS tests.
"""

import re

from app.observability.guardrails import redact_secrets

_MAX_LABEL = 80
_AGENT_ID = re.compile(r"^dyn-[0-9a-f]{1,32}$")
_PROGRESS_STATUSES = {"running", "retrying", "failed"}
_VALIDATION_STATUSES = {"passed", "failed"}
PLANNING_TEXT = "Planning…"


def _label(value: object) -> str:
    """An agent name is written by the planner model: one short, redacted line."""
    text = " ".join(str(value or "").split())
    return redact_secrets(text)[:_MAX_LABEL] or "sub-agent"


def _identity(event: dict) -> dict:
    out = {"agent": _label(event.get("agent"))}
    agent_id = event.get("agent_id")
    if isinstance(agent_id, str) and _AGENT_ID.match(agent_id):
        out["agent_id"] = agent_id
    return out


def _count(event: dict, key: str) -> dict:
    value = event.get(key)
    return {key: value} if type(value) is int and 0 <= value <= 100 else {}


def _is_registered_tool(name: object) -> bool:
    from app.tools.registry import TOOL_DEFINITIONS

    return any(d["name"] == name for d in TOOL_DEFINITIONS)


def to_client_event(event: dict) -> dict | None:
    kind = event.get("type")
    status = event.get("status")
    if kind == "delegation_started":
        return {"type": "plan", "agents": [_label(name) for name in event.get("agents") or []]}
    if kind == "understanding":
        return {"type": "reasoning", "text": PLANNING_TEXT}
    if kind == "tool_execution":
        tool = event.get("tool")
        return {"type": "progress", "tool": tool} if _is_registered_tool(tool) else None
    if kind == "agent_created":
        return {"type": "agent_created", **_identity(event), **_count(event, "depth")}
    if kind == "agent_progress":
        if status == "done":
            return {"type": "agent_done", "agent": _label(event.get("agent"))}
        if status in _PROGRESS_STATUSES:
            return {"type": "agent_progress", **_identity(event), "status": status, **_count(event, "attempt")}
        return None
    if kind == "validation" and status in _VALIDATION_STATUSES:
        return {"type": "validation", **_identity(event), "status": status}
    return None

"""What a dynamically-created sub-agent may do with each registered tool.

A dynamic sub-agent runs with no human in its own execution turn. The
preview-then-confirm gate some tools have relies on a person reading the
preview and replying, so a model passing confirmed=true there is not an
approval, and some write tools have no gate at all.

EVERY registered tool must appear in TOOL_CLASSIFICATION. A tool that doesn't
(newly added, renamed) is refused for dynamic agents: default deny. A test
fails until it is classified, so adding a tool forces this decision.

Classes (each checked against the tool's handler, not guessed from its name):

READ_ONLY      Only reads data. Allowed as-is.
READ_ACTIONS   Mixes reads and writes. Only the actions in _READ_ACTIONS are
               allowed; any other action, a new one or a missing one is
               refused.
PREVIEW_ONLY   Writes only when confirmed. `confirmed` is forced to False, so
               the agent gets the preview and can never commit. zapier goes
               further and previews every action for a dynamic agent, reads
               included (see app.tools.zapier_tool): read/write is inferred
               from names, so it isn't relied on with no human present.
MEMORY_WRITE   Writes the user's long-term memory. Blocked, see below.
BUSINESS_WRITE Commits to an external or business system with no confirmation
               gate. Blocked.

Why `remember` is blocked: it writes memory keyed by user only (no
organization), Mem0 may update or delete existing memories while saving, and
saved text is fed back into later system prompts, so text planted in a tool
result could persist. Normal chat keeps `remember`, and the automatic memory
extraction after each turn (app.routes.chat) is unaffected.

Applied only when context carries agent_instance_id (see
app.tools.registry.execute_tool); the normal chat path never consults it.
"""

READ_ONLY = "read_only"
READ_ACTIONS = "read_actions"
PREVIEW_ONLY = "preview_only"
MEMORY_WRITE = "memory_write"
BUSINESS_WRITE = "business_write"

TOOL_CLASSIFICATION: dict[str, str] = {
    "crm_account": READ_ONLY,
    "crm_deal": READ_ONLY,
    "crm_note": READ_ONLY,
    "crm_product": READ_ONLY,
    "crm_quote": READ_ONLY,
    "crm_source_records": READ_ONLY,
    "crm_tag": READ_ONLY,
    "employee_lookup": READ_ONLY,
    "gmail_lookup": READ_ONLY,
    "gorilladash_lookup": READ_ONLY,
    "integration_capabilities": READ_ONLY,
    "outlook_lookup": READ_ONLY,
    "query_database": READ_ONLY,
    "search_business_context": READ_ONLY,
    "search_documents": READ_ONLY,
    "web_search": READ_ONLY,
    "calendar_tool": READ_ACTIONS,
    "crm_contact": READ_ACTIONS,
    "crm_create_task": PREVIEW_ONLY,
    "gorilladash_action": PREVIEW_ONLY,
    "zapier": PREVIEW_ONLY,
    "remember": MEMORY_WRITE,
    "integration_execute": BUSINESS_WRITE,
    "send_email": BUSINESS_WRITE,
    "send_whatsapp_message": BUSINESS_WRITE,
}

_READ_ACTIONS = {
    "calendar_tool": {"list_events"},
    "crm_contact": {"list", "search_by_ids"},
}

_GRANTABLE = {READ_ONLY, READ_ACTIONS, PREVIEW_ONLY}

_BLOCK_REASONS = {
    MEMORY_WRITE: "autonomous sub-agents may not write to long-term memory",
    BUSINESS_WRITE: "this action has no safe preview mode for an autonomous sub-agent; a human must perform it directly",
    None: "this tool has not been classified as safe for autonomous sub-agents",
}


def is_grantable(name: str) -> bool:
    return TOOL_CLASSIFICATION.get(name) in _GRANTABLE


def permitted_tools(parent_allowed: list[str] | None) -> list[str]:
    """The tools a dynamic agent may hold: the parent's own scope (None means
    the parent is unrestricted; an empty list means it has no tools) minus
    everything this policy refuses outright. Always returns an explicit list."""
    from app.tools.registry import TOOL_DEFINITIONS  # lazy: the registry imports this module

    registered = [d["name"] for d in TOOL_DEFINITIONS]
    parent = registered if parent_allowed is None else parent_allowed
    return narrow(parent, [name for name in registered if is_grantable(name)])


def narrow(requested: list[str] | None, scope: list[str]) -> list[str]:
    """`requested` limited to `scope` — a child can only ever lose tools,
    never gain one its parent doesn't hold. Nothing requested means nothing,
    and so does anything that isn't a list of names (the planner writes it)."""
    allowed = set(scope)
    names = [n for n in requested if isinstance(n, str)] if isinstance(requested, list) else []
    return [name for name in dict.fromkeys(names) if name in allowed]


def check(name: str, tool_input: dict) -> tuple[dict | None, str | None]:
    """Returns (safe_tool_input, None) if the call may proceed, or
    (None, reason) if it must be refused before the real handler is reached.
    Looks only at the tool name and its input, never at surrounding text."""
    kind = TOOL_CLASSIFICATION.get(name)
    if kind == READ_ONLY:
        return tool_input, None
    if kind == READ_ACTIONS:
        action = tool_input.get("action")
        if action in _READ_ACTIONS.get(name, set()):
            return tool_input, None
        return None, f"only read actions are allowed here, not '{action}'"
    if kind == PREVIEW_ONLY:
        if tool_input.get("confirmed"):
            return {**tool_input, "confirmed": False}, None
        return tool_input, None
    return None, _BLOCK_REASONS.get(kind, _BLOCK_REASONS[None])

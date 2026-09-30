"""Short-term memory: Redis-backed, short-TTL caching of tool execution state
and conversation reads within a single burst of agent activity — e.g. a
multi-round planner<->tools loop, or the orchestrator's concurrent specialist
fan-out (app.agent.orchestrator), which can otherwise repeat identical CRM/
Outlook lookups seconds apart.

Built on app.cache.cache, which is already fail-open (a Redis outage
degrades to a cache miss, never an error) — this module inherits that
behavior for free, so it's safe to use even where Redis isn't running.
"""

from app.cache.cache import cache_key, get_json, set_json
from app.tools.registry import execute_tool

TOOL_RESULT_TTL_SECONDS = 90

# Only read-only tool calls are safe to dedup by exact arguments — caching a
# mutation (send_email, send_whatsapp_message, remember, or crm_contact's
# default "upsert" action) would silently swallow a legitimate repeat action
# within the TTL window. Tools not listed here, and actions not listed in
# _READ_ACTIONS for the mixed read/write tools below, are never cached.
_READ_ONLY_TOOLS = {
    "crm_deal",
    "crm_note",
    "crm_tag",
    "crm_account",
    "crm_product",
    "crm_quote",
    "outlook_lookup",
    "query_database",
    "employee_lookup",
    "search_documents",
    "search_business_context",
    "web_search",
    "gorilladash_lookup",
    "crm_source_records",
}

# crm_contact and calendar_tool mix read and write actions in one tool
# (crm_contact even defaults to the mutating "upsert" when action is
# omitted) — only cache the specific actions confirmed read-only.
_READ_ACTIONS = {
    "crm_contact": {"list", "search_by_ids"},
    "calendar_tool": {"list_events"},
}


def _is_cacheable(name: str, tool_input: dict) -> bool:
    if name in _READ_ONLY_TOOLS:
        return True
    read_actions = _READ_ACTIONS.get(name)
    return read_actions is not None and tool_input.get("action") in read_actions


def cached_execute_tool(
    name: str, tool_input: dict, context: dict, allowed_tools: list[str] | None = None
) -> str:
    if not _is_cacheable(name, tool_input):
        return execute_tool(name, tool_input, context, allowed_tools=allowed_tools)

    # Scoped by user_id so one user's cached result can never leak into
    # another's tool call, even though most CRM data is shared (user_id="*").
    key = cache_key("tool_result", name, {**tool_input, "_user_id": context.get("user_id", "")})
    cached = get_json(key)
    if cached is not None:
        return cached

    result = execute_tool(name, tool_input, context, allowed_tools=allowed_tools)
    set_json(key, result, TOOL_RESULT_TTL_SECONDS)
    return result

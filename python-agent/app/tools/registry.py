import requests
from jsonschema import Draft7Validator
from jsonschema.exceptions import best_match

from app.memory.rate_limiter import allow as rate_limit_allow
from app.observability.tracing import traced_tool_call
from app.tools import (
    business_search_tool,
    calendar_tool,
    crm_account_tool,
    crm_deal_tool,
    crm_note_tool,
    crm_product_tool,
    crm_quote_tool,
    crm_tag_tool,
    crm_tool,
    database_tool,
    document_tool,
    email_tool,
    employee_tool,
    gmail_tool,
    integration_capabilities_tool,
    integration_execute_tool,
    memory_tool,
    outlook_tool,
    search_tool,
    whatsapp_tool,
)

_MODULES = [
    crm_tool,
    crm_deal_tool,
    crm_note_tool,
    crm_tag_tool,
    crm_account_tool,
    crm_product_tool,
    crm_quote_tool,
    outlook_tool,
    gmail_tool,
    whatsapp_tool,
    calendar_tool,
    employee_tool,
    database_tool,
    search_tool,
    email_tool,
    document_tool,
    business_search_tool,
    memory_tool,
    integration_capabilities_tool,
    integration_execute_tool,
]

TOOL_DEFINITIONS = [m.SPEC for m in _MODULES]
_HANDLERS = {m.SPEC["name"]: m.run for m in _MODULES}
_SPECS_BY_NAME = {m.SPEC["name"]: m.SPEC for m in _MODULES}

TOOL_CALLS_PER_MINUTE = 30


def get_tool_definitions(names: list[str]) -> list[dict]:
    """Scoped subset of TOOL_DEFINITIONS for a specialist sub-agent (see
    app.agent.specialists) — restricts what a given Claude call can even
    request, rather than filtering after the fact."""
    allowed = set(names)
    return [d for d in TOOL_DEFINITIONS if d["name"] in allowed]


def _validate_input(name: str, tool_input: dict) -> str | None:
    validator = Draft7Validator(_SPECS_BY_NAME[name]["input_schema"])
    error = best_match(validator.iter_errors(tool_input))
    return f"Invalid input for '{name}': {error.message}" if error else None


def execute_tool(name: str, tool_input: dict, context: dict, allowed_tools: list[str] | None = None) -> str:
    """The single real execution boundary for every tool call — reached from
    the live chat loop (app.agent.graph, via app.memory.working_memory), the
    scheduled report crew (app.agent.crew_reports), and the MCP server
    (app.mcp_server). allowed_tools is a hard permission check, not just
    "Claude wasn't shown this tool": once tools are reachable from outside a
    scoped Claude call (MCP), the model's own tool selection is no longer
    the only thing standing between a caller and an out-of-scope tool.
    None means unrestricted (the default, unchanged for existing callers
    that never scoped access — the live single-loop chat path, and
    crew_reports.py's direct calls).
    """
    handler = _HANDLERS.get(name)
    if handler is None:
        return f"Unknown tool: {name}"

    if allowed_tools is not None and name not in allowed_tools:
        return f"Tool '{name}' is not permitted in this context."

    invalid = _validate_input(name, tool_input)
    if invalid:
        return invalid

    rate_limit_key = f"tool_calls:{name}:{context.get('user_id', '')}"
    if not rate_limit_allow(rate_limit_key, TOOL_CALLS_PER_MINUTE, 60):
        return f"Tool '{name}' rate limit exceeded — try again in a minute."

    with traced_tool_call(
        name,
        user_id=context.get("user_id", ""),
        organization_id=context.get("organization_id"),
        conversation_id=context.get("conversation_id", ""),
    ) as outcome:
        try:
            result = handler(tool_input, context)
        except requests.RequestException:
            # A network/HTTP failure calling an external provider (e.g. the
            # CRM) embeds the real request URL in str(exc) — e.g. "404
            # Client Error: ... for url: https://api.<vendor>.com/...".
            # Letting that reach Claude risks it being quoted straight back
            # to the user, defeating the whole point of white-labeling which
            # provider backs a given integration. Every other exception type
            # keeps the generic-detail message below (never a raw URL).
            outcome["success"] = False
            return f"Tool '{name}' failed: the external service request failed or timed out."
        except Exception as exc:  # tool failures become context for Claude, not crashes
            outcome["success"] = False
            return f"Tool '{name}' failed: {exc}"
        outcome["success"] = True
        return result

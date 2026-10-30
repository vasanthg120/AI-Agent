"""MCP (Model Context Protocol) server exposing this agent's tool registry
to external MCP clients (Claude Desktop, other agents, IDEs) — a standard,
interoperable surface on top of the exact same app.tools.registry.execute_tool
the live chat loop uses, with the same validation/rate-limit/permission
hardening applied uniformly (see execute_tool's docstring).

Mounted onto the main FastAPI app at /mcp (see app.main) rather than run as a
separate process, so it shares this app's config, credentials, and Mongo/
Qdrant connections with no extra deployment.

Gated by the same backend-issued JWT every other route requires (see
app.security.get_current_user) — these tools reach real CRM/Outlook/business
data, so an unauthenticated MCP client must never reach them. Unlike a normal
FastAPI route, MCP's low-level Server has no per-call request object to pull
a Depends() from, so the authenticated identity is resolved once per SSE
connection (_handle_sse) into a set of contextvars and read back in
_list_tools/_call_tool — this is what makes execute_tool's user_id/
organization_id/allowed_tools trustworthy here rather than a client-supplied
argument, which any caller could spoof to impersonate another user or widen
their own tool access.

Role-based tool scoping: an 'agent_user' account (see backend/src/users/
schemas/user.schema.ts's assignedAgentId — these accounts exist specifically
to BE one configured AgentRole/persona, mirroring chat.controller.ts's own
forced-agentId handling for the exact same role) is resolved to its assigned
persona's allowed_tools via app.agent.personas.resolve_persona — the same
function and the same allowedTools list the live chat path already enforces
for this role — and both _list_tools and _call_tool are scoped to exactly
that list, never a client-supplied tool name/argument. Every other role is
unrestricted over MCP, matching their existing unrestricted default-persona
behavior in live chat (AgentRole.assignedDepartments/assignedUserIds are
documented as @mention *visibility* only, not a tool-access boundary — see
agent-role.schema.ts).
"""

import contextvars

import jwt
import mcp.types as types
from mcp.server import Server
from mcp.server.sse import SseServerTransport
from starlette.applications import Starlette
from starlette.responses import Response
from starlette.routing import Mount, Route

from app.agent.personas import resolve_persona
from app.config import settings
from app.tools.registry import TOOL_DEFINITIONS, execute_tool, get_tool_definitions

_server = Server("franchise-ai-agent")
_current_user_id: contextvars.ContextVar[str] = contextvars.ContextVar("mcp_user_id", default="*")
# No default of "" / None here on purpose — every tool's org-scoped credential
# lookup treats a missing organization_id as "fail closed", not "search every
# tenant" (see each tool's own `if not organization_id` guard), so an unset
# contextvar must read back as None, never silently succeed unscoped.
_current_org_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("mcp_org_id", default=None)
# None means unrestricted (see execute_tool's own docstring) — the default,
# correct for every role except a locked-down 'agent_user' connection, which
# _handle_sse narrows this to before the connection ever reaches _list_tools/
# _call_tool.
_current_allowed_tools: contextvars.ContextVar[list[str] | None] = contextvars.ContextVar(
    "mcp_allowed_tools", default=None
)


@_server.list_tools()
async def _list_tools() -> list[types.Tool]:
    allowed = _current_allowed_tools.get()
    specs = get_tool_definitions(allowed) if allowed is not None else TOOL_DEFINITIONS
    return [
        types.Tool(name=spec["name"], description=spec["description"], inputSchema=spec["input_schema"])
        for spec in specs
    ]


@_server.call_tool()
async def _call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    context = {
        "user_id": _current_user_id.get(),
        "organization_id": _current_org_id.get(),
        "conversation_id": "mcp",
    }
    # allowed_tools is execute_tool's own hard permission check (see its
    # docstring) — enforced there regardless of what _list_tools advertised,
    # so a client that calls an out-of-scope tool name directly (skipping
    # discovery) is refused exactly the same way.
    result = execute_tool(name, arguments, context, allowed_tools=_current_allowed_tools.get())
    return [types.TextContent(type="text", text=result)]


def _resolve_allowed_tools(payload: dict, organization_id: str | None) -> list[str] | None:
    roles = payload.get("roles") or []
    if "agent_user" not in roles or "admin" in roles:
        return None
    # Mirrors chat.controller.ts's own forced-agentId handling for this same
    # role: an agent_user connection is always scoped to its one assigned
    # persona, never a caller-chosen one — there is no client-supplied agent
    # id in MCP's protocol at all, so this is resolved purely from the JWT.
    persona = resolve_persona(payload.get("assignedAgentId"), organization_id)
    return persona.allowed_tools


def _verify_jwt(request) -> dict | None:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return None
    try:
        return jwt.decode(header[7:], settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


_sse = SseServerTransport("/messages/")


async def _handle_sse(request):
    payload = _verify_jwt(request)
    if payload is None or "sub" not in payload:
        return Response(status_code=401)

    user_token = _current_user_id.set(payload["sub"])
    # Same claim the backend-issued JWT carries for every other authenticated
    # route (see app.security.get_current_user's docstring) — short-lived
    # internal tokens with no organizationId correctly fall back to None,
    # which every org-scoped tool now refuses rather than resolving unscoped.
    organization_id = payload.get("organizationId")
    org_token = _current_org_id.set(organization_id)
    tools_token = _current_allowed_tools.set(_resolve_allowed_tools(payload, organization_id))
    try:
        async with _sse.connect_sse(request.scope, request.receive, request._send) as (read_stream, write_stream):
            await _server.run(read_stream, write_stream, _server.create_initialization_options())
    finally:
        _current_user_id.reset(user_token)
        _current_org_id.reset(org_token)
        _current_allowed_tools.reset(tools_token)
    return Response()


app = Starlette(
    routes=[
        Route("/sse", endpoint=_handle_sse),
        Mount("/messages/", app=_sse.handle_post_message),
    ]
)

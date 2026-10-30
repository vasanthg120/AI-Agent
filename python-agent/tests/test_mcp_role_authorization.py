"""Regression tests for MCP role-based tool authorization.

Background: app.mcp_server._call_tool always called execute_tool with
allowed_tools=None (unrestricted), regardless of the connecting user's role.
The live chat path (app.routes.chat) already enforces a real restriction for
'agent_user' accounts — they are forced onto their one assigned persona
(see app.agent.personas.resolve_persona) and that persona's allowedTools —
but MCP had no equivalent at all: any authenticated agent_user connection
over MCP could call ANY tool by name, bypassing whatever allowedTools their
assigned persona was configured with. Hiding tools from _list_tools alone
would not have fixed this (a client can call a tool it was never shown), so
the real fix is in execute_tool's own allowed_tools enforcement.

The fix: app.mcp_server._resolve_allowed_tools() mirrors
backend/src/chat/chat.controller.ts's forced-agentId handling for this exact
role — an agent_user (non-admin) connection is resolved, once per SSE
connection from the JWT's own roles/assignedAgentId/organizationId claims
(never a client-supplied value), to its one persona's allowed_tools, which
is then enforced on every _call_tool call via execute_tool's existing
allowed_tools parameter, and also used to scope what _list_tools advertises
(defense in depth, not the real enforcement boundary).

Plain stdlib unittest — see test_organization_isolation.py for why.
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import mcp_server  # noqa: E402


class ResolveAllowedToolsTests(unittest.TestCase):
    """Pure unit tests of the resolution function itself — no network/Mongo."""

    def test_admin_or_owner_is_always_unrestricted_even_with_agent_user_role(self):
        # An account can carry both roles (e.g. the org creator) — admin must
        # win, matching chat.controller.ts's own `!user.roles.includes('admin')` check.
        for roles in (["admin"], ["owner"], ["agent_user", "admin"]):
            with self.subTest(roles=roles):
                payload = {"roles": roles, "assignedAgentId": "some-slug"}
                self.assertIsNone(mcp_server._resolve_allowed_tools(payload, "org-1"))

    def test_manager_consultant_and_plain_user_are_unrestricted(self):
        # Matches today's live-chat behavior: AgentRole.assignedDepartments/
        # assignedUserIds are @mention visibility only, not a tool-access
        # boundary (see agent-role.schema.ts) — only agent_user is locked.
        for roles in ([], ["user"], ["manager"], ["consultant"]):
            with self.subTest(roles=roles):
                payload = {"roles": roles}
                self.assertIsNone(mcp_server._resolve_allowed_tools(payload, "org-1"))

    def test_locked_agent_user_resolves_its_assigned_personas_allowed_tools(self):
        payload = {"roles": ["agent_user"], "assignedAgentId": "restricted-bot"}
        with patch(
            "app.mcp_server.resolve_persona",
            return_value=_FakePersona(["crm", "crm_deal"]),
        ) as resolve_persona:
            result = mcp_server._resolve_allowed_tools(payload, "org-1")
            resolve_persona.assert_called_once_with("restricted-bot", "org-1")
        self.assertEqual(result, ["crm", "crm_deal"])

    def test_locked_agent_user_with_unrestricted_persona_stays_unrestricted(self):
        # allowedTools=[] on the AgentRole doc means unrestricted (see
        # resolve_persona's own "empty list -> None" convention) — the MCP
        # resolution must pass that through unchanged, not invent a stricter
        # empty-list-means-nothing behavior that doesn't match live chat.
        payload = {"roles": ["agent_user"], "assignedAgentId": "unrestricted-bot"}
        with patch("app.mcp_server.resolve_persona", return_value=_FakePersona(None)):
            result = mcp_server._resolve_allowed_tools(payload, "org-1")
        self.assertIsNone(result)


class _FakePersona:
    def __init__(self, allowed_tools):
        self.allowed_tools = allowed_tools


class McpCallToolEnforcesAllowedToolsTests(unittest.TestCase):
    """End-to-end through the real _call_tool/execute_tool path (no mocking
    of execute_tool itself here) — proves a locked connection is actually
    refused by name, not just by what _list_tools chose to advertise."""

    def _run_as(self, roles: list[str], assigned_agent_id: str | None, org_id: str, tool_name: str, args: dict):
        user_token = mcp_server._current_user_id.set("user-x")
        payload = {"roles": roles, "assignedAgentId": assigned_agent_id}
        org_token = mcp_server._current_org_id.set(org_id)
        tools_token = mcp_server._current_allowed_tools.set(mcp_server._resolve_allowed_tools(payload, org_id))
        try:
            result = asyncio.run(mcp_server._call_tool(tool_name, args))
        finally:
            mcp_server._current_user_id.reset(user_token)
            mcp_server._current_org_id.reset(org_token)
            mcp_server._current_allowed_tools.reset(tools_token)
        return result[0].text

    def test_locked_agent_user_calling_an_out_of_scope_tool_by_name_is_refused(self):
        with patch("app.mcp_server.resolve_persona", return_value=_FakePersona(["crm"])):
            text = self._run_as(["agent_user"], "restricted-bot", "org-1", "crm_deal", {"action": "list"})
        self.assertEqual(text, "Tool 'crm_deal' is not permitted in this context.")

    def test_locked_agent_user_calling_an_in_scope_tool_is_allowed_through_to_the_handler(self):
        # "Allowed through" here means execute_tool's permission gate didn't
        # reject it — it still reaches the real crm tool handler (mocked here
        # to stay fast/offline; its own missing-organization/credentials
        # guard is already covered by test_organization_isolation.py), not
        # rejected on authorization.
        with patch("app.mcp_server.resolve_persona", return_value=_FakePersona(["crm"])), patch(
            "app.integrations.prospectconnect.resolve_credentials", return_value=("", "")
        ):
            text = self._run_as(["agent_user"], "restricted-bot", "org-1", "crm", {"action": "list"})
        self.assertNotEqual(text, "Tool 'crm' is not permitted in this context.")

    def test_unrestricted_role_can_call_any_registered_tool_by_name(self):
        with patch("app.integrations.prospectconnect.resolve_credentials", return_value=("", "")):
            text = self._run_as(["manager"], None, "org-1", "crm_deal", {"action": "list"})
        self.assertNotEqual(text, "Tool 'crm_deal' is not permitted in this context.")


if __name__ == "__main__":
    unittest.main()

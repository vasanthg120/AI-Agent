"""Regression tests for the cross-organization credential-isolation fix.

Background: python-agent's MCP server (app.mcp_server) built every tool's
execution context with no organization_id key at all — only user_id and a
fixed conversation_id. Several CRM tools and the Gorilla Dash client had no
guard against a missing organization_id either, so they fell through to
app.integrations.prospectconnect.resolve_credentials() /
app.integrations.gorilladash.credentials_for(), which (via
app.memory.integration_store's org-unscoped Mongo query when
organization_id is None) could return *some other organization's* stored
CRM/Gorilla Dash credentials — a full tenant-isolation bypass reachable by
any authenticated MCP caller, with no payload manipulation needed.

The fix: mcp_server now captures the SSE connection's JWT `organizationId`
claim into a contextvar and forwards it into every tool's context, exactly
like the live chat path (app.routes.chat) already does; every CRM tool and
the Gorilla Dash client now refuse to proceed at all when organization_id is
missing, matching the guard pattern already used by
integration_execute_tool.py / integration_capabilities_tool.py /
crm_write_tool.py / zapier_tool.py / crm_source_records_tool.py.

Plain stdlib unittest — this project has no pytest dependency installed and
no existing test suite to follow; every case below is checked purely at the
"no organization context" guard, so none needs a real Mongo/Redis/network
connection. Run with:
    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.integrations.gorilladash import GorillaDashClient, GorillaDashError  # noqa: E402
from app.tools import (  # noqa: E402
    crm_account_tool,
    crm_deal_tool,
    crm_note_tool,
    crm_product_tool,
    crm_quote_tool,
    crm_tag_tool,
    crm_tool,
)

# One representative, schema-satisfying tool_input per tool — only enough to
# reach each run()'s organization_id check, which happens before anything
# else that would need a fuller payload.
_CRM_TOOLS = {
    "crm": (crm_tool, {"action": "list"}),
    "crm_deal": (crm_deal_tool, {"action": "list"}),
    "crm_note": (crm_note_tool, {"action": "list"}),
    "crm_account": (crm_account_tool, {"action": "list"}),
    "crm_quote": (crm_quote_tool, {"action": "list"}),
    "crm_tag": (crm_tag_tool, {}),
    "crm_product": (crm_product_tool, {}),
}


class CrmToolOrganizationGuardTests(unittest.TestCase):
    """Every CRM tool must refuse to run with no real organization_id in its
    context, rather than ever reaching prospectconnect.resolve_credentials()
    with organization_id=None."""

    def test_missing_organization_id_is_rejected_without_resolving_credentials(self):
        for label, (module, tool_input) in _CRM_TOOLS.items():
            with self.subTest(tool=label):
                with patch("app.integrations.prospectconnect.resolve_credentials") as resolve:
                    result = module.run(tool_input, {"organization_id": None, "user_id": "some-user"})
                    self.assertEqual(result, "No organization context available.")
                    resolve.assert_not_called()

    def test_empty_string_organization_id_is_also_rejected(self):
        for label, (module, tool_input) in _CRM_TOOLS.items():
            with self.subTest(tool=label):
                with patch("app.integrations.prospectconnect.resolve_credentials") as resolve:
                    result = module.run(tool_input, {"organization_id": "", "user_id": "some-user"})
                    self.assertEqual(result, "No organization context available.")
                    resolve.assert_not_called()

    def test_a_real_organization_id_still_reaches_credential_resolution(self):
        # Guard against over-fixing: a genuine org id must still flow through
        # to resolve_credentials exactly as before, for every org independently.
        for org_id in ("org-alpha-1", "org-beta-2"):
            with patch("app.integrations.prospectconnect.resolve_credentials", return_value=("", "")) as resolve:
                crm_tool.run({"action": "list"}, {"organization_id": org_id, "user_id": "u"})
                resolve.assert_called_once()
                self.assertEqual(resolve.call_args.args[0], org_id)

    def test_two_different_users_in_the_same_org_resolve_the_identical_connection(self):
        # Org-wide sharing's actual proof, not just "distinct orgs never
        # cross" above: an admin's connected credential is reachable by ANY
        # other authenticated user in that same org on their very own tool
        # call — organization_id is the only thing resolve_credentials is
        # ever called with; user_id never factors into which credential is
        # resolved, so a brand-new user needs no connection of their own.
        same_org = "org-shared-1"
        for user_id in ("admin-user", "second-user", "brand-new-user"):
            with patch(
                "app.integrations.prospectconnect.resolve_credentials",
                return_value=("https://shared.example.com", "shared-key"),
            ) as resolve, patch("app.tools.crm_tool.prospectconnect.post", return_value="{}"):
                # search_by_ids resolves credentials exactly once in run()
                # itself (unlike the "list" action, which also separately
                # resolves inside its own _fetch_raw_contacts helper — a
                # different, pre-existing code path, not what this test is
                # about), making the single call's exact arguments unambiguous.
                result = crm_tool.run(
                    {"action": "search_by_ids", "ids": ["1"]}, {"organization_id": same_org, "user_id": user_id}
                )
                resolve.assert_called_once_with(same_org, user_id)
            self.assertNotEqual(result, "No CRM is connected yet. Ask the user to connect one via the Integrations page.")


class GorillaDashClientOrganizationGuardTests(unittest.TestCase):
    def test_missing_organization_id_raises_before_any_credential_lookup(self):
        with patch("app.integrations.gorilladash.credentials_for") as credentials_for:
            with self.assertRaises(GorillaDashError):
                GorillaDashClient(None)
            credentials_for.assert_not_called()

    def test_empty_string_organization_id_also_raises(self):
        with patch("app.integrations.gorilladash.credentials_for") as credentials_for:
            with self.assertRaises(GorillaDashError):
                GorillaDashClient("")
            credentials_for.assert_not_called()

    def test_a_real_organization_id_still_looks_up_its_own_credentials(self):
        for org_id in ("org-alpha-1", "org-beta-2"):
            with patch(
                "app.integrations.gorilladash.credentials_for",
                return_value=("https://api.gorilladash.com", "key", "secret"),
            ) as credentials_for:
                GorillaDashClient(org_id)
                credentials_for.assert_called_once_with(org_id)


class McpContextOrganizationScopingTests(unittest.TestCase):
    """mcp_server._call_tool must forward the *current connection's* real
    organization_id (set once per SSE connection from the JWT's
    organizationId claim, never from a tool-call argument) into every tool's
    context — different connections must never see each other's org id."""

    def _call_with_context(self, user_id: str, org_id: str | None) -> dict:
        from app import mcp_server

        user_token = mcp_server._current_user_id.set(user_id)
        org_token = mcp_server._current_org_id.set(org_id) if org_id is not None else None
        captured: dict = {}

        def fake_execute_tool(name, arguments, context, allowed_tools=None):
            captured.update(context)
            return "ok"

        try:
            with patch("app.mcp_server.execute_tool", side_effect=fake_execute_tool):
                asyncio.run(mcp_server._call_tool("crm", {}))
        finally:
            mcp_server._current_user_id.reset(user_token)
            if org_token is not None:
                mcp_server._current_org_id.reset(org_token)
        return captured

    def test_call_tool_forwards_the_connections_own_org_id(self):
        captured = self._call_with_context("user-123", "org-abc")
        self.assertEqual(captured.get("organization_id"), "org-abc")
        self.assertEqual(captured.get("user_id"), "user-123")

    def test_a_second_connection_never_sees_the_first_connections_org_id(self):
        first = self._call_with_context("user-a", "org-a")
        second = self._call_with_context("user-b", "org-b")
        self.assertEqual(first.get("organization_id"), "org-a")
        self.assertEqual(second.get("organization_id"), "org-b")
        self.assertNotEqual(first.get("organization_id"), second.get("organization_id"))

    def test_call_tool_forwards_none_when_the_token_has_no_org_claim(self):
        # Short-lived internal tokens (sub only, no organizationId) must
        # still flow through as None, not crash and not resolve unscoped —
        # each org-scoped tool's own guard is what makes None safe.
        captured = self._call_with_context("user-456", None)
        self.assertIsNone(captured.get("organization_id"))


if __name__ == "__main__":
    unittest.main()

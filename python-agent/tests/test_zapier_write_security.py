"""Zapier read/write classification and write approval, on every agent path.

The real chat graph, specialist runner, tool registry, result cache and
zapier_mcp.call gate all run; only the model, the Zapier network session,
Redis, tracing and Mongo are faked.

    .venv/Scripts/python.exe -m pytest tests/test_zapier_write_security.py
"""

import contextlib
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent import orchestrator  # noqa: E402
from app.agent.graph import get_graph  # noqa: E402
from app.agent.specialists import SPECIALISTS  # noqa: E402
from app.integrations import zapier_mcp  # noqa: E402
from app.memory import working_memory, zapier_approvals  # noqa: E402
from app.tools import integration_capabilities_tool, registry, zapier_tool  # noqa: E402

READS = [
    ("hoops_find_customer", "Hoops: Find Customer"),
    ("hubspot_search_contacts", "HubSpot: Search Contacts"),
    ("gmail_find_email", "Gmail: Find Email"),
    ("google_sheets_lookup_spreadsheet_row", "Google Sheets: Lookup Spreadsheet Row"),
    ("google_sheets_look_up_row", "Google Sheets: Look Up Row"),
    ("gorilla_dash_get_enquiry", "Gorilla Dash: Get Enquiry"),
    ("salesforce_find_record", "Salesforce: Find Record"),
    ("jira_get_issue_comment", "Jira: Get Issue Comment"),
    ("mailchimp_find_mailing_list", "Mailchimp: Find Mailing List"),
    ("slack_list_channels", "Slack: List Channels"),
    ("xero_retrieve_invoice", "Xero: Retrieve Invoice"),
    ("drive_fetch_file", None),
    ("follow_up_boss_find_person", "Follow Up Boss: Find Person"),
    ("googleCalendarFindEvent", "Google Calendar: Find Event"),
]

WRITES = [
    # The reported bug and its relatives: a read word somewhere in a write.
    ("hubspot_find_or_create_contact", "HubSpot: Find or Create Contact"),
    ("salesforce_find_or_update_record", "Salesforce: Find or Update Record"),
    ("get_and_delete_item", None),
    ("crm_search_then_book", None),
    ("mailchimp_create_list", "Mailchimp: Create List"),
    ("mailchimp_add_subscriber_to_list", "Mailchimp: Add Subscriber to List"),
    ("todo_update_list", None),
    ("gmail_send_search_results", None),
    ("hoops_book_list", None),
    ("slack_mark_as_read", "Slack: Mark as Read"),
    ("hubspot_set_lookup_property", None),
    ("sheets_copy_found_row", None),
    ("hoops_find_contact", "Hoops: Find or Create Contact"),  # only the title says so
    ("stripe_api_get_request", "Stripe: API Request (Beta)"),
    ("gmail_make_api_call", None),
    ("app_raw_get_request", None),
    # Plain writes.
    ("hoops_create_customer", "Hoops: Create Customer"),
    ("gorilla_dash_update_enquiry", None),
    ("gmail_send_email", "Gmail: Send Email"),
    ("drive_delete_file", None),
    ("gmail_create_draft", "Gmail: Create Draft"),
    # Not recognised at all.
    ("hoops_do_the_thing", "Hoops: Do The Thing"),
    ("hoops_preview_invoice", "Hoops: Preview Invoice"),
    ("", None),
]

READ = "hoops_find_customer"
WRITE = "hubspot_find_or_create_contact"
ARGS = {"email": "a@example.com"}


class ClassificationTests(unittest.TestCase):
    def test_genuine_reads(self):
        for name, title in READS:
            with self.subTest(name=name):
                self.assertEqual(zapier_mcp.kind_of(name, {}, title), "read")

    def test_writes_and_unrecognised_actions_are_writes(self):
        for name, title in WRITES:
            with self.subTest(name=name):
                self.assertEqual(zapier_mcp.kind_of(name, {}, title), "write")

    def test_zapier_hints(self):
        kind = zapier_mcp.kind_of
        self.assertEqual(kind("hoops_customer_report", {"readOnlyHint": True}), "read")
        # The hint never overrides a name that says it changes data.
        self.assertEqual(kind("hubspot_find_or_create_contact", {"readOnlyHint": True}), "write")
        self.assertEqual(kind("hoops_run_report", {"readOnlyHint": True}), "write")
        self.assertEqual(kind("hoops_find_customer", {"readOnlyHint": False}), "write")
        self.assertEqual(kind("hoops_find_customer", {"destructiveHint": True}), "write")

    def test_a_cached_read_label_is_ignored(self):
        self.assertEqual(zapier_mcp.action_kind({"name": WRITE, "kind": "read", "title": "x"}), "write")

    def test_discovery_stores_the_corrected_kind_and_the_hints(self):
        listed = SimpleNamespace(tools=[
            SimpleNamespace(name=WRITE, title="HubSpot: Find or Create Contact", description="", inputSchema={},
                            annotations=None),
            SimpleNamespace(name="hoops_report", title="Hoops: Report", description="", inputSchema={},
                            annotations=SimpleNamespace(model_dump=lambda **_: {"readOnlyHint": True, "x": 1})),
        ])

        async def session(token, fn):
            return listed

        saved = []
        db = SimpleNamespace(zapier_catalogs=SimpleNamespace(update_one=lambda *a, **k: saved.append(a[1]["$set"])))
        with patch.object(zapier_mcp, "connection_token", return_value="t"), patch.object(
            zapier_mcp, "get_db", return_value=db
        ), patch.object(zapier_mcp, "_with_session", session):
            catalog = zapier_mcp.discover("org-1")
        self.assertEqual([t["kind"] for t in catalog["tools"]], ["write", "read"])
        self.assertEqual(catalog["tools"][1]["annotations"], {"readOnlyHint": True})
        # Re-classified from what was stored, the answer is the same.
        self.assertEqual([zapier_mcp.action_kind(t) for t in saved[0]["tools"]], ["write", "read"])


class FakeCollection:
    def __init__(self):
        self.docs = {}

    @staticmethod
    def _matches(doc, query):
        for key, expected in query.items():
            value = doc.get(key)
            if not isinstance(expected, dict):
                if value != expected:
                    return False
            elif "$ne" in expected and value == expected["$ne"]:
                return False
            elif "$gt" in expected and not value > expected["$gt"]:
                return False
            elif "$lte" in expected and not value <= expected["$lte"]:
                return False
        return True

    def delete_many(self, query):
        for key in [k for k, d in self.docs.items() if self._matches(d, query)]:
            del self.docs[key]

    def update_one(self, query, update, upsert=False):
        self.docs.setdefault(query["_id"], {"_id": query["_id"], **update["$setOnInsert"]})

    def find_one_and_delete(self, query):
        found = next(iter(self.find(query)), None)
        return self.docs.pop(found["_id"]) if found else None

    def find(self, query):
        return [d for d in list(self.docs.values()) if self._matches(d, query)]


def _catalog_entry(name, title):
    # "kind" is deliberately "read" for everything: a stale, wrong cache.
    return {"name": name, "title": title, "app": "Hoops", "kind": "read", "inputSchema": {"type": "object"}}


class _Env(unittest.TestCase):
    CATALOGS = {
        "org-1": [_catalog_entry(READ, "Hoops: Find Customer"), _catalog_entry(WRITE, "Hoops: Find or Create Contact")],
        "org-2": [_catalog_entry(WRITE, "Hoops: Find or Create Contact")],
    }

    def setUp(self):
        self.sent = []  # (tool, arguments) that really reached Zapier
        self.audit = []
        self.cache = {}
        self.approvals = FakeCollection()
        env = self

        class Session:
            async def call_tool(self, name, arguments):
                env.sent.append((name, arguments))
                return SimpleNamespace(content=[SimpleNamespace(type="text", text="EXECUTED")], isError=False)

        async def with_session(token, fn):
            return await fn(Session())

        @contextlib.contextmanager
        def traced(name, **fields):
            outcome = {}
            yield outcome
            env.audit.append({"tool": name, **fields, **outcome})

        def catalog_for(organization_id):
            tools = env.CATALOGS.get(organization_id)
            return {"tools": tools, "mode": "managed"} if tools else None

        for target, name, value in (
            (zapier_mcp, "_with_session", with_session),
            (zapier_mcp, "catalog_for", catalog_for),
            (zapier_mcp, "connection_token", lambda organization_id: "token"),
            (zapier_approvals, "_collection", lambda: env.approvals),
            (registry, "traced_tool_call", traced),
            (registry, "rate_limit_allow", lambda *a: True),
            (working_memory, "get_json", env.cache.get),
            (working_memory, "set_json", lambda key, value, ttl: env.cache.__setitem__(key, value)),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def context(self, request_id="r1", **overrides):
        return {"organization_id": "org-1", "user_id": "u1", "conversation_id": "c1", "request_id": request_id,
                **overrides}

    def zapier(self, context, tool_name=WRITE, arguments=ARGS, confirmed=None, allowed_tools=None):
        tool_input = {"action": "run", "tool_name": tool_name, "arguments": arguments}
        if confirmed is not None:
            tool_input["confirmed"] = confirmed
        return working_memory.cached_execute_tool("zapier", tool_input, context, allowed_tools=allowed_tools)


class ApprovalTests(_Env):
    def test_preview_then_a_later_turn_runs_the_write_once(self):
        self.assertIn("PREVIEW", self.zapier(self.context("r1")))
        self.assertEqual(self.sent, [])
        self.assertIn("EXECUTED", self.zapier(self.context("r2"), confirmed=True))
        self.assertEqual(self.sent, [(WRITE, ARGS)])
        self.assertIn("Not approved", self.zapier(self.context("r2"), confirmed=True))
        self.assertEqual(len(self.sent), 1)

    def test_confirmed_with_no_preview_does_not_run(self):
        self.assertIn("Not approved", self.zapier(self.context(), confirmed=True))
        self.assertEqual(self.sent, [])

    def test_preview_and_confirm_in_the_same_turn_does_not_run(self):
        self.zapier(self.context("r1"))
        self.assertIn("Not approved", self.zapier(self.context("r1"), confirmed=True))
        self.assertIn("Not approved", self.zapier(self.context("r1"), confirmed=True))
        self.assertEqual(self.sent, [])

    def test_repeating_a_preview_keeps_the_users_approval(self):
        self.zapier(self.context("r1"))
        self.zapier(self.context("r2"))
        self.assertIn("EXECUTED", self.zapier(self.context("r2"), confirmed=True))

    def test_changed_inputs_need_their_own_approval(self):
        self.zapier(self.context("r1"))
        changed = {"email": "attacker@example.com"}
        out = self.zapier(self.context("r2"), arguments=changed, confirmed=True)
        self.assertIn("Not approved", out)
        self.assertIn(json.dumps([ARGS]), out)  # tells the model what was approved
        self.assertNotIn(json.dumps([ARGS, changed]), out)
        self.assertEqual(self.sent, [])

    def test_an_approval_is_bound_to_organization_user_and_conversation(self):
        self.zapier(self.context("r1"))
        for override in ({"organization_id": "org-2"}, {"user_id": "u2"}, {"conversation_id": "c2"}):
            with self.subTest(override=override):
                out = self.zapier(self.context("r2", **override), confirmed=True)
                self.assertIn("Not approved", out)
                self.assertNotIn("earlier message", out)
        self.assertEqual(self.sent, [])

    def test_an_expired_approval_does_not_run(self):
        self.zapier(self.context("r1"))
        for doc in self.approvals.docs.values():
            doc["expiresAt"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.assertIn("Not approved", self.zapier(self.context("r2"), confirmed=True))
        self.assertEqual(self.sent, [])

    def test_a_caller_with_no_turn_identity_cannot_write(self):
        """e.g. an MCP client, which has no request_id."""
        mcp = {"organization_id": "org-1", "user_id": "u1", "conversation_id": "mcp"}
        self.zapier(mcp)
        self.assertIn("Not approved", self.zapier(mcp, confirmed=True))
        self.assertEqual(self.sent, [])
        self.assertIn("EXECUTED", self.zapier(mcp, tool_name=READ))

    def test_if_approvals_cannot_be_stored_the_write_does_not_run(self):
        with patch.object(zapier_approvals, "_collection", side_effect=RuntimeError("mongo down")):
            self.assertIn("failed", self.zapier(self.context("r2"), confirmed=True))
        self.assertEqual(self.sent, [])

    def test_the_execution_layer_refuses_an_unapproved_write_by_itself(self):
        with self.assertRaises(zapier_mcp.ZapierError):
            zapier_mcp.call("org-1", WRITE, ARGS)
        self.assertEqual(self.sent, [])
        self.assertEqual(zapier_mcp.call("org-1", READ, ARGS), "EXECUTED")

    def test_unknown_and_meta_actions_never_run_even_if_approved(self):
        meta = "execute_zapier_read_action"
        with patch.dict(self.CATALOGS, {"org-1": [_catalog_entry(meta, "Run")]}):
            for name in (meta, "hoops_not_enabled"):
                with self.subTest(name=name), self.assertRaises(zapier_mcp.ZapierError):
                    zapier_mcp.call("org-1", name, {}, approved=True)
        self.assertIn("isn't an enabled", self.zapier(self.context(), tool_name="hoops_not_enabled", confirmed=True))
        self.assertEqual(self.sent, [])

    def test_another_organizations_action_is_not_reachable(self):
        out = self.zapier(self.context(organization_id="org-2"), tool_name=READ)
        self.assertIn("isn't an enabled", out)
        self.assertEqual(self.sent, [])

    def test_listings_show_the_corrected_kind_despite_the_stale_cache(self):
        listing = zapier_tool.run({"action": "actions"}, self.context())
        self.assertIn(f"[write] {WRITE}", listing)
        self.assertIn(f"[read] {READ}", listing)
        self.assertIn("1 read, 1 write", listing)
        overview = "\n".join(integration_capabilities_tool._connected_overview("org-1"))
        self.assertIn("write actions: Hoops: Find or Create Contact", overview)

    def test_every_attempt_is_still_audited(self):
        self.zapier(self.context("r1"))
        self.zapier(self.context("r2"), confirmed=True)
        self.assertEqual([(a["tool"], a["organization_id"], a["success"]) for a in self.audit],
                         [("zapier", "org-1", True)] * 2)


class CacheTests(_Env):
    def test_zapier_results_are_never_cached(self):
        for _ in range(2):
            self.zapier(self.context(), tool_name=READ)
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(self.cache, {})

    def test_a_cached_entry_cannot_answer_a_zapier_call(self):
        with patch.object(working_memory, "get_json", return_value="CACHED"):
            self.assertIn("PREVIEW", self.zapier(self.context()))
            self.assertIn("Not approved", self.zapier(self.context(), confirmed=True))
            self.assertIn("not permitted", self.zapier(self.context(), allowed_tools=["crm_deal"]))
        self.assertEqual(self.sent, [])

    def test_a_cached_entry_cannot_bypass_a_tool_scope(self):
        with patch.object(working_memory, "get_json", return_value="CACHED"):
            out = working_memory.cached_execute_tool("web_search", {"query": "x"}, self.context(), allowed_tools=[])
        self.assertIn("not permitted", out)


class _AgentPath(_Env):
    def model(self, *calls):
        """A fake model that requests each tool call in turn, then answers."""
        queue = list(calls)
        self.outputs = []

        def call_llm(messages, **kwargs):
            self.outputs = [m["output"] for m in messages if m.get("type") == "function_call_output"]
            if queue:
                return [{"type": "function_call", "call_id": f"id{len(queue)}", "name": "zapier",
                         "arguments": json.dumps({"action": "run", "arguments": ARGS, **queue.pop(0)})}], "anthropic"
            return [{"type": "message", "role": "assistant",
                     "content": [{"type": "output_text", "text": "done"}]}], "anthropic"

        return patch("app.agent.graph.call_llm", side_effect=call_llm)


class NormalChatTests(_AgentPath):
    def turn(self, request_id, *calls, **state):
        with self.model(*calls), patch("app.agent.graph.choose_provider", return_value="anthropic"), patch(
            "app.agent.graph.choose_model", return_value="m"
        ):
            get_graph().invoke({
                "messages": [{"role": "user", "content": "go"}], "pending_calls": [], "tools_used": [], "rounds": 0,
                "provider": "", "user_id": "u1", "organization_id": "org-1", "conversation_id": "c1",
                "request_id": request_id, **state,
            })
        return self.outputs

    def test_reads_run_straight_away(self):
        self.assertIn("EXECUTED", self.turn("r1", {"tool_name": READ})[0])
        self.assertEqual(self.sent, [(READ, ARGS)])

    def test_a_write_cannot_be_self_approved_within_one_turn(self):
        outputs = self.turn("r1", {"tool_name": WRITE}, {"tool_name": WRITE, "confirmed": True})
        self.assertIn("PREVIEW", outputs[0])
        self.assertIn("Not approved", outputs[1])
        self.assertEqual(self.sent, [])

    def test_a_write_runs_after_the_users_next_message(self):
        self.turn("r1", {"tool_name": WRITE})
        self.assertIn("EXECUTED", self.turn("r2", {"tool_name": WRITE, "confirmed": True})[0])
        self.assertEqual(self.sent, [(WRITE, ARGS)])

    def test_a_custom_agent_scoped_to_zapier_follows_the_same_rules(self):
        outputs = self.turn("r1", {"tool_name": READ}, {"tool_name": WRITE, "confirmed": True},
                            allowed_tools=["zapier"])
        self.assertIn("EXECUTED", outputs[0])
        self.assertIn("Not approved", outputs[1])
        self.assertEqual(self.sent, [(READ, ARGS)])


class FixedSpecialistTests(_AgentPath):
    def specialist(self, request_id, *calls, key="crm"):
        with self.model(*calls), patch("app.agent.graph.choose_provider", return_value="anthropic"), patch(
            "app.agent.graph.choose_model", return_value="m"
        ):
            orchestrator._run_specialist(
                key, "task", [{"role": "user", "content": "go"}], "u1", "org-1", "c1", None, request_id
            )
        return self.outputs

    def test_no_built_in_specialist_can_reach_zapier_at_all(self):
        for key, spec in SPECIALISTS.items():
            with self.subTest(specialist=key):
                self.assertNotIn("zapier", spec["tools"])
                outputs = self.specialist(
                    "r1", {"tool_name": READ}, {"tool_name": WRITE, "confirmed": True}, key=key
                )
                self.assertEqual(outputs, ["Tool 'zapier' is not permitted in this context."] * 2)
        self.assertEqual(self.sent, [])

    # The next two give a specialist the zapier tool, to prove the rules would
    # still hold on this path if one were ever granted it.
    def _granted(self):
        return patch.dict(SPECIALISTS, {"crm": {**SPECIALISTS["crm"], "tools": ["zapier"]}})

    def test_a_specialist_granted_zapier_can_read(self):
        with self._granted():
            self.assertIn("EXECUTED", self.specialist("r1", {"tool_name": READ})[0])

    def test_a_specialist_granted_zapier_needs_approval_to_write(self):
        with self._granted():
            outputs = self.specialist("r1", {"tool_name": WRITE}, {"tool_name": WRITE, "confirmed": True})
            self.assertIn("Not approved", outputs[1])
            self.assertEqual(self.sent, [])
            self.assertIn("EXECUTED", self.specialist("r2", {"tool_name": WRITE, "confirmed": True})[0])


class DynamicAgentTests(_Env):
    def dynamic(self, request_id="r1"):
        return self.context(request_id, agent_instance_id="dyn-1", parent_agent_id=None, delegation_depth=1)

    def test_every_action_is_only_previewed(self):
        for name in (READ, WRITE):
            for confirmed in (None, True):
                with self.subTest(name=name, confirmed=confirmed):
                    self.assertIn("PREVIEW", self.zapier(self.dynamic(), tool_name=name, confirmed=confirmed))
        self.assertEqual(self.sent, [])

    def test_the_handler_previews_even_without_the_policy_layer(self):
        out = zapier_tool.run(
            {"action": "run", "tool_name": WRITE, "arguments": ARGS, "confirmed": True}, self.dynamic()
        )
        self.assertIn("PREVIEW", out)
        self.assertEqual(self.sent, [])

    def test_a_dynamic_preview_cannot_approve_a_later_write(self):
        self.zapier(self.dynamic("r1"))
        self.assertEqual(self.approvals.docs, {})
        self.assertIn("Not approved", self.zapier(self.context("r2"), confirmed=True))
        self.assertEqual(self.sent, [])

    def test_a_dynamic_agent_cannot_use_a_users_pending_approval(self):
        self.zapier(self.context("r1"))
        self.assertIn("PREVIEW", self.zapier(self.dynamic("r2"), confirmed=True))
        self.assertEqual(self.sent, [])


if __name__ == "__main__":
    unittest.main()

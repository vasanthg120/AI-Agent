"""Tests for Phase 4's delegation-tree persistence: agentInstanceId/
parentAgentId/delegationDepth on the existing agent_executions collection
(see the plan's "Dynamic Recursive Multi-Agent System" section) — lets the
NestJS Command Center reconstruct a request's full dynamic-agent tree from
its requestId-grouped rows later, without inventing a second collection.

Uses the same FakeDb/FakeAgentExecutions pattern as
test_tracing_langfuse_sink.py to check the REAL Mongo doc shape
traced_llm_call/traced_tool_call produce, end to end through
execution_store — not just that a parameter was threaded somewhere.

Plain stdlib unittest, matching this project's existing convention. Run with:
    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.observability.tracing as tracing  # noqa: E402
from app.agent.dynamic import master_agent  # noqa: E402


class FakeAgentExecutions:
    def __init__(self):
        self.inserted = []

    def insert_one(self, doc):
        self.inserted.append(doc)


class FakeDb:
    def __init__(self):
        self.agent_executions = FakeAgentExecutions()


def _fake_graph_result(text: str):
    return {"messages": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}]}


class TracedLlmCallDelegationFieldsTests(unittest.TestCase):
    def test_delegation_identity_is_persisted_onto_the_agent_executions_row(self):
        fake_db = FakeDb()
        with patch("app.observability.execution_store.get_db", return_value=fake_db):
            with tracing.traced_llm_call(
                "test", provider="anthropic", model="claude-x",
                agent_instance_id="dyn-abc", parent_agent_id="dyn-parent", delegation_depth=1,
            ) as usage:
                usage["input_tokens"] = 10
                usage["output_tokens"] = 5

        row = fake_db.agent_executions.inserted[0]
        self.assertEqual(row["agentInstanceId"], "dyn-abc")
        self.assertEqual(row["parentAgentId"], "dyn-parent")
        self.assertEqual(row["delegationDepth"], 1)

    def test_every_non_dynamic_caller_still_gets_none_never_a_fabricated_value(self):
        fake_db = FakeDb()
        with patch("app.observability.execution_store.get_db", return_value=fake_db):
            with tracing.traced_llm_call("test", provider="anthropic", model="claude-x") as usage:
                usage["input_tokens"] = 1
                usage["output_tokens"] = 1

        row = fake_db.agent_executions.inserted[0]
        self.assertIsNone(row["agentInstanceId"])
        self.assertIsNone(row["parentAgentId"])
        self.assertIsNone(row["delegationDepth"])

    def test_depth_zero_is_persisted_honestly_not_treated_as_falsy_missing(self):
        # depth=0 (the root dynamic agent) must round-trip as 0, not be
        # confused with "no delegation_depth at all" (None) — a naive
        # `if delegation_depth:` check anywhere in this chain would silently
        # drop a real, meaningful 0.
        fake_db = FakeDb()
        with patch("app.observability.execution_store.get_db", return_value=fake_db):
            with tracing.traced_llm_call(
                "test", provider="anthropic", model="claude-x", agent_instance_id="dyn-root", delegation_depth=0,
            ) as usage:
                usage["input_tokens"] = 1
                usage["output_tokens"] = 1

        row = fake_db.agent_executions.inserted[0]
        self.assertEqual(row["delegationDepth"], 0)


class TracedToolCallDelegationFieldsTests(unittest.TestCase):
    def test_delegation_identity_is_persisted_onto_the_tool_agent_executions_row(self):
        fake_db = FakeDb()
        with patch("app.observability.execution_store.get_db", return_value=fake_db):
            with tracing.traced_tool_call(
                "crm_deal", "user-1", agent_instance_id="dyn-abc", parent_agent_id="dyn-parent", delegation_depth=2,
            ) as outcome:
                outcome["success"] = True

        row = fake_db.agent_executions.inserted[0]
        self.assertEqual(row["agentInstanceId"], "dyn-abc")
        self.assertEqual(row["parentAgentId"], "dyn-parent")
        self.assertEqual(row["delegationDepth"], 2)

    def test_every_non_dynamic_tool_call_still_gets_none(self):
        fake_db = FakeDb()
        with patch("app.observability.execution_store.get_db", return_value=fake_db):
            with tracing.traced_tool_call("crm_deal", "user-1") as outcome:
                outcome["success"] = True

        row = fake_db.agent_executions.inserted[0]
        self.assertIsNone(row["agentInstanceId"])
        self.assertIsNone(row["parentAgentId"])
        self.assertIsNone(row["delegationDepth"])


class MasterAgentThreadsDelegationIdentityTests(unittest.TestCase):
    """Confirms master_agent._execute_leaf actually sets these three fields
    on the state it hands to get_graph().invoke() — the other end of the
    chain from the traced_* tests above."""

    def test_a_leafs_own_identity_flows_into_the_graph_state(self):
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        state_passed = get_graph.return_value.invoke.call_args[0][0]
        agent = result["agents"][0]
        self.assertEqual(state_passed["agent_instance_id"], agent.id)
        self.assertIsNone(state_passed["parent_agent_id"])  # the root has no parent
        self.assertEqual(state_passed["delegation_depth"], 0)

    def test_a_sub_agents_parent_id_and_depth_flow_into_its_own_graph_state(self):
        top_plan = {"decompose": True, "direct_tools": [], "sub_agents": [{"name": "child", "task_description": "x", "tools": []}]}
        leaf_plan = {"decompose": False, "direct_tools": [], "sub_agents": []}

        def fake_plan(task_description, **kwargs):
            return top_plan if task_description == "top" else leaf_plan

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", side_effect=fake_plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            result = master_agent.run_task(
                "top", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        state_passed = get_graph.return_value.invoke.call_args[0][0]
        child = result["agents"][0]
        self.assertEqual(child.name, "child")
        self.assertEqual(state_passed["agent_instance_id"], child.id)
        self.assertEqual(state_passed["delegation_depth"], 1)
        # parent_id was set when the child DynamicAgent was created by the
        # root's own decomposition — not a guess reconstructed afterward.
        self.assertIsNotNone(state_passed["parent_agent_id"])
        self.assertEqual(state_passed["parent_agent_id"], child.parent_id)


if __name__ == "__main__":
    unittest.main()

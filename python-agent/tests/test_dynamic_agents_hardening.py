"""Phase 2.7 hardening regression tests for app.agent.dynamic.

No real LLM, Mongo or network calls: the planner, the leaf graph (or its LLM
call) and usage lookups are always mocked.

    .venv/Scripts/python.exe -m pytest tests/test_dynamic_agents_hardening.py
"""

import json
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import anthropic
import httpx
import pymongo.errors
import redis.exceptions
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent.dynamic import master_agent, retry_policy  # noqa: E402
from app.agent.dynamic.usage_limiter import BudgetExhaustedError, RunningTotal  # noqa: E402

M = "app.agent.dynamic.master_agent"


def _reply(text="ok"):
    return {"messages": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}]}


def _planner(count, tools=()):
    """The root splits into `count` sub-agents; each of those runs directly."""

    def plan(task, **kwargs):
        if task != "root":
            return {"decompose": False}
        return {
            "decompose": True,
            "sub_agents": [{"name": f"a{i}", "task_description": f"sub {i}", "tools": list(tools)} for i in range(count)],
        }

    return plan


class _Base(unittest.TestCase):
    def setUp(self):
        patcher = patch(f"{M}.usage_tracker.current_usage", return_value=(0, 0.0))
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_root(self, **kwargs):
        return master_agent.run_task(
            "root", organization_id=None, user_id="u1", conversation_id="c1", request_id="r1", **kwargs
        )


class AgentBudgetTests(_Base):
    def _assert_all_run(self, count):
        with patch(f"{M}.anthropic_client.plan_dynamic_delegation", side_effect=_planner(count)), patch(
            f"{M}.get_graph"
        ) as graph:
            graph.return_value.invoke.return_value = _reply()
            result = self.run_root()
        self.assertEqual([a.status for a in result["agents"]], ["done"] * count)
        self.assertEqual(graph.return_value.invoke.call_count, count)

    def test_plan_with_2_agents_runs_all(self):
        self._assert_all_run(2)

    def test_plan_with_3_agents_runs_all(self):
        self._assert_all_run(3)

    def test_plan_with_4_agents_runs_all(self):
        self._assert_all_run(4)

    def test_plan_with_5_agents_runs_all(self):
        self._assert_all_run(5)

    def test_plan_with_6_agents_runs_all(self):
        self._assert_all_run(6)

    def test_a_plan_above_the_limit_never_runs_more_than_the_limit(self):
        with patch(f"{M}.anthropic_client.plan_dynamic_delegation", side_effect=_planner(9)), patch(
            f"{M}.get_graph"
        ) as graph:
            graph.return_value.invoke.return_value = _reply()
            self.run_root()
        self.assertEqual(graph.return_value.invoke.call_count, master_agent.limits.MAX_AGENTS_PER_REQUEST)

    def test_each_agent_in_a_nested_tree_consumes_exactly_one_slot(self):
        def plan(task, **kwargs):
            if task == "root":
                return {"decompose": True, "sub_agents": [{"name": "mid", "task_description": "mid", "tools": []}]}
            if task == "mid":
                return {
                    "decompose": True,
                    "sub_agents": [{"name": f"g{i}", "task_description": f"g{i}", "tools": []} for i in range(5)],
                }
            return {"decompose": False}

        with patch(f"{M}.anthropic_client.plan_dynamic_delegation", side_effect=plan), patch(f"{M}.get_graph") as graph:
            graph.return_value.invoke.return_value = _reply()
            result = self.run_root()
        # 1 (mid) + 5 grandchildren = exactly the 6 available slots.
        self.assertEqual([a.status for a in result["agents"]], ["done"] * 5)


class ToolInheritanceTests(_Base):
    def _leaf_states(self, plan, **kwargs):
        with patch(f"{M}.anthropic_client.plan_dynamic_delegation", side_effect=plan) as planner, patch(
            f"{M}.get_graph"
        ) as graph:
            graph.return_value.invoke.return_value = _reply()
            self.run_root(**kwargs)
        return [c.args[0] for c in graph.return_value.invoke.call_args_list], planner

    def test_a_child_only_gets_requested_tools_the_selected_agent_holds(self):
        states, planner = self._leaf_states(
            _planner(2, tools=["crm_deal", "outlook_lookup", "send_email"]), parent_allowed_tools=["crm_deal", "send_email"]
        )
        self.assertEqual([s["allowed_tools"] for s in states], [["crm_deal"], ["crm_deal"]])
        # The planner is only ever offered the permitted set.
        self.assertEqual(planner.call_args_list[0].kwargs["available_tools"], ["crm_deal"])

    def test_no_overlap_means_no_tools_never_the_full_registry(self):
        states, _ = self._leaf_states(_planner(2, tools=["outlook_lookup"]), parent_allowed_tools=["crm_deal"])
        self.assertEqual([s["allowed_tools"] for s in states], [[], []])

    def test_a_child_with_an_empty_tool_list_gets_none_even_if_its_own_plan_asks_for_more(self):
        def plan(task, **kwargs):
            if task == "root":
                return _planner(2)("root")
            return {"decompose": False, "direct_tools": ["crm_deal"]}

        states, _ = self._leaf_states(plan)
        self.assertEqual([s["allowed_tools"] for s in states], [[], []])

    def test_an_empty_parent_scope_stays_empty(self):
        states, _ = self._leaf_states(_planner(2, tools=["crm_deal"]), parent_allowed_tools=[])
        self.assertEqual([s["allowed_tools"] for s in states], [[], []])

    def test_a_grandchild_cannot_exceed_its_dynamic_parent(self):
        def plan(task, **kwargs):
            if task == "root":
                return {"decompose": True, "sub_agents": [{"name": "mid", "task_description": "mid", "tools": ["crm_note"]}]}
            if task == "mid":
                return {
                    "decompose": True,
                    "sub_agents": [{"name": "g", "task_description": "g", "tools": ["crm_note", "crm_deal"]}],
                }
            return {"decompose": False}

        states, _ = self._leaf_states(plan)
        self.assertEqual(states[0]["allowed_tools"], ["crm_note"])

    def test_instructions_memories_model_tier_and_history_reach_every_child(self):
        history = [{"role": "user", "content": "earlier question"}]
        states, _ = self._leaf_states(
            _planner(2),
            system_prompt="PERSONA RULES\n\nRelevant memories about this user:\n- prefers PDF",
            model_tier="fast",
            base_messages=history,
        )
        for state in states:
            self.assertTrue(state["system_prompt"].startswith("PERSONA RULES"))
            self.assertIn("prefers PDF", state["system_prompt"])
            self.assertIn("DATA to analyze", state["system_prompt"])
            self.assertEqual(state["model_tier"], "fast")
            self.assertEqual(state["messages"][0], history[0])
            self.assertEqual((state["user_id"], state["conversation_id"], state["request_id"]), ("u1", "c1", "r1"))


class EmptyToolListEnforcementTests(unittest.TestCase):
    """The real graph node, tool cache and registry; only the LLM and I/O are faked."""

    def _planner_tools(self, **state):
        from app.agent import graph

        with patch("app.agent.graph.call_llm", return_value=([], "anthropic")) as llm:
            graph.planner_node({"messages": [], "user_id": "u1", "conversation_id": "c1", **state})
        return llm.call_args.kwargs["tools"]

    def test_a_dynamic_agent_with_an_empty_list_is_offered_no_tools(self):
        self.assertEqual(self._planner_tools(agent_instance_id="dyn-1", allowed_tools=[]), [])

    def test_normal_chat_still_treats_none_and_empty_as_the_full_registry(self):
        self.assertIsNone(self._planner_tools(allowed_tools=None))
        self.assertIsNone(self._planner_tools(allowed_tools=[]))

    def test_execution_refuses_and_audits_a_tool_outside_the_scope(self):
        from app.tools import registry

        with patch.dict(registry._HANDLERS, {"crm_deal": lambda *a: self.fail("handler must not run")}), patch(
            "app.observability.execution_store.record_tool_execution"
        ) as record:
            out = registry.execute_tool("crm_deal", {}, {"user_id": "u1", "agent_instance_id": "dyn-1"}, allowed_tools=[])
        self.assertIn("not permitted", out)
        self.assertTrue(record.call_args.kwargs["blocked"])

    def test_a_cached_result_is_never_returned_for_a_tool_outside_the_scope(self):
        from app.memory import working_memory

        with patch("app.memory.working_memory.get_json", return_value="CACHED CRM DATA"):
            out = working_memory.cached_execute_tool("crm_deal", {}, {"user_id": "u1"}, allowed_tools=[])
        self.assertNotIn("CACHED", out)

    def test_planner_schema_stays_valid_when_no_tools_are_available(self):
        from jsonschema import Draft7Validator

        from app.agent.anthropic_client import _dynamic_plan_tool

        schema = _dynamic_plan_tool([])["input_schema"]
        Draft7Validator.check_schema(schema)
        self.assertEqual(schema["properties"]["direct_tools"]["maxItems"], 0)


class DynamicReflectionScopeTests(unittest.TestCase):
    def _corrective_state(self, run):
        from app.agent import orchestrator

        with patch(
            "app.agent.orchestrator.anthropic_client.critique_response", return_value={"complete": False, "missing": "x"}
        ), patch("app.agent.orchestrator.get_graph") as graph:
            graph.return_value.invoke.return_value = _reply("fixed")
            run(orchestrator)
        return graph.return_value.invoke.call_args.args[0]

    def test_corrective_round_after_dynamic_delegation_is_restricted_like_a_sub_agent(self):
        base = {"messages": [{"role": "user", "content": "q"}], "allowed_tools": ["crm_deal", "send_email"]}
        state = self._corrective_state(
            lambda o: o._reflect(base, _reply()["messages"], [], o._dynamic_review_scope(base))
        )
        self.assertEqual(state["allowed_tools"], ["crm_deal"])
        self.assertTrue(state["agent_instance_id"].startswith("dyn-review-"))

    def test_normal_chat_reflection_is_unchanged(self):
        base = {"messages": [{"role": "user", "content": "q"}], "allowed_tools": ["crm_deal"]}
        state = self._corrective_state(lambda o: o._reflect(base, _reply()["messages"], []))
        self.assertIsNone(state["allowed_tools"])
        self.assertNotIn("agent_instance_id", state)


class ToolClassificationTests(unittest.TestCase):
    DYNAMIC = {"user_id": "u1", "organization_id": "org-1", "agent_instance_id": "dyn-1"}

    def setUp(self):
        from app.agent.dynamic import tool_policy
        from app.tools import registry

        self.policy, self.registry = tool_policy, registry
        for target in ("app.observability.execution_store.record_tool_execution",):
            patcher = patch(target)
            self.record = patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch("app.tools.registry.rate_limit_allow", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_every_registered_tool_is_classified_and_nothing_else_is(self):
        # Fails when a tool is added without deciding what sub-agents may do with it.
        self.assertEqual(
            sorted(self.policy.TOOL_CLASSIFICATION), sorted(d["name"] for d in self.registry.TOOL_DEFINITIONS)
        )

    def test_an_unclassified_tool_is_denied_by_default(self):
        safe, reason = self.policy.check("brand_new_write_tool", {})
        self.assertIsNone(safe)
        self.assertIn("not been classified", reason)
        spec = {"name": "brand_new_write_tool", "input_schema": {"type": "object"}}
        with patch.dict(self.registry._HANDLERS, {spec["name"]: lambda *a: self.fail("must not run")}), patch.dict(
            self.registry._SPECS_BY_NAME, {spec["name"]: spec}
        ), patch.object(self.registry, "TOOL_DEFINITIONS", self.registry.TOOL_DEFINITIONS + [spec]):
            self.assertNotIn(spec["name"], self.policy.permitted_tools(None))
            self.assertNotIn(spec["name"], self.policy.permitted_tools([spec["name"]]))
            out = self.registry.execute_tool(spec["name"], {}, self.DYNAMIC)
        self.assertIn("not permitted for an autonomous sub-agent", out)

    def test_blocked_tools_are_never_granted(self):
        granted = self.policy.permitted_tools(None)
        for name in ("remember", "send_email", "send_whatsapp_message", "integration_execute"):
            self.assertNotIn(name, granted)

    def test_remember_is_blocked_for_dynamic_agents_only(self):
        handler_calls = []
        with patch.dict(self.registry._HANDLERS, {"remember": lambda i, c: handler_calls.append(i) or "Saved"}):
            blocked = self.registry.execute_tool("remember", {"text": "x"}, self.DYNAMIC)
            allowed = self.registry.execute_tool("remember", {"text": "x"}, {"user_id": "u1"})
        self.assertIn("long-term memory", blocked)
        self.assertEqual(allowed, "Saved")
        self.assertEqual(len(handler_calls), 1)

    def test_automatic_memory_extraction_after_a_turn_is_unchanged(self):
        from app.routes import chat

        with patch("app.routes.chat.threading.Thread") as thread:
            chat._extract_memory_in_background("u1", "message", "reply")
        self.assertIs(thread.call_args.kwargs["target"], chat.mem0_client.add_from_turn)

    def test_mixed_tools_refuse_a_missing_or_unknown_action(self):
        for name in ("crm_contact", "calendar_tool"):
            for tool_input in ({}, {"action": "delete_everything"}):
                with self.subTest(tool=name, tool_input=tool_input):
                    self.assertIsNone(self.policy.check(name, tool_input)[0])

    def _zapier(self, context, tool_input):
        from app.tools import zapier_tool

        catalog = {"tools": [{"name": "hubspot_find_or_create_contact", "kind": "read", "title": "Find or create",
                              "app": "HubSpot", "inputSchema": {"type": "object"}}]}
        with patch.object(zapier_tool.zapier_mcp, "catalog_for", return_value=catalog), patch.object(
            zapier_tool.zapier_mcp, "connection_token", return_value="t"
        ), patch.object(zapier_tool.zapier_mcp, "call", return_value="EXECUTED") as call:
            out = self.registry.execute_tool("zapier", tool_input, context)
        return out, call

    def test_a_dynamic_agent_cannot_run_any_zapier_action_even_one_labelled_read(self):
        out, call = self._zapier(
            self.DYNAMIC, {"action": "run", "tool_name": "hubspot_find_or_create_contact", "confirmed": True}
        )
        call.assert_not_called()
        self.assertIn("PREVIEW", out)

    def test_normal_chat_treats_find_or_create_as_a_write(self):
        out, call = self._zapier(
            {"user_id": "u1", "organization_id": "org-1"},
            {"action": "run", "tool_name": "hubspot_find_or_create_contact"},
        )
        call.assert_not_called()
        self.assertIn("PREVIEW", out)


def _status_error(cls, status, error_type=None):
    request = httpx.Request("POST", "https://example.invalid")
    body = {"error": {"type": error_type}} if error_type else None
    return cls("provider said no", response=httpx.Response(status, request=request), body=body)


class RetryClassificationTests(unittest.TestCase):
    def test_transient_failures_are_retryable(self):
        request = httpx.Request("POST", "https://example.invalid")
        cases = [
            anthropic.APITimeoutError(request=request),
            anthropic.APIConnectionError(request=request),
            _status_error(anthropic.RateLimitError, 429),
            *[_status_error(anthropic.InternalServerError, s) for s in (500, 502, 503, 504, 529)],
            _status_error(anthropic.APIStatusError, 200, "overloaded_error"),
            httpx.ReadTimeout("slow"),
            httpx.RemoteProtocolError("dropped"),
            requests.ConnectionError("down"),
            pymongo.errors.AutoReconnect("failover"),
            redis.exceptions.ConnectionError("down"),
            ConnectionResetError("reset"),
            TimeoutError("slow"),
        ]
        for exc in cases:
            with self.subTest(exc=repr(exc)):
                self.assertTrue(retry_policy.classify(exc).retryable)

    def test_permanent_failures_are_not_retryable(self):
        cases = {
            "authentication": _status_error(anthropic.AuthenticationError, 401),
            "permission_denied": _status_error(anthropic.PermissionDeniedError, 403),
            "invalid_request": _status_error(anthropic.BadRequestError, 400, "invalid_request_error"),
            "not_found": _status_error(anthropic.NotFoundError, 404),
            "provider_error": _status_error(anthropic.InternalServerError, 501),
            "invalid_tool_arguments": json.JSONDecodeError("bad", "{", 1),
            "invalid_structured_output": retry_policy.StructuredOutputError("bad"),
            "budget_exhausted": BudgetExhaustedError("spent"),
            "configuration": requests.exceptions.SSLError("bad certificate"),
            "unclassified": RuntimeError("No Anthropic API key configured"),
        }
        cases_extra = [PermissionError("no"), ValueError("deterministic"), NotImplementedError("unsupported"),
                       KeyError("config"), redis.exceptions.AuthenticationError("bad password"),
                       pymongo.errors.ConfigurationError("bad uri")]
        for category, exc in cases.items():
            with self.subTest(category=category):
                self.assertEqual(retry_policy.classify(exc), (False, category))
        for exc in cases_extra:
            with self.subTest(exc=repr(exc)):
                self.assertFalse(retry_policy.classify(exc).retryable)


class RetryBehaviourTests(_Base):
    def _run(self, failure, **kwargs):
        events = []
        with patch(f"{M}.anthropic_client.plan_dynamic_delegation", return_value={"decompose": False}), patch(
            f"{M}.get_graph"
        ) as graph, patch(f"{M}.time.sleep") as sleep:
            graph.return_value.invoke.side_effect = failure
            result = self.run_root(on_event=events.append, **kwargs)
        return result["agents"][0], graph.return_value.invoke.call_count, sleep, events

    def test_a_permanent_failure_runs_once_and_tells_the_parent_why(self):
        agent, calls, sleep, events = self._run(_status_error(anthropic.AuthenticationError, 401))
        self.assertEqual(calls, 1)
        sleep.assert_not_called()
        self.assertIn("after 1 attempt(s): authentication (not retryable)", agent.result)
        self.assertNotIn("provider said no", agent.result)
        self.assertEqual([e["status"] for e in events if e["type"] == "agent_progress"], ["running", "failed"])

    def test_a_transient_failure_is_bounded_with_exponential_backoff_and_logged(self):
        with self.assertLogs("app.agent.dynamic.master_agent", "WARNING") as logs:
            agent, calls, sleep, events = self._run(ConnectionError("down"))
        self.assertEqual(calls, master_agent.limits.MAX_RETRIES + 1)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2, 4])
        self.assertIn("after 3 attempt(s): network (retries exhausted)", agent.result)
        decisions = [line for line in logs.output if "category=network" in line]
        self.assertEqual(len(decisions), 3)
        self.assertIn("attempt 1 failed", decisions[0])
        self.assertEqual(
            [e["status"] for e in events if e["type"] == "agent_progress"],
            ["running", "retrying", "running", "retrying", "running", "failed"],
        )

    def test_cancellation_during_the_backoff_prevents_the_next_attempt(self):
        class CancelsWhileWaiting(threading.Event):
            def wait(self, timeout=None):
                self.set()
                return True

        agent, calls, _, _ = self._run(ConnectionError("down"), cancel_event=CancelsWhileWaiting())
        self.assertEqual((calls, agent.retry_count), (1, 0))
        self.assertIn("(cancelled)", agent.result)

    def test_a_deadline_crossed_during_the_backoff_prevents_the_next_attempt(self):
        now = [0.0]
        with patch(f"{M}.anthropic_client.plan_dynamic_delegation", return_value={"decompose": False}), patch(
            f"{M}.get_graph"
        ) as graph, patch(f"{M}.time.monotonic", side_effect=lambda: now[0]), patch(
            f"{M}.time.sleep", side_effect=lambda s: now.__setitem__(0, 999.0)
        ):
            graph.return_value.invoke.side_effect = ConnectionError("down")
            agent = self.run_root(_deadline=50.0)["agents"][0]
        self.assertEqual(graph.return_value.invoke.call_count, 1)
        self.assertIn("(execution deadline reached)", agent.result)

    def test_cancellation_during_planning_prevents_the_first_attempt(self):
        cancel = threading.Event()

        def plan(task, **kwargs):
            cancel.set()
            return {"decompose": False}

        with patch(f"{M}.anthropic_client.plan_dynamic_delegation", side_effect=plan), patch(f"{M}.get_graph") as graph:
            agent = self.run_root(cancel_event=cancel)["agents"][0]
        graph.return_value.invoke.assert_not_called()
        self.assertEqual(agent.error, "cancelled")

    def test_an_invalid_output_schema_is_permanent(self):
        def plan(task, **kwargs):
            if task != "root":
                return {"decompose": False}
            return {"decompose": True, "sub_agents": [
                {"name": "a", "task_description": "a", "tools": [], "output_schema": {"type": "not-a-type"}}]}

        with patch(f"{M}.anthropic_client.plan_dynamic_delegation", side_effect=plan), patch(f"{M}.get_graph") as graph:
            graph.return_value.invoke.return_value = _reply("{}")
            agent = self.run_root()["agents"][0]
        self.assertEqual(graph.return_value.invoke.call_count, 1)
        self.assertEqual(agent.error_category, "invalid_structured_output")


def _tool_request(count):
    return [{"type": "function_call", "name": "crm_deal", "call_id": f"c{i}", "arguments": "{}"} for i in range(count)]


class AtomicLimitTests(_Base):
    """Parallel sub-agents through the REAL LangGraph loop; only the LLM and
    the tool execution are faked."""

    def _run_parallel(self, *, max_model_calls=40, max_tool_calls=60, tools_per_round=1, rounds=3, agents=6):
        model_calls, tool_runs, lock = [], [], threading.Lock()
        start_together = threading.Barrier(agents, timeout=10)
        turns = {}

        def llm(messages, **kwargs):
            with lock:
                model_calls.append(1)
                agent_id = kwargs["agent_instance_id"]
                turns[agent_id] = turns.get(agent_id, 0) + 1
                turn = turns[agent_id]
            if turn == 1:
                start_together.wait()  # every agent is mid-run at once
            if turn <= rounds:
                return _tool_request(tools_per_round), "anthropic"
            return _reply()["messages"], "anthropic"

        def tool(name, args, context, allowed_tools=None):
            with lock:
                tool_runs.append(1)
            return "data"

        resolved = master_agent.org_limits.resolve(None)._replace(
            max_model_calls=max_model_calls, max_tool_calls=max_tool_calls
        )
        with patch(f"{M}.org_limits.resolve", return_value=resolved), patch(
            f"{M}.anthropic_client.plan_dynamic_delegation", side_effect=_planner(agents, tools=["crm_deal"])
        ), patch("app.agent.graph.call_llm", side_effect=llm), patch(
            "app.agent.graph.cached_execute_tool", side_effect=tool
        ):
            result = self.run_root()
        return result["agents"], len(model_calls), len(tool_runs)

    def test_parallel_agents_never_exceed_the_model_call_limit(self):
        # The root and each of the 6 sub-agents make one planning call (all are
        # below max depth); the rest of the 15 go to planner rounds.
        agents, llm_calls, _ = self._run_parallel(max_model_calls=15)
        planning_calls = 7
        self.assertEqual(llm_calls, 15 - planning_calls)
        failed = [a for a in agents if a.status == "failed"]
        self.assertTrue(failed)
        self.assertEqual({a.error_category for a in failed} - {None}, {"budget_exhausted"})
        self.assertEqual(sum(a.retry_count for a in agents), 0)  # an exhausted budget is never retried

    def test_parallel_agents_never_exceed_the_tool_call_limit(self):
        agents, _, tool_runs = self._run_parallel(max_tool_calls=10, tools_per_round=4)
        self.assertEqual(tool_runs, 10)
        self.assertEqual(sum(len(a.tools_used) for a in agents), 10)
        self.assertTrue(all(a.status == "done" for a in agents))  # they finish with what they have

    def test_within_limits_parallel_delegation_is_unaffected(self):
        agents, llm_calls, tool_runs = self._run_parallel(rounds=2)
        self.assertEqual([a.status for a in agents], ["done"] * 6)
        self.assertEqual((llm_calls, tool_runs), (18, 12))

    def test_a_graph_without_a_limiter_is_not_limited(self):
        from app.agent import graph

        with patch("app.agent.graph.call_llm", return_value=([], "anthropic")) as llm, patch(
            "app.agent.graph.cached_execute_tool", return_value="data"
        ):
            graph.planner_node({"messages": [], "user_id": "u", "conversation_id": "c"})
            out = graph.tools_node({"pending_calls": _tool_request(2), "user_id": "u", "conversation_id": "c"})
        llm.assert_called_once()
        self.assertEqual(out["tools_used"], ["crm_deal", "crm_deal"])

    def test_reservation_is_atomic_under_contention(self):
        counter = RunningTotal(100)
        with ThreadPoolExecutor(max_workers=16) as pool:
            granted = sum(pool.map(lambda _: counter.try_reserve(), range(2000)))
        self.assertEqual((granted, counter.total), (100, 100))


if __name__ == "__main__":
    unittest.main()

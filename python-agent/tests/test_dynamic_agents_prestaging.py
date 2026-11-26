"""Phase 2.8 pre-staging safety regression tests.

No real LLM, Mongo or network calls: the planner, the leaf graph (or its LLM
call) and usage lookups are always mocked.

    .venv/Scripts/python.exe -m pytest tests/test_dynamic_agents_prestaging.py
"""

import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent import cancellation, graph, orchestrator  # noqa: E402
from app.agent.dynamic import master_agent, org_limits, tool_policy  # noqa: E402

M = "app.agent.dynamic.master_agent"


def _reply(text="ok"):
    return {"messages": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}]}


def _decompose(*entries):
    def plan(task, **kwargs):
        return {"decompose": True, "sub_agents": list(entries)} if task == "root" else {"decompose": False}

    return plan


def _entry(task, **extra):
    return {"name": task, "task_description": task, "tools": [], **extra}


class _Base(unittest.TestCase):
    def setUp(self):
        patcher = patch(f"{M}.usage_tracker.current_usage", return_value=(0, 0.0))
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_root(self, plan, invoke=None, **kwargs):
        with patch(f"{M}.anthropic_client.plan_dynamic_delegation", side_effect=plan), patch(f"{M}.get_graph") as g:
            g.return_value.invoke.side_effect = invoke or (lambda state: _reply())
            kwargs.setdefault("organization_id", None)
            result = master_agent.run_task(
                "root", user_id="u1", conversation_id="c1", request_id="r1", **kwargs
            )
        return result, g.return_value.invoke


class CancelOwnershipTests(unittest.TestCase):
    def tearDown(self):
        cancellation._events.clear()

    def test_the_owner_can_cancel(self):
        event = cancellation.start("conv", "u1", "org-a")
        self.assertTrue(cancellation.request_cancel("conv", "u1", "org-a"))
        self.assertTrue(event.is_set())

    def test_another_user_or_organization_cannot_cancel(self):
        event = cancellation.start("conv", "u1", "org-a")
        for user_id, org in (("u2", "org-a"), ("u1", "org-b"), ("u2", "org-b"), ("u1", None)):
            with self.subTest(user=user_id, org=org):
                self.assertFalse(cancellation.request_cancel("conv", user_id, org))
        self.assertFalse(event.is_set())

    def test_a_finished_turn_never_unregisters_another_running_turn(self):
        first = cancellation.start("conv", "u1", "org-a")
        second = cancellation.start("conv", "u1", "org-a")
        cancellation.finish("conv", first)
        self.assertTrue(cancellation.request_cancel("conv", "u1", "org-a"))
        self.assertTrue(second.is_set())
        cancellation.finish("conv", second)
        self.assertEqual(cancellation._events, {})

    def test_another_user_reusing_the_id_cannot_displace_the_owner(self):
        mine = cancellation.start("conv", "u1", "org-a")
        theirs = cancellation.start("conv", "u2", "org-b")
        self.assertTrue(cancellation.request_cancel("conv", "u1", "org-a"))
        self.assertEqual((mine.is_set(), theirs.is_set()), (True, False))

    def test_the_route_takes_identity_from_the_token(self):
        from app.routes import chat

        event = cancellation.start("conv", "u1", "org-a")
        payload = chat.CancelRequest(conversation_id="conv")
        self.assertEqual(chat.cancel_stream(payload, {"sub": "u2", "organizationId": "org-b"}), {"cancelled": False})
        self.assertFalse(event.is_set())
        self.assertEqual(chat.cancel_stream(payload, {"sub": "u1", "organizationId": "org-a"}), {"cancelled": True})

    def test_the_orchestrator_registers_the_turns_owner_and_cleans_up(self):
        seen = []

        def invoke(state):
            seen.append(cancellation.request_cancel("conv", "u2", "org-a"))
            seen.append(cancellation.request_cancel("conv", "u1", "org-a"))
            return {**_reply(), "tools_used": []}

        with patch("app.agent.orchestrator.get_graph") as g:
            g.return_value.invoke.side_effect = invoke
            orchestrator.run(
                {"messages": [{"role": "user", "content": "q"}], "user_id": "u1", "organization_id": "org-a",
                 "conversation_id": "conv", "has_attachments": True}
            )
        self.assertEqual(seen, [False, True])
        self.assertEqual(cancellation._events, {})


class MalformedPlanTests(_Base):
    def test_unusable_plans_run_the_task_directly_with_the_selected_tools(self):
        plans = [
            None, "decompose", [],
            {"decompose": True, "sub_agents": "abc", "direct_tools": []},
            {"decompose": True, "sub_agents": {"a": 1}, "direct_tools": []},
            {"decompose": True, "sub_agents": ["a", 1, None], "direct_tools": []},
            {"decompose": "false", "sub_agents": [_entry("a")]},
        ]
        for plan in plans:
            with self.subTest(plan=plan):
                result, invoke = self.run_root(lambda task, **kw: plan, parent_allowed_tools=["crm_deal"])
                self.assertEqual(invoke.call_count, 1)
                self.assertEqual([a.status for a in result["agents"]], ["done"])
                if not isinstance(plan, dict) or plan.get("sub_agents") != [_entry("a")]:
                    self.assertEqual(invoke.call_args.args[0]["allowed_tools"], ["crm_deal"])

    def test_an_invalid_entry_is_marked_and_its_siblings_still_run(self):
        bad = ["not-a-dict", {"name": "x", "task_description": 42, "tools": []},
               {"name": "y", "task_description": "   ", "tools": []}]
        result, invoke = self.run_root(_decompose(*bad, _entry("good")))
        self.assertEqual(invoke.call_count, 1)
        self.assertEqual([a.status for a in result["agents"]], ["failed", "failed", "failed", "done"])
        self.assertEqual({a.error for a in result["agents"][:3]}, {"invalid sub-agent specification"})

    def test_invalid_entries_consume_no_agent_budget(self):
        entries = ["junk"] * 10 + [_entry(f"t{i}") for i in range(6)]
        _, invoke = self.run_root(_decompose(*entries))
        self.assertEqual(invoke.call_count, master_agent.limits.MAX_AGENTS_PER_REQUEST)

    def test_malformed_tool_lists_grant_nothing(self):
        for requested in (5, "crm_deal", {"crm_deal": 1}, [{"name": "crm_deal"}], [["crm_deal"]], [1]):
            with self.subTest(requested=requested):
                self.assertEqual(tool_policy.narrow(requested, ["crm_deal"]), [])
        _, invoke = self.run_root(_decompose(_entry("a", tools=[{"x": 1}, "crm_deal"])))
        self.assertEqual(invoke.call_args.args[0]["allowed_tools"], ["crm_deal"])

    def test_a_sub_agent_never_runs_on_a_provider_without_tool_support(self):
        _, invoke = self.run_root(_decompose(_entry("a", provider="groq")))
        self.assertEqual(invoke.call_args.args[0]["provider"], "anthropic")

    def test_an_unexpected_error_in_one_branch_does_not_discard_its_siblings(self):
        real = master_agent._run_agent

        def run_agent(agent, **kwargs):
            if agent.task_description == "boom":
                raise RuntimeError("SECRET-DETAIL")
            return real(agent, **kwargs)

        with patch(f"{M}._run_agent", side_effect=run_agent) as patched:
            # run_task calls the patched name for the root too, which passes through.
            result, _ = self.run_root(_decompose(_entry("boom"), _entry("fine")))
        self.assertTrue(patched.called)
        self.assertEqual([a.status for a in result["agents"]], ["failed", "done"])
        self.assertNotIn("SECRET-DETAIL", result["final_text"])


class DuplicateAndDepthTests(_Base):
    def test_whitespace_and_case_variants_are_duplicates(self):
        result, invoke = self.run_root(_decompose(_entry("find  the deals"), _entry("Find the\ndeals "), _entry(" ROOT ")))
        self.assertEqual(invoke.call_count, 1)
        self.assertEqual([a.status for a in result["agents"]], ["done", "failed", "failed"])

    def test_a_planner_that_always_splits_stops_at_the_depth_limit(self):
        def plan(task, **kwargs):
            return {"decompose": True, "sub_agents": [_entry(task + ".x")]}

        _, invoke = self.run_root(plan)
        self.assertEqual(invoke.call_count, 1)
        self.assertEqual(invoke.call_args.args[0]["delegation_depth"], master_agent.limits.MAX_DEPTH)

    def test_a_non_numeric_organization_override_cannot_remove_a_ceiling(self):
        nan = float("nan")
        with patch.object(org_limits, "_resolve_overrides", return_value={"maxCostUsd": nan, "maxAgentsPerRequest": nan}):
            resolved = org_limits.resolve("org")
        self.assertEqual(resolved.max_cost_usd, master_agent.limits.MAX_COST_USD)
        self.assertEqual(resolved.max_agents_per_request, master_agent.limits.MAX_AGENTS_PER_REQUEST)


class CancellationAndTimeoutTests(_Base):
    def test_cancellation_during_planning_creates_no_sub_agents(self):
        cancel, events = threading.Event(), []

        def plan(task, **kwargs):
            cancel.set()
            return {"decompose": True, "sub_agents": [_entry("a"), _entry("b")]}

        result, invoke = self.run_root(plan, cancel_event=cancel, on_event=events.append)
        invoke.assert_not_called()
        self.assertEqual([e for e in events if e["type"] == "agent_created"], [])
        self.assertEqual([a.error for a in result["agents"]], ["cancelled"])

    def test_an_agent_cancelled_mid_run_is_not_reported_done_and_keeps_its_partial_text(self):
        cancel, events = threading.Event(), []

        def invoke(state):
            cancel.set()
            return _reply("partial answer")

        result, _ = self.run_root(
            lambda task, **kw: {"decompose": False}, invoke, cancel_event=cancel, on_event=events.append
        )
        agent = result["agents"][0]
        self.assertEqual((agent.status, agent.error_category, agent.result), ("failed", "cancelled", "partial answer"))
        self.assertEqual([e["status"] for e in events if e["type"] == "agent_progress"], ["running", "failed"])
        self.assertEqual([e for e in events if e["type"] == "agent_completed"], [])

    def test_a_cancelled_sub_agent_starts_no_further_model_call(self):
        cancel = threading.Event()
        cancel.set()
        with patch("app.agent.graph.call_llm") as llm:
            out = graph.planner_node(
                {"messages": [], "user_id": "u", "conversation_id": "c", "agent_instance_id": "dyn-1",
                 "allowed_tools": [], "cancel_event": cancel}
            )
        llm.assert_not_called()
        self.assertEqual(out["pending_calls"], [])

    def test_normal_chat_planner_is_unchanged_by_cancellation(self):
        cancel = threading.Event()
        cancel.set()
        with patch("app.agent.graph.call_llm", return_value=([], "anthropic")) as llm:
            graph.planner_node({"messages": [], "user_id": "u", "conversation_id": "c", "cancel_event": cancel})
        llm.assert_called_once()

    def test_a_running_agent_starts_no_model_or_tool_call_after_the_deadline(self):
        now, llm_calls, tool_runs = [0.0], [], []

        def llm(messages, **kwargs):
            llm_calls.append(1)
            now[0] = 999.0  # the first round overruns the deadline
            return [{"type": "function_call", "name": "crm_deal", "call_id": "c1", "arguments": "{}"}], "anthropic"

        with patch(f"{M}.anthropic_client.plan_dynamic_delegation", return_value={"decompose": False}), patch(
            f"{M}.time.monotonic", side_effect=lambda: now[0]
        ), patch("app.agent.graph.call_llm", side_effect=llm), patch(
            "app.agent.graph.cached_execute_tool", side_effect=lambda *a, **k: tool_runs.append(1) or "data"
        ):
            result = master_agent.run_task(
                "root", organization_id=None, user_id="u1", conversation_id="c1", request_id="r1", _deadline=50.0
            )
        agent = result["agents"][0]
        self.assertEqual((len(llm_calls), len(tool_runs)), (1, 0))
        self.assertEqual((agent.status, agent.error_category, agent.retry_count), ("failed", "timed_out", 0))


class ResultAndTraceTests(_Base):
    def test_the_parent_receives_each_childs_own_outcome(self):
        def invoke(state):
            task = state["messages"][-1]["content"][0]["text"]
            if task == "bad":
                raise PermissionError("PRIVATE-DETAIL")
            return _reply(f"result of {task}")

        result, _ = self.run_root(_decompose(_entry("good"), _entry("bad")), invoke)
        self.assertIn("result of good", result["final_text"])
        self.assertIn("permission_denied", result["final_text"])
        self.assertNotIn("PRIVATE-DETAIL", result["final_text"])

    def test_every_agent_is_logged_with_its_trace_identifiers(self):
        with self.assertLogs(M, "INFO") as logs:
            result, _ = self.run_root(_decompose(_entry("PRIVATE-TASK-a"), _entry("b")), organization_id="org-x")
        lines = [line for line in logs.output if "dynamic agent outcome" in line]
        self.assertEqual(len(lines), 3)  # the root and both children
        for line in lines:
            self.assertIn("request_id=r1", line)
            self.assertIn("organization_id=org-x", line)
        for agent in result["agents"]:
            self.assertTrue(any(f"agent_id={agent.id}" in line and f"parent_id={agent.parent_id}" in line for line in lines))
        self.assertNotIn("PRIVATE-TASK", "\n".join(logs.output))

    def test_secrets_in_an_exception_are_not_logged(self):
        secret = "sk-ant-abcdefghijklmnopqrstuvwxyz012345"

        def invoke(state):
            raise RuntimeError(f"bad key {secret}")

        with self.assertLogs(M, "INFO") as logs:
            self.run_root(lambda task, **kw: {"decompose": False}, invoke)
        self.assertNotIn(secret, "\n".join(logs.output))


class DelegationFallbackTests(unittest.TestCase):
    def test_a_dynamic_failure_is_recorded_without_its_secrets(self):
        secret = "sk-ant-abcdefghijklmnopqrstuvwxyz012345"
        state = {"messages": [{"role": "user", "content": "q"}], "request_id": "r9", "organization_id": "org-x"}
        with patch.object(orchestrator.dynamic_runner, "ENABLED", True), patch.object(
            orchestrator.dynamic_runner, "run", side_effect=RuntimeError(f"boom {secret}")
        ), self.assertLogs("app.agent.orchestrator", "WARNING") as logs:
            self.assertIsNone(orchestrator._run_dynamic_delegation(state, None, None))
        self.assertIn("request_id=r9", logs.output[0])
        self.assertIn("organization_id=org-x", logs.output[0])
        self.assertNotIn(secret, logs.output[0])

    def _delegate(self, allowed_tools, agents=("crm", "outlook", "operations")):
        plan = {"mode": "delegate", "assignments": [{"agent": a, "task": a} for a in agents]}
        states = []

        def invoke(state):
            states.append(state)
            return {**_reply(), "tools_used": []}

        with patch("app.agent.orchestrator.trivial_router.trivial_plan", return_value=plan), patch.object(
            orchestrator.dynamic_runner, "ENABLED", False
        ), patch("app.agent.orchestrator.get_graph") as g, patch(
            "app.agent.orchestrator.anthropic_client.call", return_value=_reply()["messages"]
        ), patch(
            "app.agent.orchestrator.anthropic_client.critique_response", return_value={"complete": False, "missing": "x"}
        ), patch("app.agent.orchestrator.anthropic_client.suggest_follow_ups", return_value=[]):
            g.return_value.invoke.side_effect = invoke
            orchestrator.run(
                {"messages": [{"role": "user", "content": "q"}], "user_id": "u1", "conversation_id": "",
                 "organization_id": "org-a", "allowed_tools": allowed_tools}
            )
        return states

    def test_specialists_cannot_exceed_a_restricted_roles_tools(self):
        states = self._delegate(["crm_deal", "outlook_lookup"])
        *specialists, corrective = states
        self.assertEqual(
            sorted(s["allowed_tools"] for s in specialists), [["crm_deal"], ["outlook_lookup"]]
        )  # "operations" has none of the role's tools, so it never runs
        self.assertEqual(corrective["allowed_tools"], ["crm_deal", "outlook_lookup"])

    def test_no_permitted_specialist_falls_back_to_the_single_loop(self):
        states = self._delegate(["web_search"], agents=("crm",))
        self.assertEqual(states[0]["allowed_tools"], ["web_search"])
        self.assertEqual(states[0]["messages"], [{"role": "user", "content": "q"}])

    def test_unrestricted_chat_delegation_is_unchanged(self):
        from app.agent.specialists import SPECIALISTS

        *specialists, corrective = self._delegate(None)
        self.assertEqual(
            sorted(s["allowed_tools"] for s in specialists),
            sorted(SPECIALISTS[a]["tools"] for a in ("crm", "outlook", "operations")),
        )
        self.assertIsNone(corrective["allowed_tools"])


if __name__ == "__main__":
    unittest.main()

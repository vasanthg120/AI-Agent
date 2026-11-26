"""Tests for app.agent.dynamic.master_agent — the Phase 2 recursive
delegation engine (see the plan's "Dynamic Recursive Multi-Agent System"
section, "Pivot" subsection, and app/agent/dynamic/__init__.py's own
docstring for why this is Anthropic-native, not openai-agents-based).

Every test mocks anthropic_client.plan_dynamic_delegation (no real Claude
call) and app.agent.graph.get_graph (no real tool loop) — this file is
about master_agent's own recursion/budget/error-isolation logic, not about
re-testing graph.py or the tool registry's own guards, which already have
their own test coverage.

Plain stdlib unittest, matching this project's existing convention
(test_organization_isolation.py). Run with:
    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent.dynamic import master_agent  # noqa: E402

# Phase 2.5, Sub-step C's token/cost ceiling check (see _run_agent) queries
# real Mongo via usage_tracker.current_usage on every call, by design — but
# every test in this file predates that and never wants a real Mongo
# dependency, so it's patched module-wide to a harmless (0, 0.0) here.
# Tests that specifically exercise the token/cost ceiling (TokenCostLimitTests
# below) locally override this with their own nested patch.
_usage_patch = patch("app.agent.dynamic.master_agent.usage_tracker.current_usage", return_value=(0, 0.0))


def setUpModule():
    _usage_patch.start()


def tearDownModule():
    _usage_patch.stop()


def _fake_graph_result(text: str):
    """Shaped like the real AgentState get_graph().invoke() returns — only
    what app.agent.graph.final_text actually reads."""
    return {
        "messages": [
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}
        ]
    }


class DirectExecutionTests(unittest.TestCase):
    """A simple task the planner decides not to decompose."""

    def test_simple_task_runs_as_one_direct_agent(self):
        plan = {"decompose": False, "direct_tools": ["crm_deal"], "sub_agents": []}
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("done directly")
            result = master_agent.run_task(
                "summarize today's deals", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        self.assertEqual(len(result["agents"]), 1)
        self.assertEqual(result["agents"][0].status, "done")
        self.assertEqual(result["final_text"], "done directly")
        # The direct agent is scoped to exactly what the planner asked for —
        # never silently widened to the full tool catalog when direct_tools
        # was actually provided.
        state_passed = get_graph.return_value.invoke.call_args[0][0]
        self.assertEqual(state_passed["allowed_tools"], ["crm_deal"])


class DecompositionTests(unittest.TestCase):
    """A complex task the planner decides to split into 2+ sub-agents."""

    def test_complex_task_creates_and_runs_multiple_sub_agents(self):
        top_plan = {
            "decompose": True,
            "direct_tools": [],
            "sub_agents": [
                {"name": "crm-lookup", "task_description": "find the deal", "tools": ["crm_deal"]},
                {"name": "mail-lookup", "task_description": "find the email thread", "tools": ["outlook_lookup"]},
            ],
        }
        leaf_plan = {"decompose": False, "direct_tools": [], "sub_agents": []}

        def fake_plan(task_description, **kwargs):
            return top_plan if task_description == "complex task" else leaf_plan

        def fake_invoke(state):
            task_text = state["messages"][-1]["content"][0]["text"]
            return _fake_graph_result(f"result for: {task_text}")

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", side_effect=fake_plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.side_effect = fake_invoke
            result = master_agent.run_task(
                "complex task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        self.assertEqual(len(result["agents"]), 2)
        names = {a.name for a in result["agents"]}
        self.assertEqual(names, {"crm-lookup", "mail-lookup"})
        self.assertTrue(all(a.status == "done" for a in result["agents"]))
        self.assertIn("find the deal", result["final_text"])
        self.assertIn("find the email thread", result["final_text"])


class DepthLimitTests(unittest.TestCase):
    def test_max_depth_forces_direct_execution_even_when_planner_wants_to_decompose(self):
        plan = {
            "decompose": True,
            "direct_tools": ["crm_deal"],
            "sub_agents": [{"name": "x", "task_description": "x", "tools": []}],
        }
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch("app.agent.dynamic.master_agent.limits.MAX_DEPTH", 0):
            get_graph.return_value.invoke.return_value = _fake_graph_result("direct")
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        self.assertEqual(len(result["agents"]), 1)
        self.assertNotEqual(result["agents"][0].name, "x")


class AgentCountLimitTests(unittest.TestCase):
    def test_max_agents_per_request_truncates_planned_sub_agents(self):
        plan = {
            "decompose": True,
            "direct_tools": [],
            "sub_agents": [
                {"name": "a", "task_description": "a", "tools": []},
                {"name": "b", "task_description": "b", "tools": []},
            ],
        }
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch("app.agent.dynamic.master_agent.limits.MAX_AGENTS_PER_REQUEST", 1):
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        # Only the first planned sub-agent fit inside the budget of 1.
        self.assertEqual(len(result["agents"]), 1)
        self.assertEqual(result["agents"][0].name, "a")

    def test_budget_exhausted_before_any_sub_agent_returns_a_clear_marker_not_a_crash(self):
        plan = {"decompose": True, "direct_tools": [], "sub_agents": [{"name": "a", "task_description": "a", "tools": []}]}
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.limits.MAX_AGENTS_PER_REQUEST", 0
        ):
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        self.assertEqual(len(result["agents"]), 1)
        self.assertEqual(result["agents"][0].status, "failed")
        self.assertIn("budget exhausted", result["agents"][0].error)


class FailureIsolationTests(unittest.TestCase):
    def test_one_failed_sub_agent_never_crashes_the_whole_request(self):
        plan = {
            "decompose": True,
            "direct_tools": [],
            "sub_agents": [
                {"name": "good", "task_description": "good task", "tools": []},
                {"name": "bad", "task_description": "bad task", "tools": []},
            ],
        }
        leaf_plan = {"decompose": False, "direct_tools": [], "sub_agents": []}

        def fake_plan(task_description, **kwargs):
            return plan if task_description == "complex" else leaf_plan

        def fake_invoke(state):
            task_text = state["messages"][-1]["content"][0]["text"]
            if task_text == "bad task":
                raise ConnectionError("boom")
            return _fake_graph_result(f"ok: {task_text}")

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", side_effect=fake_plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch("app.agent.dynamic.master_agent.time.sleep"):
            get_graph.return_value.invoke.side_effect = fake_invoke
            result = master_agent.run_task(
                "complex", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        by_name = {a.name: a for a in result["agents"]}
        self.assertEqual(by_name["good"].status, "done")
        self.assertEqual(by_name["bad"].status, "failed")
        self.assertIn("boom", by_name["bad"].error)
        self.assertIn("ok: good task", result["final_text"])
        # A persistently-failing task gets retried up to the configured
        # limit (Sub-step B), not just marked failed on the first attempt.
        self.assertEqual(by_name["bad"].retry_count, master_agent.limits.MAX_RETRIES)
        self.assertEqual(len(by_name["bad"].retry_history), master_agent.limits.MAX_RETRIES)


class ToolPermissionScopingTests(unittest.TestCase):
    def test_sub_agent_is_scoped_to_only_the_tools_the_planner_named_never_the_full_catalog(self):
        plan = {
            "decompose": True,
            "direct_tools": [],
            "sub_agents": [{"name": "scoped", "task_description": "x", "tools": ["crm_note"]}],
        }
        leaf_plan = {"decompose": False, "direct_tools": [], "sub_agents": []}

        def fake_plan(task_description, **kwargs):
            return plan if task_description == "top" else leaf_plan

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", side_effect=fake_plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            master_agent.run_task("top", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1")

        state_passed = get_graph.return_value.invoke.call_args[0][0]
        self.assertEqual(state_passed["allowed_tools"], ["crm_note"])


class OrganizationAndRequestIdThreadingTests(unittest.TestCase):
    def test_organization_id_and_request_id_are_threaded_unchanged_into_every_internal_call(self):
        plan = {
            "decompose": True,
            "direct_tools": [],
            "sub_agents": [{"name": "child", "task_description": "x", "tools": []}],
        }
        leaf_plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        seen_plan_kwargs = []

        def fake_plan(task_description, **kwargs):
            seen_plan_kwargs.append(kwargs)
            return plan if task_description == "top" else leaf_plan

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", side_effect=fake_plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            master_agent.run_task(
                "top", organization_id="org-xyz", user_id="u1", conversation_id="c1", request_id="req-shared"
            )

        for kwargs in seen_plan_kwargs:
            self.assertEqual(kwargs["organization_id"], "org-xyz")
            self.assertEqual(kwargs["request_id"], "req-shared")
        state_passed = get_graph.return_value.invoke.call_args[0][0]
        self.assertEqual(state_passed["organization_id"], "org-xyz")
        self.assertEqual(state_passed["request_id"], "req-shared")

    def test_two_different_organizations_are_never_mixed_across_concurrent_sub_agents(self):
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        seen_orgs = []

        def fake_invoke(state):
            seen_orgs.append(state["organization_id"])
            return _fake_graph_result("ok")

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.side_effect = fake_invoke
            master_agent.run_task("t", organization_id="org-a", user_id="u1", conversation_id="c1", request_id="r1")
            master_agent.run_task("t", organization_id="org-b", user_id="u1", conversation_id="c1", request_id="r2")

        self.assertEqual(seen_orgs, ["org-a", "org-b"])


class PlanningFailureFallbackTests(unittest.TestCase):
    def test_a_planning_failure_falls_back_to_direct_execution_with_the_permitted_tools_rather_than_raising(self):
        with patch(
            "app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", side_effect=RuntimeError("no api key")
        ), patch("app.agent.dynamic.master_agent.get_graph") as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("fallback ok")
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        self.assertEqual(len(result["agents"]), 1)
        self.assertEqual(result["agents"][0].status, "done")
        state_passed = get_graph.return_value.invoke.call_args[0][0]
        # No plan exists to narrow the scope, so the root keeps everything permitted.
        self.assertEqual(state_passed["allowed_tools"], master_agent.tool_policy.permitted_tools(None))


class ExecutionTimeLimitTests(unittest.TestCase):
    def test_an_already_elapsed_deadline_skips_work_with_a_clear_marker_not_a_crash(self):
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation") as plan_call:
            result = master_agent.run_task(
                "task",
                organization_id="org-1",
                user_id="u1",
                conversation_id="c1",
                request_id="r1",
                _deadline=0.0,  # already in the past
            )

        plan_call.assert_not_called()
        self.assertEqual(result["agents"][0].status, "failed")
        self.assertIn("execution time budget exceeded", result["agents"][0].error)


class CancellationTests(unittest.TestCase):
    def test_an_already_cancelled_request_skips_planning_entirely(self):
        import threading

        cancel_event = threading.Event()
        cancel_event.set()
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation") as plan_call:
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                cancel_event=cancel_event,
            )

        plan_call.assert_not_called()
        self.assertEqual(result["agents"][0].status, "failed")
        self.assertIn("cancelled", result["agents"][0].error)

    def test_cancellation_set_between_two_sequential_agents_never_fabricates_work_for_the_second(self):
        # Billing relevance (Phase 2.5, Sub-step D): get_graph().invoke() is
        # the ONLY path that produces a real agent_executions row for a leaf
        # (see master_agent._execute_leaf) — proving the second agent never
        # reaches it is exactly "cancellation never fabricates a billable
        # row for work that was never actually done." Deliberately
        # sequential (not two concurrent siblings) so the ordering is
        # deterministic rather than a thread-scheduling race.
        import threading

        from app.agent.dynamic.dynamic_agent import DynamicAgent

        cancel_event = threading.Event()
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("first agent's real completed answer")
            first = DynamicAgent(name="first", task_description="first task", allowed_tools=[], depth=1)
            master_agent._run_agent(
                first, organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                base_messages=[], cancel_event=cancel_event, on_event=None,
                budget=master_agent._Budget(10), deadline=time.monotonic() + 60, max_depth=2,
            )
            cancel_event.set()  # cancellation arrives strictly AFTER the first agent's real work finished

            second = DynamicAgent(name="second", task_description="second task", allowed_tools=[], depth=1)
            master_agent._run_agent(
                second, organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                base_messages=[], cancel_event=cancel_event, on_event=None,
                budget=master_agent._Budget(10), deadline=time.monotonic() + 60, max_depth=2,
            )

        self.assertEqual(get_graph.return_value.invoke.call_count, 1)  # only the first agent ever actually ran
        self.assertEqual(first.status, "done")
        self.assertEqual(first.result, "first agent's real completed answer")
        self.assertEqual(second.status, "failed")
        self.assertEqual(second.error, "cancelled")


class CircularDelegationTests(unittest.TestCase):
    def test_a_sub_agent_task_identical_to_its_own_parent_is_skipped_without_running(self):
        plan = {
            "decompose": True, "direct_tools": [],
            "sub_agents": [{"name": "loop", "task_description": "Top Task", "tools": []}],
        }
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            result = master_agent.run_task(
                "Top Task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        get_graph.return_value.invoke.assert_not_called()
        self.assertEqual(len(result["agents"]), 1)
        self.assertEqual(result["agents"][0].status, "failed")
        self.assertIn("circular delegation", result["agents"][0].error)

    def test_a_grandchild_task_identical_to_the_root_tasks_is_also_caught_not_just_the_immediate_parent(self):
        root_plan = {
            "decompose": True, "direct_tools": [],
            "sub_agents": [{"name": "child", "task_description": "child subtask", "tools": []}],
        }
        child_plan = {
            "decompose": True, "direct_tools": [],
            # Matches the ROOT's task, two levels up — not the immediate
            # parent's ("child subtask") — proving ancestor_tasks
            # accumulates past one level.
            "sub_agents": [{"name": "grandchild", "task_description": "root task", "tools": []}],
        }
        leaf_plan = {"decompose": False, "direct_tools": [], "sub_agents": []}

        def fake_plan(task_description, **kwargs):
            if task_description == "root task":
                return root_plan
            if task_description == "child subtask":
                return child_plan
            return leaf_plan

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", side_effect=fake_plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            result = master_agent.run_task(
                "root task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        by_name = {a.name: a for a in result["agents"]}
        self.assertEqual(by_name["grandchild"].status, "failed")
        self.assertIn("circular delegation", by_name["grandchild"].error)

    def test_two_sibling_sub_agents_with_the_identical_task_the_second_is_skipped_as_a_duplicate(self):
        top_plan = {
            "decompose": True, "direct_tools": [],
            "sub_agents": [
                {"name": "first", "task_description": "same task", "tools": []},
                {"name": "second", "task_description": "same task", "tools": []},
            ],
        }
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

        by_name = {a.name: a for a in result["agents"]}
        self.assertEqual(by_name["first"].status, "done")
        self.assertEqual(by_name["second"].status, "failed")
        self.assertIn("duplicate of a sibling", by_name["second"].error)
        # The skipped duplicate never consumed a budget slot or called the graph.
        self.assertEqual(get_graph.return_value.invoke.call_count, 1)


def _org_limits(**overrides):
    """A full org_limits.OrgDynamicAgentLimits with generous defaults,
    overriding only the fields a given test cares about — so adding a new
    field (as Sub-step C just did) never requires touching every existing
    call site that mocks org_limits.resolve()."""
    from app.agent.dynamic.org_limits import OrgDynamicAgentLimits

    defaults = dict(
        max_depth=2, max_agents_per_request=6, max_execution_seconds=180,
        max_retries=2, max_model_calls=40, max_tool_calls=60, max_tokens=500_000, max_cost_usd=2.0,
    )
    defaults.update(overrides)
    return OrgDynamicAgentLimits(**defaults)


class OrgLimitsIntegrationTests(unittest.TestCase):
    """Confirms master_agent.run_task() actually threads whatever
    org_limits.resolve() returns through the whole recursive tree — not a
    re-test of org_limits' own resolve/clamp/cache logic (see
    test_dynamic_agents_org_limits.py for that)."""

    def test_a_resolved_per_organization_max_depth_of_zero_forces_direct_execution(self):
        plan = {
            "decompose": True, "direct_tools": ["crm_deal"],
            "sub_agents": [{"name": "x", "task_description": "x", "tools": []}],
        }
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch(
            "app.agent.dynamic.master_agent.org_limits.resolve", return_value=_org_limits(max_depth=0)
        ) as resolve:
            get_graph.return_value.invoke.return_value = _fake_graph_result("direct")
            result = master_agent.run_task(
                "task", organization_id="org-tight", user_id="u1", conversation_id="c1", request_id="r1"
            )

        resolve.assert_called_once_with("org-tight")
        self.assertEqual(len(result["agents"]), 1)
        self.assertNotEqual(result["agents"][0].name, "x")

    def test_a_resolved_per_organization_agent_budget_is_honored(self):
        plan = {
            "decompose": True, "direct_tools": [],
            "sub_agents": [
                {"name": "a", "task_description": "a", "tools": []},
                {"name": "b", "task_description": "b", "tools": []},
            ],
        }
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch(
            "app.agent.dynamic.master_agent.org_limits.resolve", return_value=_org_limits(max_agents_per_request=1)
        ):
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            result = master_agent.run_task(
                "task", organization_id="org-tight", user_id="u1", conversation_id="c1", request_id="r1"
            )

        self.assertEqual(len(result["agents"]), 1)
        self.assertEqual(result["agents"][0].name, "a")


class RetryTests(unittest.TestCase):
    """Phase 2.5, Sub-step B — see master_agent._execute_leaf_with_retry's
    own docstring for why retrying the whole leaf is safe (tool_policy's
    write-action lockdown guarantees no irreversible side effect could have
    already completed on an earlier attempt)."""

    def test_retry_success_a_transient_failure_followed_by_a_success_is_returned_as_done(self):
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        calls = []

        def fake_invoke(state):
            calls.append(1)
            if len(calls) == 1:
                raise ConnectionError("transient blip")
            return _fake_graph_result("recovered")

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch("app.agent.dynamic.master_agent.time.sleep") as sleep:
            get_graph.return_value.invoke.side_effect = fake_invoke
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        agent = result["agents"][0]
        self.assertEqual(agent.status, "done")
        self.assertEqual(agent.result, "recovered")
        self.assertEqual(agent.retry_count, 1)
        self.assertEqual(len(agent.retry_history), 1)
        self.assertIn("transient blip", agent.retry_history[0])
        sleep.assert_called_once()

    def test_retry_exhaustion_a_persistent_failure_gives_up_after_max_retries(self):
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch("app.agent.dynamic.master_agent.time.sleep"), patch(
            "app.agent.dynamic.master_agent.limits.MAX_RETRIES", 2
        ):
            get_graph.return_value.invoke.side_effect = ConnectionError("always fails")
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        agent = result["agents"][0]
        self.assertEqual(agent.status, "failed")
        self.assertEqual(agent.retry_count, 2)
        self.assertEqual(get_graph.return_value.invoke.call_count, 3)  # the original attempt + 2 retries

    def test_structural_skips_are_never_retried_budget_exhausted(self):
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch("app.agent.dynamic.master_agent.time.sleep") as sleep, patch(
            "app.agent.dynamic.master_agent.limits.MAX_AGENTS_PER_REQUEST", 0
        ):
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        agent = result["agents"][0]
        self.assertEqual(agent.error, "agent budget exhausted")
        self.assertEqual(agent.retry_count, 0)
        get_graph.return_value.invoke.assert_not_called()
        sleep.assert_not_called()

    def test_cancellation_mid_retry_stops_further_attempts(self):
        import threading

        cancel_event = threading.Event()
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}

        def fake_invoke(state):
            cancel_event.set()  # simulate cancellation arriving during the first attempt
            raise ConnectionError("fails, and now cancelled")

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch("app.agent.dynamic.master_agent.time.sleep") as sleep:
            get_graph.return_value.invoke.side_effect = fake_invoke
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                cancel_event=cancel_event,
            )

        agent = result["agents"][0]
        self.assertEqual(agent.retry_count, 0)  # never retried once cancellation was observed
        self.assertEqual(get_graph.return_value.invoke.call_count, 1)
        sleep.assert_not_called()

    def test_a_deadline_that_elapses_between_attempts_stops_further_retries(self):
        # The leaf's FIRST attempt starts before the deadline (so it's
        # actually attempted once), then the deadline is crossed before the
        # retry-decision check — confirms retry respects the SAME shared
        # deadline _run_agent itself checks, not a separate unbounded one.
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        now = [0.0]

        def fail_after_the_deadline(state):
            now[0] = 100.0
            raise ConnectionError("fails")

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch("app.agent.dynamic.master_agent.time.sleep") as sleep, patch(
            "app.agent.dynamic.master_agent.time.monotonic", side_effect=lambda: now[0]
        ):
            get_graph.return_value.invoke.side_effect = fail_after_the_deadline
            result = master_agent.run_task(
                "task", organization_id="org-deadline-retry-test", user_id="u1", conversation_id="c1", request_id="r1",
                _deadline=50.0,
            )

        agent = result["agents"][0]
        self.assertEqual(agent.status, "failed")
        self.assertIn("fails", agent.error)
        self.assertEqual(agent.retry_count, 0)
        get_graph.return_value.invoke.assert_called_once()
        sleep.assert_not_called()


class ExecutionLimitDimensionsTests(unittest.TestCase):
    """Phase 2.5, Sub-step C — model-call/tool-call/token/cost ceilings,
    the 4 remaining execution-limit dimensions beyond depth/agents/seconds/
    retries. Deliberately sequential (two agents run one after another via
    direct _run_agent calls, not concurrent siblings) so the "second agent
    is blocked" assertion is deterministic rather than a thread-scheduling
    race — same technique CancellationTests already uses."""

    def _run_two_sequential_agents(self, *, model_calls=None, tool_calls=None, max_tokens=None, max_cost_usd=None, invoke_return):
        from app.agent.dynamic.dynamic_agent import DynamicAgent

        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            def reserving_invoke(state):
                # What the real planner_node/tools_node do for this many rounds and tools.
                for _ in range(invoke_return.get("rounds", 0) + 1):
                    state["usage_limiter"].reserve_model_call()
                for _ in invoke_return.get("tools_used", []):
                    state["usage_limiter"].try_reserve_tool_call()
                return invoke_return

            get_graph.return_value.invoke.side_effect = reserving_invoke
            first = DynamicAgent(name="first", task_description="first task", allowed_tools=[], depth=1)
            master_agent._run_agent(
                first, organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                base_messages=[], cancel_event=None, on_event=None,
                budget=master_agent._Budget(10), deadline=time.monotonic() + 60, max_depth=2,
                model_calls=model_calls, tool_calls=tool_calls, max_tokens=max_tokens, max_cost_usd=max_cost_usd,
            )
            second = DynamicAgent(name="second", task_description="second task", allowed_tools=[], depth=1)
            master_agent._run_agent(
                second, organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                base_messages=[], cancel_event=None, on_event=None,
                budget=master_agent._Budget(10), deadline=time.monotonic() + 60, max_depth=2,
                model_calls=model_calls, tool_calls=tool_calls, max_tokens=max_tokens, max_cost_usd=max_cost_usd,
            )
        return first, second, get_graph

    def test_model_call_budget_exhausted_by_the_first_agent_blocks_the_second(self):
        invoke_return = {"messages": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}], "rounds": 0}
        model_calls = master_agent._RunningTotal(2)  # the first agent's planning call + its 1 round use it up
        first, second, get_graph = self._run_two_sequential_agents(model_calls=model_calls, invoke_return=invoke_return)

        self.assertEqual(first.status, "done")
        self.assertEqual(second.status, "failed")
        self.assertEqual(second.error, "model-call budget exceeded")
        self.assertEqual(get_graph.return_value.invoke.call_count, 1)  # the second agent never actually ran

    def test_tool_call_budget_exhausted_by_the_first_agent_blocks_the_second(self):
        invoke_return = {
            "messages": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}],
            "tools_used": ["crm_deal", "crm_note"],
        }
        tool_calls = master_agent._RunningTotal(2)  # exactly what the first agent's own 2 tool calls produce
        first, second, get_graph = self._run_two_sequential_agents(tool_calls=tool_calls, invoke_return=invoke_return)

        self.assertEqual(first.status, "done")
        self.assertEqual(second.status, "failed")
        self.assertEqual(second.error, "tool-call budget exceeded")
        self.assertEqual(get_graph.return_value.invoke.call_count, 1)

    def test_model_and_tool_call_totals_accumulate_correctly_across_both_agents(self):
        invoke_return = {
            "messages": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}],
            "rounds": 2, "tools_used": ["crm_deal"],
        }
        model_calls = master_agent._RunningTotal(100)  # generous — this test is about the accumulated total, not blocking
        tool_calls = master_agent._RunningTotal(100)
        self._run_two_sequential_agents(model_calls=model_calls, tool_calls=tool_calls, invoke_return=invoke_return)

        self.assertEqual(model_calls.total, 8)  # 1 planning call + (2 rounds + 1) per agent, twice
        self.assertEqual(tool_calls.total, 2)  # 1 tool call per agent, twice

    def test_token_and_cost_budget_exceeded_blocks_a_new_agent_from_starting(self):
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch(
            "app.agent.dynamic.master_agent.usage_tracker.current_usage", return_value=(999_999, 999.0)
        ):
            from app.agent.dynamic.dynamic_agent import DynamicAgent

            agent = DynamicAgent(name="x", task_description="x", allowed_tools=[], depth=1)
            master_agent._run_agent(
                agent, organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                base_messages=[], cancel_event=None, on_event=None,
                budget=master_agent._Budget(10), deadline=time.monotonic() + 60, max_depth=2,
                max_tokens=500_000, max_cost_usd=2.0,
            )

        self.assertEqual(agent.status, "failed")
        self.assertEqual(agent.error, "token/cost budget exceeded")
        get_graph.return_value.invoke.assert_not_called()

    def test_token_and_cost_checks_are_skipped_entirely_when_not_configured(self):
        # Both must be set together to activate the check (see _run_agent) —
        # confirms a caller that only cares about the other limit dimensions
        # (every test in this file before Sub-step C) never pays for a
        # Mongo round-trip it didn't ask for.
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch("app.agent.dynamic.master_agent.usage_tracker.current_usage") as current_usage:
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            from app.agent.dynamic.dynamic_agent import DynamicAgent

            agent = DynamicAgent(name="x", task_description="x", allowed_tools=[], depth=1)
            master_agent._run_agent(
                agent, organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                base_messages=[], cancel_event=None, on_event=None,
                budget=master_agent._Budget(10), deadline=time.monotonic() + 60, max_depth=2,
                max_tokens=None, max_cost_usd=None,
            )

        current_usage.assert_not_called()
        self.assertEqual(agent.status, "done")


_ANSWER_SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}


class StructuredOutputTests(unittest.TestCase):
    """Phase 2.5, Sub-step E — DynamicAgent.expected_output_schema, set by
    the parent's own decomposition decision, validated in _execute_leaf
    via the same Draft7Validator app.tools.registry already uses."""

    def _run_leaf_with_schema(self, *, result_text, schema=_ANSWER_SCHEMA, max_retries=0):
        from app.agent.dynamic.dynamic_agent import DynamicAgent

        agent = DynamicAgent(name="x", task_description="x", allowed_tools=[], depth=1, expected_output_schema=schema)
        with patch("app.agent.dynamic.master_agent.get_graph") as get_graph, patch(
            "app.agent.dynamic.master_agent.time.sleep"
        ):
            get_graph.return_value.invoke.return_value = _fake_graph_result(result_text)
            master_agent._execute_leaf_with_retry(
                agent, [], "u1", "org-1", "c1", "r1", None, None, time.monotonic() + 60, max_retries=max_retries,
            )
        return agent, get_graph

    def test_valid_structured_output_passes_validation(self):
        agent, _ = self._run_leaf_with_schema(result_text='{"answer": "ok"}')
        self.assertEqual(agent.status, "done")
        self.assertIsNone(agent.error)

    def test_invalid_json_output_is_a_permanent_failure(self):
        agent, get_graph = self._run_leaf_with_schema(result_text="not valid json at all", max_retries=1)
        self.assertEqual(agent.status, "failed")
        self.assertIn("wasn't valid JSON", agent.error)
        self.assertEqual(get_graph.return_value.invoke.call_count, 1)

    def test_output_not_matching_the_schema_is_also_a_permanent_failure(self):
        agent, get_graph = self._run_leaf_with_schema(result_text='{"wrong_field": "ok"}', max_retries=1)
        self.assertEqual(agent.status, "failed")
        self.assertIn("did not match the expected schema", agent.error)
        self.assertEqual(get_graph.return_value.invoke.call_count, 1)

    def test_the_task_text_sent_to_the_graph_includes_the_schema_instruction(self):
        from app.agent.dynamic.dynamic_agent import DynamicAgent

        agent = DynamicAgent(name="x", task_description="write a report", allowed_tools=[], depth=1, expected_output_schema=_ANSWER_SCHEMA)
        with patch("app.agent.dynamic.master_agent.get_graph") as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result('{"answer": "ok"}')
            master_agent._execute_leaf(agent, [], "u1", "org-1", "c1", "r1", None, None)

        sent_text = get_graph.return_value.invoke.call_args[0][0]["messages"][-1]["content"][0]["text"]
        self.assertIn("write a report", sent_text)
        self.assertIn("valid JSON", sent_text)
        self.assertIn('"answer"', sent_text)


class NewStreamingEventsTests(unittest.TestCase):
    """Phase 2.5, Sub-step E's remaining spec-named events: understanding,
    tool_execution, agent_completed, validation — all additive, alongside
    the existing agent_progress/delegation_started/agent_created."""

    def test_understanding_event_carries_the_planners_own_reasoning(self):
        plan = {"decompose": False, "direct_tools": [], "sub_agents": [], "reasoning": "this is a simple lookup task"}
        events = []
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                on_event=events.append,
            )

        understanding = [e for e in events if e.get("type") == "understanding"]
        self.assertEqual(len(understanding), 1)
        self.assertEqual(understanding[0]["text"], "this is a simple lookup task")

    def test_tool_execution_event_forwards_progress_tagged_with_this_agents_identity_never_raw_deltas(self):
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        events = []

        def fake_invoke(state):
            state["on_event"]({"type": "progress", "tool": "crm_deal"})
            state["on_event"]({"type": "delta", "text": "some token"})  # must never be forwarded
            return _fake_graph_result("ok")

        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.side_effect = fake_invoke
            result = master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                on_event=events.append,
            )

        agent_id = result["agents"][0].id
        tool_events = [e for e in events if e.get("type") == "tool_execution"]
        self.assertEqual(tool_events, [{"type": "tool_execution", "agent": "agent-depth0", "agent_id": agent_id, "tool": "crm_deal"}])
        self.assertFalse(any(e.get("type") == "delta" for e in events))

    def test_agent_completed_is_emitted_on_success_but_never_on_failure(self):
        plan = {"decompose": False, "direct_tools": [], "sub_agents": []}
        success_events = []
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                on_event=success_events.append,
            )
        self.assertTrue(any(e.get("type") == "agent_completed" for e in success_events))

        failure_events = []
        with patch("app.agent.dynamic.master_agent.anthropic_client.plan_dynamic_delegation", return_value=plan), patch(
            "app.agent.dynamic.master_agent.get_graph"
        ) as get_graph, patch("app.agent.dynamic.master_agent.time.sleep"):
            get_graph.return_value.invoke.side_effect = RuntimeError("boom")
            master_agent.run_task(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1",
                on_event=failure_events.append,
            )
        self.assertFalse(any(e.get("type") == "agent_completed" for e in failure_events))

    def test_validation_event_fires_on_both_pass_and_fail(self):
        from app.agent.dynamic.dynamic_agent import DynamicAgent

        events = []
        agent = DynamicAgent(name="x", task_description="x", allowed_tools=[], depth=1, expected_output_schema=_ANSWER_SCHEMA)
        with patch("app.agent.dynamic.master_agent.get_graph") as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result('{"answer": "ok"}')
            master_agent._execute_leaf(agent, [], "u1", "org-1", "c1", "r1", None, events.append)
        self.assertIn({"type": "validation", "agent": "x", "agent_id": agent.id, "status": "passed"}, events)

        events.clear()
        agent2 = DynamicAgent(name="y", task_description="y", allowed_tools=[], depth=1, expected_output_schema=_ANSWER_SCHEMA)
        with patch("app.agent.dynamic.master_agent.get_graph") as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("not json")
            master_agent._execute_leaf(agent2, [], "u1", "org-1", "c1", "r1", None, events.append)
        self.assertIn({"type": "validation", "agent": "y", "agent_id": agent2.id, "status": "failed"}, events)


class ProviderFieldTests(unittest.TestCase):
    """Phase 2.5, Sub-step F — provider-compatibility prep only; the field
    is real and threaded through, but always resolves to "anthropic"
    today (see DynamicAgent.provider's own comment for why)."""

    def test_defaults_to_anthropic_and_flows_into_the_graph_state(self):
        from app.agent.dynamic.dynamic_agent import DynamicAgent

        agent = DynamicAgent(name="x", task_description="x", allowed_tools=[], depth=1)
        self.assertEqual(agent.provider, "anthropic")
        with patch("app.agent.dynamic.master_agent.get_graph") as get_graph:
            get_graph.return_value.invoke.return_value = _fake_graph_result("ok")
            master_agent._execute_leaf(agent, [], "u1", "org-1", "c1", "r1", None, None)

        state_passed = get_graph.return_value.invoke.call_args[0][0]
        self.assertEqual(state_passed["provider"], "anthropic")

    def test_a_planner_specified_provider_is_threaded_onto_the_child_agent(self):
        top_plan = {
            "decompose": True, "direct_tools": [],
            "sub_agents": [{"name": "child", "task_description": "child task", "tools": [], "provider": "anthropic"}],
        }
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

        self.assertEqual(result["agents"][0].provider, "anthropic")


if __name__ == "__main__":
    unittest.main()

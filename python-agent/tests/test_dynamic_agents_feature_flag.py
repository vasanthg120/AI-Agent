"""Confirms:

1. app.agent.dynamic.runner is fully gated behind BOTH the deployment-wide
   DYNAMIC_AGENTS_ENABLED kill switch AND the per-organization
   org_limits.is_org_enabled() rollout gate (FeatureFlagGateTests,
   unit-level, matches this module's existing convention) — production
   rollout, built on top of Phase 2/3.
2. app.agent.orchestrator.run() wires the dynamic engine in correctly for
   Phase 3 (OrchestratorWiringTests): with the flag off, 'delegate'-mode
   requests take the EXACT unchanged fixed-specialist/single-loop path,
   the dynamic engine is never even called; with the flag on, the dynamic
   engine runs FIRST and its result is used instead of the fixed
   5-specialist fan-out; a failure in the dynamic engine (any exception)
   falls straight through to that same unchanged fixed-specialist path.

See the plan's "Dynamic Recursive Multi-Agent System" section, "Pivot"
subsection, and app/agent/orchestrator.py's own module docstring.

Plain stdlib unittest, matching this project's existing convention. Run with:
    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent import orchestrator  # noqa: E402
from app.agent.dynamic import runner  # noqa: E402
from app.agent.dynamic.dynamic_agent import DynamicAgent  # noqa: E402


class FeatureFlagGateTests(unittest.TestCase):
    def test_disabled_platform_wide_raises_without_touching_master_agent_or_checking_the_org(self):
        with patch("app.agent.dynamic.runner.ENABLED", False), patch(
            "app.agent.dynamic.runner.org_limits.is_org_enabled"
        ) as is_org_enabled, patch("app.agent.dynamic.runner.master_agent.run_task") as run_task:
            with self.assertRaises(runner.DynamicAgentsDisabledError):
                runner.run("task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1")
            run_task.assert_not_called()
            # The platform-wide kill switch short-circuits first — an org
            # that hasn't opted in yet shouldn't even need checking.
            is_org_enabled.assert_not_called()

    def test_platform_wide_enabled_but_organization_not_opted_in_still_raises(self):
        with patch("app.agent.dynamic.runner.ENABLED", True), patch(
            "app.agent.dynamic.runner.org_limits.is_org_enabled", return_value=False
        ), patch("app.agent.dynamic.runner.master_agent.run_task") as run_task:
            with self.assertRaises(runner.DynamicAgentsDisabledError):
                runner.run("task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1")
            run_task.assert_not_called()

    def test_enabled_both_platform_wide_and_for_this_organization_delegates_to_master_agent(self):
        sentinel = {"final_text": "ok", "agents": []}
        with patch("app.agent.dynamic.runner.ENABLED", True), patch(
            "app.agent.dynamic.runner.org_limits.is_org_enabled", return_value=True
        ) as is_org_enabled, patch(
            "app.agent.dynamic.runner.master_agent.run_task", return_value=sentinel
        ) as run_task:
            result = runner.run(
                "task", organization_id="org-1", user_id="u1", conversation_id="c1", request_id="r1"
            )

        is_org_enabled.assert_called_once_with("org-1")

        self.assertIs(result, sentinel)
        run_task.assert_called_once()
        self.assertEqual(run_task.call_args.kwargs["organization_id"], "org-1")
        self.assertEqual(run_task.call_args.kwargs["request_id"], "r1")


def _state_input(**overrides) -> dict:
    base = {
        "messages": [{"role": "user", "content": "please handle this multi-part business request for me"}],
        "user_id": "user-1",
        "organization_id": "org-1",
        "conversation_id": "conv-1",
        "request_id": "req-1",
    }
    base.update(overrides)
    return base


class OrchestratorWiringTests(unittest.TestCase):
    """Exercises the real app.agent.orchestrator.run() pipeline — not a
    re-test of master_agent's own recursion logic (see
    test_dynamic_agents_master.py for that), only the wiring decision of
    which path a 'delegate'-classified request actually takes."""

    def _patched_reflect_and_suggestions(self):
        return patch("app.agent.orchestrator.anthropic_client.critique_response", return_value={"complete": True}), patch(
            "app.agent.orchestrator.anthropic_client.suggest_follow_ups", return_value=[]
        )

    def test_flag_disabled_never_touches_the_dynamic_engine_at_all(self):
        critique_patch, suggest_patch = self._patched_reflect_and_suggestions()
        with patch("app.agent.orchestrator.dynamic_runner.ENABLED", False), patch(
            "app.agent.orchestrator.dynamic_runner.run"
        ) as dynamic_run, patch(
            "app.agent.orchestrator.anthropic_client.classify_request",
            return_value={"mode": "delegate", "assignments": [], "reasoning": ""},
        ), patch("app.agent.orchestrator.get_graph") as get_graph, critique_patch, suggest_patch:
            get_graph.return_value.invoke.return_value = {
                "messages": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}],
                "tools_used": [],
            }
            orchestrator.run(_state_input())

        dynamic_run.assert_not_called()
        get_graph.return_value.invoke.assert_called_once()

    def test_flag_enabled_uses_the_dynamic_engine_result_instead_of_the_fixed_specialist_fan_out(self):
        dynamic_agents = [
            DynamicAgent(name="finder", task_description="find it", allowed_tools=[], depth=1, status="done", result="part one", tools_used=["crm_deal"]),
            DynamicAgent(name="writer", task_description="write it", allowed_tools=[], depth=1, status="done", result="part two", tools_used=[]),
        ]
        critique_patch, suggest_patch = self._patched_reflect_and_suggestions()
        with patch("app.agent.orchestrator.dynamic_runner.ENABLED", True), patch(
            "app.agent.orchestrator.dynamic_runner.run", return_value={"agents": dynamic_agents}
        ) as dynamic_run, patch(
            "app.agent.orchestrator.anthropic_client.classify_request",
            # Fixed assignments are deliberately non-empty here too, to prove
            # the dynamic engine takes priority even when the old path would
            # also have had something valid to run.
            return_value={"mode": "delegate", "assignments": [{"agent": "crm", "task": "x"}], "reasoning": ""},
        ), patch("app.agent.orchestrator._run_specialist") as run_specialist, patch(
            "app.agent.orchestrator.get_graph"
        ) as get_graph, patch(
            "app.agent.orchestrator.anthropic_client.call"
        ) as synth_call, critique_patch, suggest_patch:
            synth_call.return_value = [
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "combined answer"}]}
            ]
            orchestrator.run(_state_input())

        dynamic_run.assert_called_once()
        self.assertEqual(dynamic_run.call_args.kwargs["organization_id"], "org-1")
        self.assertEqual(dynamic_run.call_args.kwargs["request_id"], "req-1")
        # The fixed 5-specialist fan-out and the plain single-loop path were
        # never reached — the dynamic engine's result was used instead.
        run_specialist.assert_not_called()
        get_graph.assert_not_called()
        # The synthesis call actually saw both dynamic agents' findings.
        synth_prompt = synth_call.call_args[0][0]
        synth_text = str(synth_prompt)
        self.assertIn("part one", synth_text)
        self.assertIn("part two", synth_text)

    def test_dynamic_engine_single_agent_result_skips_the_synthesis_call(self):
        dynamic_agents = [
            DynamicAgent(name="agent-depth0", task_description="t", allowed_tools=[], depth=0, status="done", result="only answer", tools_used=[]),
        ]
        critique_patch, suggest_patch = self._patched_reflect_and_suggestions()
        with patch("app.agent.orchestrator.dynamic_runner.ENABLED", True), patch(
            "app.agent.orchestrator.dynamic_runner.run", return_value={"agents": dynamic_agents}
        ), patch(
            "app.agent.orchestrator.anthropic_client.classify_request",
            return_value={"mode": "delegate", "assignments": [], "reasoning": ""},
        ), patch("app.agent.orchestrator.anthropic_client.call") as synth_call, critique_patch, suggest_patch:
            result = orchestrator.run(_state_input())

        synth_call.assert_not_called()
        self.assertEqual(orchestrator.final_text(result), "only answer")

    def test_dynamic_engine_failure_falls_back_to_the_fixed_specialist_path(self):
        critique_patch, suggest_patch = self._patched_reflect_and_suggestions()
        fake_finding = {"agent": "crm", "task": "x", "output": "specialist answer", "tools_used": []}
        with patch("app.agent.orchestrator.dynamic_runner.ENABLED", True), patch(
            "app.agent.orchestrator.dynamic_runner.run", side_effect=RuntimeError("boom")
        ), patch(
            "app.agent.orchestrator.anthropic_client.classify_request",
            return_value={"mode": "delegate", "assignments": [{"agent": "crm", "task": "x"}], "reasoning": ""},
        ), patch("app.agent.orchestrator._run_specialist", return_value=fake_finding) as run_specialist, patch(
            "app.agent.orchestrator.anthropic_client.call"
        ) as synth_call, critique_patch, suggest_patch:
            synth_call.return_value = [
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "fallback answer"}]}
            ]
            orchestrator.run(_state_input())

        run_specialist.assert_called_once()


if __name__ == "__main__":
    unittest.main()

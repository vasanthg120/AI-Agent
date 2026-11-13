"""Regression test for app.agent.orchestrator's Phase C routing check: a
Groq call known-exhausted (admin-marked, or the NestJS alert cron's own
estimated-balance check) is skipped entirely rather than spending a real
network call certain to fail the same way the last one did — falling
through to the same Claude path a real Groq failure already falls through
to today, unchanged.

Mocks only what's needed to reach this one decision point: trivial_router's
plan (forced to 'general' mode, the only branch that attempts Groq at all),
groq_client.call itself, provider_account_status.is_exhausted, and the
graph/reflect/suggestions calls on the fallthrough path (which would
otherwise need a real Anthropic key) — everything else in orchestrator.run()
is untouched and still real code.

Plain stdlib unittest, matching this project's existing test style. Run with:
    .venv/Scripts/python.exe -m pytest tests/test_orchestrator_provider_skip.py -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.agent.orchestrator as orchestrator  # noqa: E402

GENERAL_PLAN = {"mode": "general", "assignments": [], "reasoning": ""}
STATE_INPUT = {"messages": [{"role": "user", "content": "hi"}], "user_id": "u1", "conversation_id": "c1"}


class OrchestratorProviderSkipTests(unittest.TestCase):
    def test_a_known_exhausted_groq_is_never_called_and_falls_through_to_claude(self):
        with (
            patch("app.agent.orchestrator.trivial_router.trivial_plan", return_value=GENERAL_PLAN),
            patch("app.agent.orchestrator.provider_account_status.is_exhausted", return_value=True) as is_exhausted,
            patch("app.agent.orchestrator.groq_client.call") as groq_call,
            patch("app.agent.orchestrator.get_graph") as get_graph,
            patch("app.agent.orchestrator._reflect", side_effect=lambda _state, messages, tools_used: {"messages": messages, "tools_used": tools_used}),
            patch("app.agent.orchestrator._attach_suggestions", side_effect=lambda _state, result: result),
        ):
            get_graph.return_value.invoke.return_value = {"messages": [{"role": "assistant", "content": "claude answer"}], "tools_used": []}

            result = orchestrator.run(STATE_INPUT)

            is_exhausted.assert_called_once_with("groq")
            groq_call.assert_not_called()
            get_graph.return_value.invoke.assert_called_once()
            self.assertEqual(result["messages"][0]["content"], "claude answer")

    def test_a_healthy_groq_is_still_called_normally_when_not_exhausted(self):
        with (
            patch("app.agent.orchestrator.trivial_router.trivial_plan", return_value=GENERAL_PLAN),
            patch("app.agent.orchestrator.provider_account_status.is_exhausted", return_value=False),
            patch("app.agent.orchestrator.groq_client.call", return_value=[{"role": "assistant", "content": "groq answer"}]) as groq_call,
            patch("app.agent.orchestrator.get_graph") as get_graph,
        ):
            result = orchestrator.run(STATE_INPUT)

            groq_call.assert_called_once()
            get_graph.return_value.invoke.assert_not_called()  # the fast path returned directly, no fallthrough needed
            self.assertEqual(result["messages"][0]["content"], "groq answer")


if __name__ == "__main__":
    unittest.main()

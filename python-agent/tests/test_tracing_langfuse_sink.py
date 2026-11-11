"""Regression test for the non-blocking guarantee app.observability.tracing's
traced_llm_call/traced_tool_call make about their new Langfuse sink: a
Langfuse failure (bad client, network error, SDK bug — anything) must never
break the real LLM/tool call, never lose the existing Mongo agent_executions
write, and never change what the caller's `with` block actually returns.

This is section 12 of the integration spec made concrete: "Observability
failures must never: Block Claude calls... Block Groq calls... Stop
LangGraph execution... Change customer billing." The Mongo write backs
billing settlement (reservation.service.ts sums agent_executions by
requestId) — if a broken Langfuse sink took that write down too, billing
would silently stop working the moment Langfuse had a bad day.

Plain stdlib unittest, matching this project's existing test style (see
tests/test_organization_isolation.py). Run with:
    .venv/Scripts/python.exe -m pytest tests/test_tracing_langfuse_sink.py -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.observability.tracing as tracing  # noqa: E402


class FakeAgentExecutions:
    def __init__(self):
        self.inserted = []

    def insert_one(self, doc):
        self.inserted.append(doc)


class FakeDb:
    def __init__(self):
        self.agent_executions = FakeAgentExecutions()


class TracingLangfuseSinkTests(unittest.TestCase):
    def test_traced_llm_call_survives_a_raising_langfuse_sink(self):
        fake_db = FakeDb()
        with (
            patch("app.observability.execution_store.get_db", return_value=fake_db),
            patch("app.core.langfuse_config.record_llm_generation", side_effect=RuntimeError("Langfuse is on fire")),
        ):
            with tracing.traced_llm_call("test", provider="anthropic", model="claude-x") as usage:
                usage["input_tokens"] = 42
                usage["output_tokens"] = 7
                result = "the real LLM response, untouched"

        # The actual call's result is exactly what the caller produced —
        # nothing about the broken Langfuse sink leaked into it.
        self.assertEqual(result, "the real LLM response, untouched")
        # The Mongo write the AI Usage dashboard and billing settlement
        # depend on still happened, with the real token counts, and with
        # langfuseTraceId/Url honestly null rather than a fabricated value.
        self.assertEqual(len(fake_db.agent_executions.inserted), 1)
        row = fake_db.agent_executions.inserted[0]
        self.assertEqual(row["inputTokens"], 42)
        self.assertEqual(row["outputTokens"], 7)
        self.assertIsNone(row["langfuseTraceId"])
        self.assertIsNone(row["langfuseTraceUrl"])

    def test_traced_llm_call_survives_the_llm_call_itself_raising(self):
        """A real LLM-call exception must still propagate unchanged even with
        a broken Langfuse sink alongside it — observability must never mask
        a genuine failure, only ever add to what's recorded about it."""
        fake_db = FakeDb()
        with (
            patch("app.observability.execution_store.get_db", return_value=fake_db),
            patch("app.core.langfuse_config.record_llm_generation", side_effect=RuntimeError("Langfuse is on fire")),
        ):
            with self.assertRaises(ValueError):
                with tracing.traced_llm_call("test", provider="anthropic", model="claude-x"):
                    raise ValueError("the real provider error")

        self.assertEqual(len(fake_db.agent_executions.inserted), 1)
        self.assertFalse(fake_db.agent_executions.inserted[0]["success"])

    def test_traced_tool_call_survives_a_raising_langfuse_sink(self):
        fake_db = FakeDb()
        with (
            patch("app.observability.execution_store.get_db", return_value=fake_db),
            patch("app.core.langfuse_config.record_tool_span", side_effect=RuntimeError("Langfuse is on fire")),
        ):
            with tracing.traced_tool_call("test_tool", "user-1") as outcome:
                outcome["success"] = True
                result = "the real tool result"

        self.assertEqual(result, "the real tool result")
        self.assertEqual(len(fake_db.agent_executions.inserted), 1)
        self.assertTrue(fake_db.agent_executions.inserted[0]["success"])


if __name__ == "__main__":
    unittest.main()

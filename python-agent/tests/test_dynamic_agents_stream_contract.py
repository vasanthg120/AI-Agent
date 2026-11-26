"""The streaming contract, produced by the REAL engine and orchestrator adapter
(only the planner and the leaf graph are faked), then serialised exactly as
app.routes.chat does. The result is pinned in
tests/fixtures/dynamic_stream_contract.json, which the NestJS tests feed
through the real ChatService and ChatGateway.

After an intentional contract change, regenerate with
UPDATE_STREAM_CONTRACT=1 and re-run the NestJS and frontend tests.
"""

import json
import os
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent import orchestrator  # noqa: E402
from app.agent.dynamic import master_agent, stream_events  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "dynamic_stream_contract.json"
M = "app.agent.dynamic.master_agent"
SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz012345"
PRIVATE = ("PRIVATE-REASONING", "PRIVATE-RESULT", "PRIVATE-TASK", "PRIVATE-ARGUMENT", "PRIVATE-ERROR", SECRET)


def _produce_events() -> tuple[list[dict], list[dict]]:
    """One sub-agent that retries, uses a tool, passes validation and finishes,
    and a duplicate of it that is skipped (a single running child keeps the
    event order deterministic)."""
    schema = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}

    def plan(task, **kwargs):
        if task != "root":
            return {"decompose": False, "reasoning": "PRIVATE-REASONING"}
        return {
            "decompose": True,
            "reasoning": "PRIVATE-REASONING",
            "sub_agents": [
                {"name": "CRM lookup", "task_description": "PRIVATE-TASK", "tools": ["crm_deal"], "output_schema": schema},
                {"name": f"Copy {SECRET}", "task_description": "PRIVATE-TASK", "tools": []},
            ],
        }

    attempts = []

    def invoke(state):
        attempts.append(1)
        if len(attempts) == 1:
            raise ConnectionError("PRIVATE-ERROR")
        state["on_event"]({"type": "progress", "tool": "crm_deal", "arguments": "PRIVATE-ARGUMENT"})
        state["on_event"]({"type": "delta", "text": "PRIVATE-RESULT"})
        reply = json.dumps({"answer": "PRIVATE-RESULT"})
        return {"messages": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": reply}]}]}

    internal: list[dict] = []
    sent: list[dict] = []
    adapter = orchestrator._dynamic_event_adapter(sent.append)

    def on_event(event):
        internal.append(event)
        adapter(event)

    with patch(f"{M}.anthropic_client.plan_dynamic_delegation", side_effect=plan), patch(f"{M}.get_graph") as graph, patch(
        f"{M}.usage_tracker.current_usage", return_value=(0, 0.0)
    ), patch(f"{M}.time.sleep"):
        graph.return_value.invoke.side_effect = invoke
        master_agent.run_task(
            "root", organization_id=None, user_id="u1", conversation_id="c1", request_id="r1", on_event=on_event
        )
    return internal, sent


def _stable_ids(events: list[dict]) -> list[dict]:
    seen: dict[str, str] = {}
    text = json.dumps(events, ensure_ascii=False)
    for found in re.findall(r"dyn-[0-9a-f]{12}", text):
        seen.setdefault(found, f"dyn-{len(seen) + 1:012d}")
    for real, stable in seen.items():
        text = text.replace(real, stable)
    return json.loads(text)


class StreamContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.internal, cls.sent = _produce_events()

    def test_output_matches_the_pinned_contract(self):
        actual = _stable_ids(self.sent)
        if os.environ.get("UPDATE_STREAM_CONTRACT"):
            FIXTURE.parent.mkdir(exist_ok=True)
            FIXTURE.write_text(json.dumps(actual, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        self.assertEqual(actual, json.loads(FIXTURE.read_text(encoding="utf-8")))

    def test_every_lifecycle_state_is_reported(self):
        seen = {(e["type"], e.get("status")) for e in self.sent}
        for expected in [
            ("plan", None), ("reasoning", None), ("progress", None), ("agent_done", None), ("agent_created", None),
            ("agent_progress", "running"), ("agent_progress", "retrying"), ("agent_progress", "failed"),
            ("validation", "passed"),
        ]:
            self.assertIn(expected, seen)

    def test_nothing_private_reaches_the_client(self):
        # The internal events really do carry this material...
        self.assertIn("PRIVATE-REASONING", json.dumps(self.internal))
        self.assertIn("PRIVATE-RESULT", json.dumps(self.internal))
        # ...and none of it is in anything sent.
        wire = json.dumps(self.sent)
        for marker in PRIVATE:
            self.assertNotIn(marker, wire)

    def test_no_internal_event_is_sent_twice(self):
        translated = [stream_events.to_client_event(e) for e in self.internal]
        self.assertEqual(self.sent, [e for e in translated if e is not None])
        types = [e["type"] for e in self.sent]
        self.assertFalse({"agent_completed", "delegation_started", "understanding", "tool_execution"} & set(types))
        self.assertEqual(types.count("agent_done"), 1)
        self.assertEqual(types.count("progress"), 1)
        self.assertEqual(types.count("plan"), 1)

    def test_unknown_malformed_or_unsafe_events_are_dropped(self):
        for event in [
            {}, {"type": "future_event", "result": "x"}, {"type": "delta", "text": "x"},
            {"type": "agent_progress", "agent": "a", "status": "done?"}, {"type": "validation", "status": "maybe"},
            {"type": "tool_execution", "tool": "not_a_registered_tool"},
        ]:
            with self.subTest(event=event):
                self.assertIsNone(stream_events.to_client_event(event))


if __name__ == "__main__":
    unittest.main()

"""Tests for app.agent.dynamic.usage_tracker — Phase 2.5 Sub-step C's
token/cost running-total source, reused from Phase 4's own persisted
agent_executions rows rather than new plumbing into the LLM call chain.

Plain stdlib unittest, matching this project's existing convention. Run with:
    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent.dynamic import usage_tracker  # noqa: E402


class CurrentUsageTests(unittest.TestCase):
    def test_empty_request_id_returns_zero_without_touching_mongo(self):
        with patch("app.agent.dynamic.usage_tracker.get_db") as get_db:
            tokens, cost = usage_tracker.current_usage("")

        self.assertEqual((tokens, cost), (0, 0.0))
        get_db.assert_not_called()

    def test_no_rows_yet_returns_zero(self):
        with patch("app.agent.dynamic.usage_tracker.get_db") as get_db:
            get_db.return_value.agent_executions.aggregate.return_value = []
            tokens, cost = usage_tracker.current_usage("req-1")

        self.assertEqual((tokens, cost), (0, 0.0))

    def test_sums_tokens_and_cost_from_the_aggregation_result(self):
        with patch("app.agent.dynamic.usage_tracker.get_db") as get_db:
            get_db.return_value.agent_executions.aggregate.return_value = [{"tokens": 1500, "cost": 0.42}]
            tokens, cost = usage_tracker.current_usage("req-1")

        self.assertEqual(tokens, 1500)
        self.assertAlmostEqual(cost, 0.42)

    def test_only_matches_llm_kind_rows_never_tool_rows(self):
        with patch("app.agent.dynamic.usage_tracker.get_db") as get_db:
            get_db.return_value.agent_executions.aggregate.return_value = [{"tokens": 100, "cost": 0.1}]
            usage_tracker.current_usage("req-1")

        pipeline = get_db.return_value.agent_executions.aggregate.call_args[0][0]
        self.assertEqual(pipeline[0]["$match"], {"requestId": "req-1", "kind": "llm"})

    def test_a_mongo_failure_returns_zero_instead_of_raising(self):
        with patch("app.agent.dynamic.usage_tracker.get_db", side_effect=RuntimeError("mongo down")):
            tokens, cost = usage_tracker.current_usage("req-1")

        self.assertEqual((tokens, cost), (0, 0.0))


if __name__ == "__main__":
    unittest.main()

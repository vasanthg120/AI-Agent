import unittest
from unittest import mock

from app.agent import anthropic_client
from app.agent.anthropic_client import CUSTOMER_INTELLIGENCE_TOOL, customer_intelligence


class CustomerIntelligenceToolTest(unittest.TestCase):
    """Customer 360°'s AI report: one forced, traced tool call; every statement in
    the shape must cite evidence ids (the backend then drops uncited ones)."""

    def test_every_statement_in_the_shape_asks_for_evidence(self):
        props = CUSTOMER_INTELLIGENCE_TOOL["input_schema"]["properties"]
        self.assertIn("evidence", props["buyingIntent"]["properties"])
        self.assertIn("evidence", props["sentiment"]["properties"])
        for key in ("behaviours", "preferences", "painPoints", "competitors", "insights", "recommendations"):
            item = props[key]["items"]
            self.assertIn("evidence", item["properties"], key)
            self.assertIn("evidence", item["required"], key)
        self.assertEqual(props["buyingIntent"]["properties"]["level"]["enum"], ["very_high", "high", "medium", "low", "unknown"])

    def test_runs_one_traced_forced_tool_call_with_the_records(self):
        with mock.patch.object(anthropic_client, "_run_forced_tool_extraction", return_value={"summary": "ok"}) as run:
            out = customer_intelligence({"evidence": [{"id": "E1", "kind": "call"}]}, organization_id="org-1", user_id="u-1", request_id="r-1")
        self.assertEqual(out, {"summary": "ok"})
        args, kwargs = run.call_args
        self.assertIs(args[1], CUSTOMER_INTELLIGENCE_TOOL)
        self.assertIn('"E1"', args[2][0]["text"])
        self.assertEqual((kwargs["name"], kwargs["organization_id"], kwargs["request_id"]), ("customer_intelligence", "org-1", "r-1"))


if __name__ == "__main__":
    unittest.main()

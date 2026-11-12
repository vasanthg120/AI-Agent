import unittest

from app.agent.anthropic_client import DEAL_BRIEF_TOOL

# The lead statuses NestJS accepts (backend/src/deal-insight/deal-insight.service.ts LEAD_STATUSES).
BACKEND_LEAD_STATUSES = [
    "new_lead",
    "contacted",
    "interested",
    "negotiation",
    "quote_sent",
    "awaiting_response",
    "follow_up_required",
    "payment_pending",
    "won",
    "lost",
]


class DealBriefToolTest(unittest.TestCase):
    """The deal brief's forced-tool schema: every required field is defined, and
    the lead statuses are exactly the ones the backend and the panel know."""

    def test_every_required_field_is_defined(self):
        schema = DEAL_BRIEF_TOOL["input_schema"]
        missing = [name for name in schema["required"] if name not in schema["properties"]]
        self.assertEqual(missing, [])

    def test_lead_statuses_match_the_backend(self):
        self.assertEqual(DEAL_BRIEF_TOOL["input_schema"]["properties"]["leadStatus"]["enum"], BACKEND_LEAD_STATUSES)

    def test_facts_are_kept_apart_from_conclusions(self):
        required = DEAL_BRIEF_TOOL["input_schema"]["required"]
        for name in ("observedFacts", "inferences", "nextBestAction", "recommendations", "emailInsights"):
            self.assertIn(name, required)
        action = DEAL_BRIEF_TOOL["input_schema"]["properties"]["nextBestAction"]
        self.assertEqual(action["required"], ["action", "why", "urgency", "deadline"])


if __name__ == "__main__":
    unittest.main()

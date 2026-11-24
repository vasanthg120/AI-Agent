import json
import unittest

from app.agent import briefing


class BriefingTest(unittest.TestCase):
    """Haive's spoken briefing: one forced Claude call over the facts NestJS gathered; it speaks
    only from them, and keeps actual figures apart from forecasts and advice."""

    FACTS = {
        "person": {"firstName": "Vasanth", "sees": "all_businesses"},
        "language": "ta-IN",
        "businesses": [{"name": "T.Nagar", "currency": "INR", "revenueThisMonth": {"actual": 226851, "projectedMonthEnd": 400000}}],
        "notTracked": ["payments"],
    }

    def run_with(self, answer, **options):
        calls = []

        def run(system, tool, content, **kwargs):
            calls.append({"system": system, "tool": tool, "text": content[0]["text"], **kwargs})
            return answer

        return briefing.compose_briefing(self.FACTS, organization_id="org-1", user_id="u-1", request_id="r-1", run=run, **options), calls

    def test_the_shape_labels_every_point(self):
        props = briefing.BRIEFING_TOOL["input_schema"]["properties"]
        self.assertEqual(props["points"]["items"]["properties"]["kind"]["enum"], ["actual", "estimate", "forecast", "recommendation"])
        self.assertIn("spoken", briefing.BRIEFING_TOOL["input_schema"]["required"])
        self.assertIn("ONLY the facts", briefing.BRIEFING_SYSTEM_PROMPT)
        self.assertIn("forecast", briefing.BRIEFING_SYSTEM_PROMPT)
        self.assertIn("If 'focus' is given", briefing.BRIEFING_SYSTEM_PROMPT)

    def test_sends_the_facts_and_the_language_in_one_traced_call(self):
        out, calls = self.run_with({"spoken": " Good morning, Vasanth. ", "headline": "h", "points": [], "nextAction": {"text": "x", "why": "y"}, "suggestedQuestions": ["a"]})
        self.assertEqual(out["spoken"], "Good morning, Vasanth.")
        self.assertEqual(len(calls), 1)
        self.assertIn("Speak in Tamil.", calls[0]["text"])
        self.assertEqual(json.loads(calls[0]["text"].split("use nothing else):\n", 1)[1])["businesses"][0]["name"], "T.Nagar")
        self.assertEqual((calls[0]["name"], calls[0]["organization_id"], calls[0]["request_id"]), ("assistant_briefing", "org-1", "r-1"))

    def test_the_length_follows_the_persons_style(self):
        answer = {"spoken": "Hi.", "headline": "h", "points": [], "nextAction": None, "suggestedQuestions": []}
        _, concise = self.run_with(answer)
        self.assertIn("Spoken length: 70-120 words, never more than 140.", concise[0]["text"])
        self.assertEqual(concise[0]["max_tokens"], 2000)
        _, detailed = self.run_with(answer, style="detailed")
        self.assertIn("Spoken length: 150-200 words", detailed[0]["text"])
        self.assertGreater(detailed[0]["max_tokens"], 2000)
        # Anything else is treated as concise.
        _, unknown = self.run_with(answer, style="rambling")
        self.assertIn("70-120 words", unknown[0]["text"])

    def test_actions_are_offers_kept_tidy(self):
        props = briefing.BRIEFING_TOOL["input_schema"]["properties"]
        self.assertEqual(props["actions"]["items"]["properties"]["type"]["enum"], ["give_task"])
        self.assertIn("Never say it is done", briefing.BRIEFING_SYSTEM_PROMPT)
        out, _ = self.run_with(
            {
                "spoken": "Hi.",
                "headline": "h",
                "points": [],
                "nextAction": None,
                "suggestedQuestions": [],
                "actions": [
                    {"type": "send_email", "personRef": "p1", "title": "No"},
                    {"type": "give_task", "personRef": "p1", "title": "  Reply to the enquiries ", "due": "someday"},
                    {"type": "give_task", "personRef": "", "title": "Nobody"},
                    {"type": "give_task", "personRef": "me", "title": "Call Ramesh", "due": "tomorrow"},
                    {"type": "give_task", "personRef": "p2", "title": "A third", "due": "today"},
                ],
            }
        )
        self.assertEqual(
            out["actions"],
            [
                {"type": "give_task", "personRef": "p1", "title": "Reply to the enquiries", "due": "today"},
                {"type": "give_task", "personRef": "me", "title": "Call Ramesh", "due": "tomorrow"},
            ],
        )

    def test_tidies_what_comes_back(self):
        out, _ = self.run_with(
            {
                "spoken": "Hi.",
                "headline": "Quiet day.",
                "points": [{"text": "Revenue", "kind": "guess", "severity": "info", "business": ""}, {"kind": "actual"}] + [{"text": f"p{i}", "kind": "actual", "severity": "info", "business": ""} for i in range(6)],
                "nextAction": "not an object",
                "suggestedQuestions": ["one", "", 3, "two", "three", "four", "five"],
            }
        )
        self.assertEqual(out["points"][0]["kind"], "actual")
        self.assertEqual(len(out["points"]), 5)
        self.assertIsNone(out["nextAction"])
        self.assertEqual(out["suggestedQuestions"], ["one", "two", "three", "four"])


if __name__ == "__main__":
    unittest.main()

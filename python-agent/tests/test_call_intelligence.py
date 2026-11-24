import copy
import unittest

from app.agent import call_intelligence as ci

# A short, real-shaped call: Speaker "0" is the agent, "1" the customer (Sarvam's labels).
LINES = [
    {"id": "L1", "at": 0, "speaker": "0", "text": "Hi, this is Priya from Fully Promoted, thanks for taking my call."},
    {"id": "L2", "at": 6, "speaker": "1", "text": "Sure. We need 200 polo shirts with our logo for a staff event in March."},
    {"id": "L3", "at": 14, "speaker": "0", "text": "Great. What colours are you thinking, and is March 10th the event date?"},
    {"id": "L4", "at": 22, "speaker": "1", "text": "Navy. But your price last time was too high for us, honestly."},
    {"id": "L5", "at": 30, "speaker": "0", "text": "I understand. For 200 pieces we can bring it down to 450 rupees each with embroidery."},
    {"id": "L6", "at": 41, "speaker": "1", "text": "That works. Can you send the quote today?"},
    {"id": "L7", "at": 47, "speaker": "0", "text": "Yes, I'll email the quote by 5 pm and call you tomorrow at 11 to confirm sizes."},
    {"id": "L8", "at": 55, "speaker": "1", "text": "Perfect, talk tomorrow."},
]
META = {"category": "upload", "categoryLabel": "Uploaded recording", "durationSeconds": 60, "languageCode": "en-IN", "speakersSeparated": True}

QUOTES = {
    "discovery": ("L3", "What colours are you thinking"),
    "listening": ("L3", "is March 10th the event date"),
    "product_knowledge": ("L5", "450 rupees each with embroidery"),
    "communication": ("L7", "email the quote by 5 pm"),
    "objection_handling": ("L5", "we can bring it down to 450 rupees"),
    "value_proposition": ("L5", "For 200 pieces"),
    "trust_building": ("L5", "I understand"),
    "opportunity": ("L7", "I'll email the quote by 5 pm"),
    "closure": ("L7", "call you tomorrow at 11 to confirm sizes"),
}


def draft(score=7, **overrides):
    """A complete draft as the model would return it; every category scored `score` with a real quote."""
    d = {
        "understanding": {
            "callPurpose": "Quote 200 logo polos for a staff event.",
            "context": "Returning customer who found the last price high.",
            "speakers": [{"label": "Speaker 1", "role": "agent", "basis": "introduces herself"}, {"label": "Speaker 2", "role": "customer", "basis": "states the need"}],
            "customerRequirements": ["200 navy polos with logo", "event in March"],
        },
        "analysis": {
            "customerQuestions": [{"question": "Can you send the quote today?", "lineId": "L6", "answered": "yes"}],
            "objections": [{"objection": "Price too high last time", "lineId": "L4", "handling": "well", "how": "Offered a volume price"}],
            "buyingSignals": [{"signal": "That works", "lineId": "L6", "actedOn": True}],
            "commitments": [{"by": "agent", "text": "Quote by 5 pm", "lineId": "L7", "realistic": True}],
            "communicationIssues": [],
            "customerEngagement": {"level": "high", "basis": "answers every question"},
            "customerSentiment": {"start": "neutral", "end": "positive", "basis": "Perfect, talk tomorrow"},
        },
        "categories": [
            {"key": k, "assessable": True, "notAssessableReason": "", "score": score, "rationale": f"{k} rationale", "evidence": [{"lineId": QUOTES[k][0], "quote": QUOTES[k][1], "judgement": "positive"}]}
            for k in ci.CATEGORY_KEYS
        ],
        "challenge": {"missedOpportunities": [], "seriousConcerns": [], "expertWouldHaveDone": ["Ask about future events"]},
        "conclusion": {
            "outcome": {"result": "next_step_agreed", "explanation": "Quote today, call tomorrow.", "performanceVsOutcome": "Good call, good outcome."},
            "verdict": "A tidy, effective call.",
            "strengths": [
                {"text": "Clarified the date", "lineId": "L3", "quote": "is March 10th the event date"},
                {"text": "Answered the price objection with a number", "lineId": "L5", "quote": "450 rupees each"},
                {"text": "Set a concrete next step", "lineId": "L7", "quote": "call you tomorrow at 11"},
            ],
            "weaknesses": [{"text": "Did not ask about budget", "severity": "minor", "lineId": "", "quote": "", "impact": "Price may still be off"}],
            "coaching": [{"change": "Ask budget early", "how": "Before quoting", "example": "What budget per piece works for you?"}],
            "nextActions": [{"text": "Email the quote by 5 pm", "owner": "agent", "priority": "high", "basis": "L7"}],
            "summaryForAgent": "Good call.",
            "voiceScript": "Nice work.",
        },
    }
    for path, value in overrides.items():
        holder = d
        keys = path.split(".")
        for key in keys[:-1]:
            holder = holder[key]
        holder[keys[-1]] = value
    return d


def scripted(evaluation, review=None, fail_review=False):
    """Stands in for Claude: the evaluation draft, then the review."""
    calls = []

    def run(system, tool, content, **kwargs):
        calls.append({"tool": tool["name"], "text": content[0]["text"], **kwargs})
        if tool["name"] == "evaluate_call":
            return copy.deepcopy(evaluation)
        if fail_review:
            raise RuntimeError("review down")
        return copy.deepcopy(review or {"checks": [{"check": c, "passed": True, "note": "ok"} for c in ci.QA_CHECKS], "adjustments": [], "removeClaims": [], "verdict": ""})

    run.calls = calls
    return run


def evaluate(evaluation, lines=LINES, **kw):
    run = scripted(evaluation, **kw)
    return ci.evaluate_call(lines, META, "", [], "", organization_id="org-1", user_id="u-1", run=run), run


def cat(report, key):
    return next(c for c in report["categories"] if c["key"] == key)


class FrameworkTest(unittest.TestCase):
    def test_nine_categories_weighted_to_100(self):
        self.assertEqual(len(ci.CATEGORIES), 9)
        self.assertEqual(sum(ci.WEIGHT.values()), 100)
        self.assertEqual((ci.WEIGHT["discovery"], ci.WEIGHT["objection_handling"]), (15, 15))

    def test_bands(self):
        self.assertEqual([ci.band_of(s)[0] for s in (95, 85, 75, 65, 50, 20, None)], ["exceptional", "very_good", "good", "average", "poor", "critical", "not_assessable"])

    def test_the_model_sees_numbered_timed_speaker_lines_and_never_gives_the_total(self):
        _, run = evaluate(draft())
        self.assertIn("L5 [00:30] Speaker 1: I understand.", run.calls[0]["text"])
        self.assertIn("Speakers are separated", run.calls[0]["text"])
        self.assertNotIn("score", ci.EVALUATION_TOOL["input_schema"]["properties"])
        self.assertEqual(run.calls[0]["name"], "call_intelligence_evaluate")
        self.assertEqual(run.calls[1]["name"], "call_intelligence_review")


class TooLittleToJudgeTest(unittest.TestCase):
    def test_no_speech_or_a_few_words_is_not_assessable_and_costs_no_model_call(self):
        for lines in ([], [{"id": "L1", "at": 0, "speaker": None, "text": "Hello? Hello?"}]):
            report, run = evaluate(draft(), lines=lines)
            self.assertEqual(run.calls, [])
            self.assertIsNone(report["score"])
            self.assertEqual(report["band"], "not_assessable")
            self.assertTrue(all(c["score"] is None and not c["assessable"] for c in report["categories"]))


class EvidenceTest(unittest.TestCase):
    def test_a_real_quote_keeps_the_lines_own_time_and_speaker(self):
        report, _ = evaluate(draft())
        ev = cat(report, "closure")["evidence"][0]
        self.assertEqual((ev["lineId"], ev["at"], ev["speaker"]), ("L7", 47, "Speaker 1"))

    def test_an_invented_quote_is_dropped_and_counted(self):
        d = draft()
        d["categories"][0]["evidence"] = [{"lineId": "L3", "quote": "we guarantee delivery in two days", "judgement": "positive"}]
        report, _ = evaluate(d)
        self.assertEqual(cat(report, "discovery")["evidence"], [])
        self.assertEqual(report["qa"]["quotesDropped"], 1)

    def test_the_neighbouring_line_and_left_out_words_are_accepted(self):
        d = draft()
        # Quote is in L5 but the model named L4; words left out with "...".
        d["categories"][0]["evidence"] = [{"lineId": "L4", "quote": "For 200 pieces ... 450 rupees each", "judgement": "positive"}]
        report, _ = evaluate(d)
        self.assertEqual(cat(report, "discovery")["evidence"][0]["lineId"], "L5")

    def test_praise_and_accusations_need_their_words(self):
        d = draft()
        d["conclusion"]["strengths"].append({"text": "Built huge rapport", "lineId": "L1", "quote": "you are my favourite customer"})
        d["challenge"]["seriousConcerns"] = [{"kind": "unrealistic_promise", "text": "Promised free delivery", "lineId": "L7", "quote": "free delivery anywhere"}]
        report, _ = evaluate(d)
        self.assertNotIn("Built huge rapport", [s["text"] for s in report["conclusion"]["strengths"]])
        self.assertEqual(report["challenge"]["seriousConcerns"], [])


class StrictRulesTest(unittest.TestCase):
    def test_a_high_mark_without_a_supporting_quote_is_capped(self):
        d = draft(score=9)
        d["categories"][3]["evidence"] = []  # communication, 9 with no quote
        report, _ = evaluate(d)
        self.assertEqual(cat(report, "communication")["score"], 6)
        self.assertTrue(any(a["category"] == "communication" and a["by"] == "rule" for a in report["qa"]["adjustments"]))

    def test_unhandled_objection_missed_signal_unanswered_question_and_no_next_step(self):
        d = draft(score=8)
        d["analysis"]["objections"][0]["handling"] = "not_handled"
        d["analysis"]["buyingSignals"][0]["actedOn"] = False
        d["analysis"]["customerQuestions"][0]["answered"] = "no"
        d["analysis"]["commitments"] = []
        d["conclusion"]["outcome"]["result"] = "information_only"
        report, _ = evaluate(d)
        self.assertEqual(
            [cat(report, k)["score"] for k in ("objection_handling", "opportunity", "product_knowledge", "closure")],
            [4, 6, 6, 5],
        )

    def test_a_partly_handled_objection_caps_at_seven(self):
        d = draft(score=9)
        d["analysis"]["objections"][0]["handling"] = "partly"
        report, _ = evaluate(d)
        self.assertEqual(cat(report, "objection_handling")["score"], 7)

    def test_a_serious_concern_keeps_the_call_out_of_the_good_bands(self):
        d = draft(score=8)
        d["challenge"]["seriousConcerns"] = [{"kind": "unrealistic_promise", "text": "Committed to a price without checking", "lineId": "L5", "quote": "we can bring it down to 450 rupees"}]
        report, _ = evaluate(d)
        self.assertEqual(report["score"], 59)
        self.assertEqual(report["band"], "poor")

    def test_a_critical_weakness_caps_at_average(self):
        d = draft(score=8)
        d["conclusion"]["weaknesses"] = [{"text": "Talked over the customer", "severity": "critical", "lineId": "L3", "quote": "What colours are you thinking", "impact": "Lost trust"}]
        report, _ = evaluate(d)
        self.assertEqual(report["score"], 69)


class ScoringTest(unittest.TestCase):
    def test_weighted_over_what_could_be_judged_with_coverage(self):
        d = draft(score=6)
        # Objection handling (15) can't be judged; discovery (15) is an 8.
        d["categories"][4] = {"key": "objection_handling", "assessable": False, "notAssessableReason": "No objection was raised.", "score": 0, "rationale": "", "evidence": []}
        d["categories"][0]["score"] = 8
        d["analysis"]["objections"] = []
        report, _ = evaluate(d)
        self.assertEqual(report["coverage"], 85)
        # (0.8*15 + 0.6*70) / 85 * 100 = 63.5 → 64
        self.assertEqual(report["score"], 64)
        self.assertIsNone(cat(report, "objection_handling")["score"])
        self.assertFalse(report["lowCoverage"])

    def test_little_coverage_is_disclosed(self):
        d = draft(score=7)
        for c in d["categories"][2:]:
            c.update({"assessable": False, "notAssessableReason": "Not shown in this call."})
        report, _ = evaluate(d)
        self.assertEqual(report["coverage"], 25)
        self.assertTrue(report["lowCoverage"])

    def test_an_excellent_call_with_proof_is_recognised(self):
        report, _ = evaluate(draft(score=9))
        self.assertEqual((report["score"], report["band"]), (90, "exceptional"))

    def test_90_plus_needs_proof_everywhere(self):
        d = draft(score=10)
        d["conclusion"]["strengths"] = d["conclusion"]["strengths"][:1]
        report, _ = evaluate(d)
        self.assertEqual(report["score"], 89)

    def test_a_poor_call_scores_poorly(self):
        report, _ = evaluate(draft(score=3))
        self.assertEqual((report["score"], report["band"]), (30, "critical"))


class ReviewTest(unittest.TestCase):
    def test_the_review_corrects_marks_and_removes_unsupported_claims(self):
        review = {
            "checks": [{"check": "high_scores_supported", "passed": False, "note": "Trust was asserted, not shown."}],
            "adjustments": [
                {"key": "trust_building", "assessable": True, "score": 5, "reason": "Only a polite 'I understand'."},
                {"key": "value_proposition", "assessable": False, "score": 0, "reason": "Value was never discussed beyond price."},
            ],
            "removeClaims": [{"section": "nextActions", "index": 0, "reason": "Already part of the call"}],
            "verdict": "Competent, but trust and value were thin.",
        }
        report, _ = evaluate(draft(score=8), review=review)
        self.assertEqual(cat(report, "trust_building")["score"], 5)
        self.assertIsNone(cat(report, "value_proposition")["score"])
        self.assertEqual(report["conclusion"]["nextActions"], [])
        self.assertEqual(report["conclusion"]["verdict"], "Competent, but trust and value were thin.")
        self.assertTrue(report["qa"]["reviewed"])
        self.assertEqual(report["qa"]["checks"][0]["check"], "high_scores_supported")

    def test_a_review_can_never_lift_a_mark_the_rules_capped(self):
        d = draft(score=6)
        d["analysis"]["objections"][0]["handling"] = "not_handled"
        review = {"checks": [], "adjustments": [{"key": "objection_handling", "assessable": True, "score": 9, "reason": "Seemed fine"}], "removeClaims": [], "verdict": ""}
        report, _ = evaluate(d, review=review)
        self.assertEqual(cat(report, "objection_handling")["score"], 4)

    def test_if_the_review_fails_the_report_still_comes_with_the_rules_and_says_so(self):
        report, _ = evaluate(draft(score=7), fail_review=True)
        self.assertFalse(report["qa"]["reviewed"])
        self.assertEqual(report["score"], 70)
        self.assertTrue(any("review could not run" in a["reason"] for a in report["qa"]["adjustments"]))


class LegacyFieldsTest(unittest.TestCase):
    def test_older_screens_get_the_same_report(self):
        report, _ = evaluate(draft(score=7))
        legacy = ci.legacy_fields(report)
        self.assertEqual(legacy["overallScore"], 7.0)
        self.assertEqual(len(legacy["categoryScores"]), 9)
        self.assertEqual(legacy["whatWentWell"][0], "Clarified the date")
        self.assertEqual(legacy["nextCallFocus"], ["Ask budget early"])
        self.assertEqual(legacy["voiceScript"], "Nice work.")
        self.assertTrue(any(m["momentType"] == "great_moment" and m["at"] == 14 for m in legacy["keyMoments"]))

    def test_not_assessable_has_no_overall(self):
        report, _ = evaluate(draft(), lines=[])
        self.assertIsNone(ci.legacy_fields(report)["overallScore"])


if __name__ == "__main__":
    unittest.main()


class CompletenessTest(unittest.TestCase):
    """After the first real run: a long transcript (Tamil script) filled the 8,192-token answer before
    its conclusion, and the report came back with no coaching or next actions."""

    def test_the_evaluation_gets_room_and_must_be_complete(self):
        _, run = evaluate(draft())
        self.assertEqual(run.calls[0]["max_tokens"], ci.EVALUATION_MAX_TOKENS)
        self.assertGreater(ci.EVALUATION_MAX_TOKENS, 8192)
        self.assertTrue(run.calls[0]["require_complete"])

    def test_a_draft_missing_its_conclusion_still_gives_every_section(self):
        d = draft()
        del d["conclusion"]
        report, _ = evaluate(d)
        concl = report["conclusion"]
        self.assertEqual((concl["coaching"], concl["nextActions"], concl["strengths"], concl["weaknesses"]), ([], [], [], []))
        self.assertIsNone(concl["outcome"])
        self.assertEqual(ci.legacy_fields(report)["nextCallFocus"], [])

    def test_an_answer_cut_off_at_the_token_limit_is_a_failure_not_a_shorter_report(self):
        from types import SimpleNamespace
        from unittest import mock

        from app.agent import anthropic_client

        cut = SimpleNamespace(
            stop_reason="max_tokens",
            usage=SimpleNamespace(input_tokens=10, output_tokens=14000),
            content=[SimpleNamespace(type="tool_use", input={"understanding": {}})],
        )
        client = mock.Mock()
        client.messages.create.return_value = cut
        with mock.patch.object(anthropic_client, "_resolve_api_key", return_value="k"), mock.patch.object(anthropic_client, "_client", return_value=client):
            with self.assertRaises(RuntimeError) as raised:
                anthropic_client._run_forced_tool_extraction("s", ci.EVALUATION_TOOL, [{"type": "text", "text": "x"}], name="t", max_tokens=14000, require_complete=True)
            self.assertIn("cut off", str(raised.exception))
            self.assertEqual(client.messages.create.call_args.kwargs["max_tokens"], 14000)
            # Every other caller keeps today's behaviour: a cut-off answer is returned as it is.
            self.assertEqual(anthropic_client._run_forced_tool_extraction("s", ci.EVALUATION_TOOL, [{"type": "text", "text": "x"}], name="t"), {"understanding": {}})

"""The AI Coach's full narration rewritten in an Indian language (app/agent/coach_narration.py).

Claude is stood in for by a scripted `run`, so these check what is asked for and what is
accepted: every section, in the language's own script, with the numbers kept.
"""

import threading
import unittest
from unittest import mock

from fastapi import HTTPException

from app.agent import coach_narration as cn
from app.routes import call_copilot as route

SECTIONS = [
    {"id": "overview", "title": "Overall performance", "text": "You scored 34 out of 100, which puts this call in the Critical band."},
    {"id": "skills", "title": "Skill breakdown", "text": "Objection Handling: 2 out of 10. The MOQ objection of 500 pieces was met with silence."},
    {"id": "next_steps", "title": "Next steps", "text": "For you, high priority: Email Ravi a 200-piece MOQ option."},
]

# What a native rewrite of each section might look like, per language (numbers kept as digits).
SAMPLE = {
    "ta": "நீங்கள் {n} மதிப்பெண் பெற்றீர்கள், இது மிகவும் முக்கியமான நிலை.",
    "hi": "आपको {n} अंक मिले, यह बहुत गंभीर स्तर है।",
    "mr": "तुम्हाला {n} गुण मिळाले, ही गंभीर पातळी आहे.",
    "bn": "আপনি {n} নম্বর পেয়েছেন, এটি গুরুতর স্তর।",
    "pa": "ਤੁਹਾਨੂੰ {n} ਅੰਕ ਮਿਲੇ, ਇਹ ਗੰਭੀਰ ਪੱਧਰ ਹੈ।",
    "gu": "તમને {n} ગુણ મળ્યા, આ ગંભીર સ્તર છે.",
    "od": "ଆପଣ {n} ନମ୍ବର ପାଇଲେ, ଏହା ଗମ୍ଭୀର ସ୍ତର।",
    "te": "మీకు {n} మార్కులు వచ్చాయి, ఇది తీవ్రమైన స్థాయి.",
    "kn": "ನಿಮಗೆ {n} ಅಂಕಗಳು ಬಂದಿವೆ, ಇದು ಗಂಭೀರ ಮಟ್ಟ.",
    "ml": "നിങ്ങൾക്ക് {n} മാർക്ക് ലഭിച്ചു, ഇത് ഗുരുതരമായ നിലയാണ്.",
}


def native(language: str, source: str) -> str:
    """A believable rewrite: the language's own words, carrying every number of the source."""
    numbers = " ".join(cn._NUMBER.findall(source))
    return SAMPLE[language].format(n=numbers) + " MOQ Ravi"


def section_of(user_content: list[dict]) -> dict:
    text = user_content[0]["text"]
    return next(s for s in SECTIONS if s["text"] in text)


class ScriptedRun:
    """Stands in for _run_forced_tool_extraction; `answers` maps an attempt number to a function of the section."""

    def __init__(self, language: str, answers=None):
        self.language = language
        self.answers = answers or {}
        self.calls: list[dict] = []
        self.lock = threading.Lock()

    def __call__(self, system, tool, user_content, **kwargs):
        section = section_of(user_content)
        with self.lock:
            attempt = sum(1 for c in self.calls if c["section"] == section["id"])
            self.calls.append({"section": section["id"], "system": system, "text": user_content[0]["text"], "kwargs": kwargs})
        answer = self.answers.get(attempt, lambda s: native(self.language, s["text"]))
        return {"text": answer(section)}


class TranslateNarration(unittest.TestCase):
    def test_tamil_every_section_comes_back_in_order_in_tamil_with_the_numbers(self):
        run = ScriptedRun("ta")
        out = cn.translate_narration("ta", SECTIONS, organization_id="org-1", user_id="u1", run=run)
        self.assertEqual([s["id"] for s in out], ["overview", "skills", "next_steps"])
        self.assertEqual(len(run.calls), 3)  # one short call per section
        for src, got in zip(SECTIONS, out):
            self.assertGreater(cn.script_share(got["text"], "ta"), 0.5)
            self.assertEqual(cn.missing_numbers(src["text"], got["text"]), [])
        # The whole section is asked for, in Tamil, keeping names and numbers; a cut-off answer is a failure.
        call = run.calls[0]
        self.assertIn("Tamil", call["system"])
        self.assertIn("Never drop, shorten, summarise or add anything", call["system"])
        self.assertIn("Keep every number exactly", call["system"])
        self.assertIn("names", call["system"])
        self.assertTrue(call["kwargs"]["require_complete"])
        self.assertEqual(call["kwargs"]["organization_id"], "org-1")

    def test_every_offered_language_is_checked_against_its_own_script(self):
        for code in cn.SCRIPT_RANGES:
            with self.subTest(code=code):
                out = cn.translate_narration(code, SECTIONS, organization_id=None, user_id="u1", run=ScriptedRun(code))
                self.assertEqual(len(out), 3)
                self.assertTrue(all(cn.script_share(s["text"], code) > 0.5 for s in out))
        # Every language the voice can speak is covered.
        self.assertEqual(set(cn.SCRIPT_RANGES) | {"en"}, set(cn.LANGUAGE_NAMES))

    def test_english_needs_no_rewrite(self):
        run = ScriptedRun("ta")
        out = cn.translate_narration("en", SECTIONS, organization_id=None, user_id="u1", run=run)
        self.assertEqual(out, SECTIONS)
        self.assertEqual(run.calls, [])

    def test_an_answer_left_in_english_is_asked_again_then_refused(self):
        english = lambda s: s["text"]  # noqa: E731
        # Second try in Tamil: accepted.
        run = ScriptedRun("ta", {0: english})
        out = cn.translate_narration("ta", SECTIONS[:1], organization_id=None, user_id="u1", run=run)
        self.assertGreater(cn.script_share(out[0]["text"], "ta"), 0.5)
        self.assertEqual(len(run.calls), 2)
        self.assertIn("not written in Tamil script", run.calls[1]["text"])
        # Both tries in English: the whole narration fails rather than mixing English into Tamil.
        with self.assertRaises(ValueError):
            cn.translate_narration("ta", SECTIONS, organization_id=None, user_id="u1", run=ScriptedRun("ta", {0: english, 1: english}))

    def test_a_lost_score_is_asked_for_again(self):
        no_numbers = lambda s: SAMPLE["ta"].format(n="")  # noqa: E731
        run = ScriptedRun("ta", {0: no_numbers})
        out = cn.translate_narration("ta", SECTIONS[:1], organization_id=None, user_id="u1", run=run)
        self.assertIn("34", out[0]["text"])
        self.assertIn("100", out[0]["text"])
        self.assertIn("these numbers were missing: 34, 100", run.calls[1]["text"])

    def test_an_empty_answer_is_never_spoken(self):
        with self.assertRaises(ValueError):
            cn.translate_narration("hi", SECTIONS[:1], organization_id=None, user_id="u1", run=ScriptedRun("hi", {0: lambda s: "", 1: lambda s: "  "}))

    def test_markdown_is_taken_out_for_the_voice(self):
        run = ScriptedRun("hi", {0: lambda s: "**" + native("hi", s["text"]) + "** # |"})
        out = cn.translate_narration("hi", SECTIONS[:1], organization_id=None, user_id="u1", run=run)
        self.assertNotIn("*", out[0]["text"])
        self.assertNotIn("#", out[0]["text"])

    def test_an_unsupported_language_is_refused(self):
        with self.assertRaises(ValueError):
            cn.translate_narration("fr", SECTIONS, organization_id=None, user_id="u1", run=ScriptedRun("ta"))


class VoiceScriptRoute(unittest.TestCase):
    user = {"sub": "u1", "organizationId": "org-1"}

    def test_sections_are_rewritten_and_returned_whole(self):
        body = route.VoiceScriptRequest(sessionId="s1", languageCode="ta", sections=SECTIONS)
        fake = [{**s, "text": native("ta", s["text"])} for s in SECTIONS]
        with mock.patch.object(route, "translate_narration", return_value=fake) as translate:
            reply = route.voice_script(body, self.user)
        self.assertEqual(translate.call_args.args[0], "ta")
        self.assertEqual([s.id for s in reply.sections], ["overview", "skills", "next_steps"])
        self.assertEqual(reply.voiceScript, " ".join(s["text"] for s in fake))

    def test_a_failed_rewrite_is_a_502_in_words_for_the_person(self):
        body = route.VoiceScriptRequest(sessionId="s1", languageCode="ta", sections=SECTIONS)
        with mock.patch.object(route, "translate_narration", side_effect=ValueError("not Tamil")):
            with self.assertRaises(HTTPException) as caught:
                route.voice_script(body, self.user)
        self.assertEqual(caught.exception.status_code, 502)
        self.assertIn("couldn't be prepared in this language", caught.exception.detail)

    def test_an_unknown_language_is_a_400(self):
        body = route.VoiceScriptRequest(sessionId="s1", languageCode="fr", sections=SECTIONS)
        with self.assertRaises(HTTPException) as caught:
            route.voice_script(body, self.user)
        self.assertEqual(caught.exception.status_code, 400)

    def test_without_sections_the_earlier_short_script_still_works(self):
        body = route.VoiceScriptRequest(sessionId="s1", languageCode="hi", overallScore=7, voiceScript="Nice work.")
        with mock.patch.object(route, "localize_voice_script", return_value="अच्छा काम।") as old:
            reply = route.voice_script(body, self.user)
        old.assert_called_once()
        self.assertEqual(reply.voiceScript, "अच्छा काम।")
        self.assertEqual(reply.sections, [])


if __name__ == "__main__":
    unittest.main()

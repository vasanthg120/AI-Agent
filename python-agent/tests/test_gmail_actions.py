"""Gmail action finding: deterministic filters first, a strict AI check second, evidence-based closing.
Uses fake Gmail payloads and a fake model - no network."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.integrations import gmail_actions as ga  # noqa: E402

ME = "sanjay@pantheras.io"


def ms(day: int, hour: int = 10) -> str:
    return str(int(datetime(2026, 11, day, hour, tzinfo=timezone.utc).timestamp() * 1000))


def msg(mid, day, frm, to, subject="Quote", snippet="", labels=None, extra=None, hour=10):
    headers = [{"name": "From", "value": frm}, {"name": "To", "value": to}, {"name": "Subject", "value": subject}]
    headers += [{"name": k, "value": v} for k, v in (extra or {}).items()]
    return {"id": mid, "labelIds": labels or ["INBOX"], "snippet": snippet, "internalDate": ms(day, hour), "payload": {"headers": headers}}


def thread(tid, *messages):
    return {"id": tid, "messages": list(messages)}


def fake_gmail(threads):
    def gmail_get(path, token, params):
        if path == "/profile":
            return {"emailAddress": ME}
        if path == "/threads":
            return {"threads": [{"id": t["id"]} for t in threads]}
        return next(t for t in threads if path.endswith(t["id"]))

    return gmail_get


def model_says(table):
    """table: thread id -> (actionable, reason). Records what it was asked."""
    asked = []

    def call(system, tool, user_text):
        import json

        items = json.loads(user_text)
        asked.extend(i["threadId"] for i in items)
        return {"results": [{"threadId": i["threadId"], "actionable": table.get(i["threadId"], (False, "no"))[0], "reason": table.get(i["threadId"], (False, "no"))[1], "due_hint": ""} for i in items]}

    call.asked = asked
    return call


class AutomatedMailTests(unittest.TestCase):
    def test_bulk_and_system_mail_is_never_a_candidate(self):
        cases = [
            msg("a", 20, "Shop <news@shop.com>", ME, extra={"List-Unsubscribe": "<mailto:x>"}),
            msg("b", 20, "x@y.com", ME, extra={"Precedence": "bulk"}),
            msg("c", 20, "x@y.com", ME, extra={"Auto-Submitted": "auto-generated"}),
            msg("d", 20, "noreply@bank.com", ME),
            msg("e", 20, "x@y.com", ME, labels=["INBOX", "CATEGORY_PROMOTIONS"]),
            msg("f", 20, "Mailer-Daemon@googlemail.com", ME),
        ]
        for m in cases:
            self.assertTrue(ga.is_automated(m), m["id"])
        self.assertFalse(ga.is_automated(msg("g", 20, "Asha <asha@customer.com>", ME)))
        self.assertFalse(ga.is_automated(msg("h", 20, "x@y.com", ME, extra={"Auto-Submitted": "no"})))


class RunTests(unittest.TestCase):
    def run_it(self, threads, known=None, table=None):
        model = model_says(table or {})
        out = ga.run("tok", lookback_days=7, known=known or [], gmail_get=fake_gmail(threads), call_model=model)
        return out, model

    def test_only_genuine_requests_and_promises_become_tasks(self):
        threads = [
            thread("t-ask", msg("1", 20, "Asha <asha@customer.com>", ME, "Need a quote", "Can you send the quote for 200 caps?")),
            thread("t-thanks", msg("2", 20, "Ravi <ravi@customer.com>", ME, "Re: order", "Thanks, received!")),
            thread("t-news", msg("3", 20, "news@shop.com", ME, "Sale", "50% off", extra={"List-Unsubscribe": "<x>"})),
            thread("t-promise", msg("4", 19, "Bo <bo@x.com>", ME, "Samples", "Can you send samples?"), msg("5", 19, ME, "bo@x.com", "Re: Samples", "I will send the samples tomorrow", labels=["SENT"], hour=12)),
            thread("t-answered", msg("6", 19, "Cy <cy@x.com>", ME, "Price?", "Price?"), msg("7", 19, ME, "cy@x.com", "Re: Price?", "It is 12 each.", labels=["SENT"], hour=12)),
        ]
        out, model = self.run_it(threads, table={"t-ask": (True, "asks for a quote"), "t-promise": (True, "promises samples tomorrow")})
        found = {o["threadId"]: o["kind"] for o in out["open"]}
        self.assertEqual(found, {"t-ask": "reply_owed", "t-promise": "promised_followup"})
        # Newsletters never reach the model at all.
        self.assertNotIn("t-news", model.asked)
        self.assertTrue(out["complete"])
        self.assertEqual(out["mailbox"], ME)

    def test_the_model_saying_no_keeps_ordinary_mail_out(self):
        out, _ = self.run_it([thread("t-thanks", msg("2", 20, "Ravi <ravi@c.com>", ME, "Re: order", "Thanks!"))])
        self.assertEqual(out["open"], [])

    def test_when_the_classifier_fails_nothing_new_is_proposed_and_the_read_is_incomplete(self):
        def broken(*a):
            raise RuntimeError("no key")

        out = ga.run("tok", lookback_days=7, known=[], gmail_get=fake_gmail([thread("t", msg("1", 20, "a@c.com", ME, "Hi", "Please reply"))]), call_model=broken)
        self.assertEqual(out["open"], [])
        self.assertEqual(out["classifier"], "unavailable")
        self.assertFalse(out["complete"])

    def test_a_task_closes_only_when_the_user_sent_a_later_message_in_the_thread(self):
        known = [{"threadId": "t-ask", "kind": "reply_owed", "lastMessageId": "1", "lastMessageAt": "2026-11-20T10:00:00+00:00"}]
        still = thread("t-ask", msg("1", 20, "Asha <asha@c.com>", ME, "Need a quote", "send quote?"))
        out, model = self.run_it([still], known=known)
        self.assertEqual([o["threadId"] for o in out["open"]], ["t-ask"])
        self.assertEqual(out["resolved"], [])
        self.assertEqual(model.asked, [])  # unchanged thread: no new AI call
        answered = thread("t-ask", msg("1", 20, "Asha <asha@c.com>", ME, "Need a quote", "send quote?"), msg("9", 21, ME, "asha@c.com", "Re: Need a quote", "Attached.", labels=["SENT"]))
        out, _ = self.run_it([answered], known=known)
        self.assertEqual(out["open"], [])
        self.assertEqual(out["resolved"][0]["threadId"], "t-ask")
        self.assertEqual(out["resolved"][0]["how"], "replied")
        self.assertEqual(out["resolved"][0]["messageId"], "9")

    def test_a_new_customer_message_after_the_users_reply_is_a_new_candidate_not_a_resolution(self):
        known = [{"threadId": "t", "kind": "promised_followup", "lastMessageId": "5", "lastMessageAt": "2026-11-19T12:00:00+00:00"}]
        t = thread("t", msg("4", 19, "Bo <bo@x.com>", ME, "Samples", "send?"), msg("5", 19, ME, "bo@x.com", "Re: Samples", "I will send tomorrow", labels=["SENT"], hour=12), msg("6", 22, "Bo <bo@x.com>", ME, "Re: Samples", "Still waiting, any update?"))
        out, _ = self.run_it([t], known=known, table={"t": (True, "asks for an update")})
        self.assertEqual(out["resolved"], [])
        self.assertEqual([(o["threadId"], o["kind"]) for o in out["open"]], [("t", "reply_owed")])

    def test_a_full_scan_is_marked_incomplete_when_the_limits_were_hit(self):
        many = [thread(f"t{i}", msg(f"m{i}", 20, f"p{i}@c.com", ME, "Hi", "please reply")) for i in range(ga.MAX_THREADS)]
        out, _ = self.run_it(many, table={})
        self.assertFalse(out["complete"])


if __name__ == "__main__":
    unittest.main()

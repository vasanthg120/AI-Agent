"""work_automation routes: the EOD summary only ever sees the records NestJS sends
(bounded), and the calendar route never fabricates meetings."""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routes import work_automation as wa  # noqa: E402


class SummaryInputTests(unittest.TestCase):
    def test_input_is_only_the_given_records_and_bounded(self):
        payload = wa.EodSummaryRequest(
            employee_name="Sanjay",
            date="2026-11-24",
            completed=[{"title": f"t{i}"} for i in range(100)],
            data_gaps=["calendar not connected"],
        )
        text = wa.build_summary_input(payload)
        import json

        body = json.loads(text)
        self.assertEqual(len(body["completed"]), 40)
        self.assertEqual(body["employee_name"], "Sanjay")
        self.assertEqual(body["data_gaps"], ["calendar not connected"])

    def test_system_prompt_forbids_inferring_completion(self):
        self.assertIn("Never claim something was completed unless it is listed under", wa.EOD_SUMMARY_SYSTEM_PROMPT)


class MeetingsTests(unittest.TestCase):
    def test_not_connected_returns_no_meetings(self):
        with mock.patch.object(wa.settings, "ms_graph_client_id", "x"), mock.patch.object(wa.outlook_store, "get_valid_access_token", return_value=None):
            res = wa.meetings(wa.MeetingsRequest(start="2026-11-24T00:00:00Z", end="2026-11-25T00:00:00Z"), user={"sub": "u1"})
        self.assertFalse(res.connected)
        self.assertEqual(res.meetings, [])

    def test_maps_events_and_skips_cancelled(self):
        graph = {"value": [
            {"subject": "Sync", "start": {"dateTime": "2026-11-24T05:00:00"}, "end": {"dateTime": "2026-11-24T05:30:00"}, "organizer": {"emailAddress": {"name": "Ravi"}}},
            {"subject": "Gone", "isCancelled": True, "start": {}, "end": {}},
        ]}
        with mock.patch.object(wa.settings, "ms_graph_client_id", "x"), mock.patch.object(wa.outlook_store, "get_valid_access_token", return_value="tok"), mock.patch.object(wa.ms_graph, "graph_get", return_value=graph):
            res = wa.meetings(wa.MeetingsRequest(start="2026-11-24T00:00:00Z", end="2026-11-25T00:00:00Z"), user={"sub": "u1"})
        self.assertTrue(res.connected)
        self.assertEqual([m.title for m in res.meetings], ["Sync"])
        self.assertEqual(res.meetings[0].organizer, "Ravi")

    def test_rejects_garbage_dates(self):
        with mock.patch.object(wa.settings, "ms_graph_client_id", "x"), mock.patch.object(wa.outlook_store, "get_valid_access_token", return_value="tok"):
            with self.assertRaises(ValueError):
                wa.meetings(wa.MeetingsRequest(start="soon", end="later"), user={"sub": "u1"})


class SendMailTests(unittest.TestCase):
    def req(self, **over):
        base = dict(channel="outlook", to=["a@x.io", "boss@x.io"], subject="EOD", html="<p>hi</p>", text="hi")
        base.update(over)
        return wa.SendMailRequest(**base)

    def test_outlook_send_uses_the_callers_own_token_and_all_recipients(self):
        with mock.patch.object(wa.outlook_store, "get_valid_access_token", return_value="tok") as tok, mock.patch.object(wa.requests, "post") as post:
            post.return_value.raise_for_status = lambda: None
            res = wa.send_mail(self.req(), user={"sub": "u1"})
        tok.assert_called_once_with("u1")
        self.assertEqual(res, {"sent": True, "channel": "outlook"})
        body = post.call_args.kwargs["json"]["message"]
        self.assertEqual([r["emailAddress"]["address"] for r in body["toRecipients"]], ["a@x.io", "boss@x.io"])

    def test_gmail_send_builds_multipart_raw(self):
        with mock.patch.object(wa.gmail_store, "get_valid_access_token", return_value="tok"), mock.patch.object(wa.requests, "post") as post:
            post.return_value.raise_for_status = lambda: None
            wa.send_mail(self.req(channel="gmail"), user={"sub": "u1"})
        self.assertIn("raw", post.call_args.kwargs["json"])

    def test_not_connected_is_a_400_so_the_caller_can_fall_back(self):
        with mock.patch.object(wa.outlook_store, "get_valid_access_token", return_value=None):
            with self.assertRaises(wa.HTTPException) as ctx:
                wa.send_mail(self.req(), user={"sub": "u1"})
        self.assertEqual(ctx.exception.status_code, 400)

    def test_rejects_bad_recipients_and_unknown_channels(self):
        for bad in (self.req(to=[]), self.req(to=["not-an-email"]), self.req(to=["a@x.io"] * 6)):
            with self.assertRaises(wa.HTTPException):
                wa.send_mail(bad, user={"sub": "u1"})
        with self.assertRaises(wa.HTTPException):
            wa.send_mail(self.req(channel="sms"), user={"sub": "u1"})

    def test_provider_refusal_is_surfaced_with_its_status(self):
        err = wa.HTTPError(response=mock.Mock(status_code=403, text="Mail.Send missing"))
        with mock.patch.object(wa.outlook_store, "get_valid_access_token", return_value="tok"), mock.patch.object(wa.requests, "post") as post:
            post.return_value.raise_for_status.side_effect = err
            with self.assertRaises(wa.HTTPException) as ctx:
                wa.send_mail(self.req(), user={"sub": "u1"})
        self.assertEqual(ctx.exception.status_code, 403)


class ExpiredTokenTests(unittest.TestCase):
    """The admin's mailbox send goes through the existing refresh path: an expired access token is refreshed, not failed."""

    def test_expired_gmail_token_is_refreshed_then_used_for_the_admins_send(self):
        from datetime import datetime, timedelta

        from app.memory import gmail_store

        expired = {"userId": "admin1", "email": "enquiry@t.example", "expiresAt": datetime.utcnow() - timedelta(minutes=5), "accessToken": "old"}
        refreshed = {**expired, "expiresAt": datetime.utcnow() + timedelta(hours=1), "accessToken": "new-enc"}
        with mock.patch.object(gmail_store, "get_connection", return_value=expired) as conn, mock.patch.object(gmail_store, "_refresh", return_value=refreshed) as refresh, mock.patch.object(gmail_store, "decrypt_token", return_value="fresh-token"):
            token = gmail_store.get_valid_access_token("admin1")
        conn.assert_called_once_with("admin1")
        refresh.assert_called_once_with(expired)
        self.assertEqual(token, "fresh-token")
        with mock.patch.object(wa.gmail_store, "get_valid_access_token", return_value=token), mock.patch.object(wa.requests, "post") as post:
            post.return_value.raise_for_status = lambda: None
            res = wa.send_mail(wa.SendMailRequest(channel="gmail", to=["enquiry@t.example"], subject="EOD", html="<p>x</p>", text="x"), user={"sub": "admin1"})
        self.assertEqual(res["sent"], True)
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer fresh-token")

    def test_revoked_grant_is_a_400_so_the_next_channel_is_tried(self):
        with mock.patch.object(wa.gmail_store, "get_valid_access_token", return_value=None):
            with self.assertRaises(wa.HTTPException) as ctx:
                wa.send_mail(wa.SendMailRequest(channel="gmail", to=["a@x.io"], subject="s", html="h", text="t"), user={"sub": "admin1"})
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()

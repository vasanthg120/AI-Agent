import unittest
from unittest import mock

import requests

from app.integrations import ms_graph

FORM = {"from": {"emailAddress": {"address": "suresh@forms.example.in"}}}


def _graph_message(reply_to: list[str], content_type: str = "html") -> requests.Response:
    response = requests.Response()
    response.status_code = 200
    response._content = (
        '{"body": {"contentType": "%s"}, "from": {"emailAddress": {"address": "suresh@forms.example.in"}}, "replyTo": [%s]}'
        % (content_type, ",".join('{"emailAddress": {"address": "%s"}}' % a for a in reply_to))
    ).encode()
    return response


def _accepted() -> requests.Response:
    response = requests.Response()
    response.status_code = 202
    return response


class ReplyToTest(unittest.TestCase):
    """A website enquiry comes from the form's address with the customer in
    Reply-To: the answer must go to the customer, not back to the form."""

    def test_reply_to_other_than_the_sender(self):
        self.assertEqual(ms_graph.reply_to_addresses({**FORM, "replyTo": [{"emailAddress": {"address": "swetha@gmail.com"}}]}), ["swetha@gmail.com"])
        # The sender naming itself (or nothing) changes nothing.
        self.assertEqual(ms_graph.reply_to_addresses({**FORM, "replyTo": [{"emailAddress": {"address": "Suresh@Forms.example.in"}}]}), [])
        self.assertEqual(ms_graph.reply_to_addresses(FORM), [])

    def _send(self, reply_to: list[str]):
        with mock.patch.object(ms_graph, "_get_with_retry", return_value=_graph_message(reply_to)), mock.patch.object(
            ms_graph.requests, "post", return_value=_accepted()
        ) as post:
            went_to = ms_graph.reply_to_message("token", "msg-1", "Hi Swetha,\nThanks for your enquiry.")
        return went_to, post.call_args.kwargs["json"]

    def test_the_answer_to_a_form_enquiry_goes_to_the_customer(self):
        went_to, payload = self._send(["swetha@gmail.com"])
        self.assertEqual(went_to, ["swetha@gmail.com"])
        self.assertEqual(payload["message"], {"toRecipients": [{"emailAddress": {"address": "swetha@gmail.com"}}]})
        self.assertIn("Thanks for your enquiry", payload["comment"])

    def test_ordinary_mail_is_answered_to_its_sender_as_before(self):
        went_to, payload = self._send([])
        self.assertEqual(went_to, [])
        self.assertNotIn("message", payload)


if __name__ == "__main__":
    unittest.main()

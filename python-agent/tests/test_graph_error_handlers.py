import asyncio
import json
import unittest

import requests

from app.main import _microsoft_graph_error, _microsoft_graph_unreachable

GRAPH = "https://graph.microsoft.com/v1.0/me/messages?$top=250"


def _call(handler, exc):
    response = asyncio.run(handler(None, exc))
    return response.status_code, json.loads(response.body)["detail"]


class GraphErrorHandlersTest(unittest.TestCase):
    """Microsoft 365 failing reaches the mailbox owner in words (the sync records the
    detail), not as a bare 500 that reads like HaiVE crashed."""

    def test_microsoft_server_error_is_worded_with_its_request_id(self):
        response = requests.Response()
        response.status_code = 504
        response.url = GRAPH
        response.headers["request-id"] = "req-123"
        status, detail = _call(_microsoft_graph_error, requests.HTTPError(response=response))
        self.assertEqual(status, 503)
        self.assertIn("Microsoft 365's mail service didn't answer", detail)
        self.assertIn("req-123", detail)

    def test_microsoft_timeout_is_worded(self):
        exc = requests.ReadTimeout(request=requests.Request("GET", GRAPH).prepare())
        status, detail = _call(_microsoft_graph_unreachable, exc)
        self.assertEqual(status, 503)
        self.assertIn("took too long", detail)

    def test_microsoft_unreachable_because_this_computer_is_offline(self):
        # What happened on 2026-11-16: the sign-in address couldn't be looked up (DNS / internet down).
        exc = requests.ConnectionError(
            "HTTPSConnectionPool(host='login.microsoftonline.com', port=443): Max retries exceeded "
            "(Caused by NameResolutionError(\"Failed to resolve 'login.microsoftonline.com' ([Errno 11001] getaddrinfo failed)\"))",
            request=requests.Request("POST", "https://login.microsoftonline.com/organizations/oauth2/v2.0/token").prepare(),
        )
        status, detail = _call(_microsoft_graph_unreachable, exc)
        self.assertEqual(status, 503)
        self.assertIn("couldn't reach Microsoft 365 (login.microsoftonline.com)", detail)
        self.assertIn("internet connection or DNS", detail)

    def test_microsoft_sign_in_timeout_is_worded(self):
        exc = requests.ReadTimeout(request=requests.Request("POST", "https://login.microsoftonline.com/organizations/oauth2/v2.0/token").prepare())
        status, detail = _call(_microsoft_graph_unreachable, exc)
        self.assertEqual(status, 503)
        self.assertIn("sign-in service (login.microsoftonline.com) took too long", detail)

    def test_other_services_are_not_blamed_on_microsoft(self):
        exc = requests.ConnectionError(request=requests.Request("GET", "https://api.example.com/x").prepare())
        with self.assertLogs("app.main", level="ERROR"):
            status, detail = _call(_microsoft_graph_unreachable, exc)
        self.assertEqual(status, 500)
        self.assertNotIn("Microsoft", detail)


if __name__ == "__main__":
    unittest.main()

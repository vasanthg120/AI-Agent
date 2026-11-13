import asyncio
import json
import types
import unittest
from unittest import mock

import requests

from app.main import _microsoft_graph_error, _microsoft_sign_in
from app.memory import outlook_store

CONNECTION = {"userId": "u1", "email": "enquiry@example.com", "refreshToken": "encrypted"}
CONFIGURED = types.SimpleNamespace(ms_graph_client_id="app-id", ms_graph_client_secret="app-secret")


def _token_response(status: int, body: dict) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response._content = json.dumps(body).encode()
    response.url = outlook_store.TOKEN_ENDPOINT
    return response


class TokenRefreshRefusalsTest(unittest.TestCase):
    """Renewing a mailbox's access: every refusal from Microsoft's sign-in reaches
    the mailbox owner as what Microsoft said (it was "Something went wrong talking
    to an outside service")."""

    def setUp(self):
        patches = [
            mock.patch.object(outlook_store, "decrypt_token", lambda value: "plain"),
            mock.patch.object(outlook_store, "settings", CONFIGURED),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def _refresh_with(self, response):
        with mock.patch.object(outlook_store.requests, "post", return_value=response) as post:
            try:
                return outlook_store._refresh(dict(CONNECTION)), None, post
            except Exception as exc:  # noqa: BLE001 - the test inspects it
                return None, exc, post

    def test_missing_app_settings_are_named_without_asking_microsoft(self):
        with mock.patch.object(outlook_store, "settings", types.SimpleNamespace(ms_graph_client_id="app-id", ms_graph_client_secret="")):
            _, exc, post = self._refresh_with(_token_response(200, {}))
        post.assert_not_called()
        self.assertIsInstance(exc, outlook_store.MicrosoftAppCredentialsError)
        self.assertIn("MS_GRAPH_CLIENT_SECRET", str(exc))
        self.assertNotIn("MS_GRAPH_CLIENT_ID", str(exc))

    def test_other_refusal_says_what_microsoft_said_without_trace_ids(self):
        body = {
            "error": "invalid_request",
            "error_codes": [900144],
            "error_description": "AADSTS900144: The request body must contain the following parameter: 'client_id'.\r\nTrace ID: 1f2e Correlation ID: 9a8b Timestamp: 2026-11-13",
        }
        _, exc, _ = self._refresh_with(_token_response(400, body))
        self.assertIsInstance(exc, outlook_store.MicrosoftSignInError)
        message = str(exc)
        self.assertIn("invalid_request, AADSTS900144", message)
        self.assertIn("must contain the following parameter: 'client_id'", message)
        self.assertNotIn("Trace ID", message)
        self.assertNotIn("Correlation", message)

    def test_sign_in_service_down_is_microsofts_side(self):
        _, exc, _ = self._refresh_with(_token_response(503, {}))
        self.assertIsInstance(exc, outlook_store.MicrosoftSignInError)
        self.assertIn("didn't answer (error 503)", str(exc))

    def test_wrong_secret_is_still_the_app_credentials_error(self):
        body = {"error": "invalid_client", "error_codes": [7000215], "error_description": "AADSTS7000215: Invalid client secret provided."}
        _, exc, _ = self._refresh_with(_token_response(401, body))
        self.assertIsInstance(exc, outlook_store.MicrosoftAppCredentialsError)
        self.assertIn("AADSTS7000215", str(exc))

    def test_expired_grant_still_asks_for_a_reconnect(self):
        db = mock.MagicMock()
        with mock.patch.object(outlook_store, "get_db", return_value=db):
            result, exc, _ = self._refresh_with(_token_response(400, {"error": "invalid_grant"}))
        self.assertIsNone(exc)
        self.assertIsNone(result)
        db.outlook_connections.update_one.assert_called_once()
        self.assertEqual(db.outlook_connections.update_one.call_args[0][1], {"$set": {"status": "needs_reauth"}})

    def test_the_service_answers_503_with_the_reason(self):
        response = asyncio.run(_microsoft_sign_in(None, outlook_store.MicrosoftSignInError("Microsoft's sign-in refused …")))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(json.loads(response.body)["detail"], "Microsoft's sign-in refused …")

    def test_an_unknown_outside_service_error_names_the_host(self):
        response = requests.Response()
        response.status_code = 502
        response.url = "https://api.example.com/v1/thing"
        with self.assertLogs("app.main", level="ERROR"):
            answer = asyncio.run(_microsoft_graph_error(None, requests.HTTPError(response=response)))
        self.assertEqual(answer.status_code, 500)
        self.assertIn("(api.example.com, error 502)", json.loads(answer.body)["detail"])


if __name__ == "__main__":
    unittest.main()

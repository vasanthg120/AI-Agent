"""What a failed Sarvam batch call (a recorded phone call or upload being
transcribed) tells the salesperson. Each reason Sarvam gives is named in words
they can act on, instead of one generic "could not start processing".

Plain stdlib unittest, matching this project's existing test style. Run with:
    .venv/Scripts/python.exe -m unittest tests.test_sarvam_batch_errors -v
"""

import unittest

from sarvamai.core.api_error import ApiError

from app.integrations.sarvam_client import _batch_error

FALLBACK = "Could not start processing this recording. Please try again."


class BatchErrorWordingTests(unittest.TestCase):
    def wording(self, status):
        return _batch_error(ApiError(status_code=status, body={"error": "x"}), FALLBACK)

    def test_out_of_credits_is_named(self):
        err = self.wording(402)
        self.assertIn("out of credits", err.user_message)
        self.assertEqual(err.status_code, 502)

    def test_rejected_key_points_at_admin_settings(self):
        for status in (401, 403):
            self.assertIn("API key", self.wording(status).user_message)

    def test_rate_limit_is_temporary(self):
        err = self.wording(429)
        self.assertIn("Try again in a few minutes", err.user_message)
        self.assertEqual(err.status_code, 503)  # NestJS keeps polling through a 503

    def test_unreadable_audio_is_not_a_server_error(self):
        err = self.wording(400)
        self.assertIn("couldn't read this recording", err.user_message)
        self.assertEqual(err.status_code, 422)

    def test_anything_else_keeps_the_callers_fallback(self):
        self.assertEqual(self.wording(500).user_message, FALLBACK)
        self.assertEqual(_batch_error(RuntimeError("socket closed"), FALLBACK).user_message, FALLBACK)


if __name__ == "__main__":
    unittest.main()

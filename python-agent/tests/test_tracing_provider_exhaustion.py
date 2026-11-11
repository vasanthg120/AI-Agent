"""Regression tests for app.observability.tracing's confirmed-only provider-
exhaustion detection (Phase C of the LLM Provider Finance feature) — the
_mark_provider_exhausted_if_confirmed() call inside traced_llm_call's own
except block.

Constructs real anthropic.BadRequestError instances (bypassing the full
httpx.Response-based constructor — Python lets attributes be set directly on
an exception instance) so this exercises the actual installed SDK's
exception class and its real `.type` attribute, not a hand-rolled stand-in.

Plain stdlib unittest, matching this project's existing test style. Run with:
    .venv/Scripts/python.exe -m pytest tests/test_tracing_provider_exhaustion.py -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import anthropic  # noqa: E402

import app.observability.tracing as tracing  # noqa: E402


def make_bad_request_error(error_type: str | None) -> anthropic.BadRequestError:
    exc = anthropic.BadRequestError.__new__(anthropic.BadRequestError)
    exc.type = error_type
    exc.message = "synthetic test error"
    return exc


class TracingProviderExhaustionTests(unittest.TestCase):
    def test_a_confirmed_billing_error_marks_anthropic_exhausted(self):
        exc = make_bad_request_error("billing_error")
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", exc)
            mark_exhausted.assert_called_once_with("anthropic")

    def test_the_legacy_invalid_request_error_type_also_marks_exhausted(self):
        exc = make_bad_request_error("invalid_request_error")
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", exc)
            mark_exhausted.assert_called_once_with("anthropic")

    def test_an_unrelated_bad_request_error_type_never_marks_exhausted(self):
        # e.g. a malformed request body — a real BadRequestError, but not a
        # billing signal, must never be treated as one.
        exc = make_bad_request_error("not_found_error")
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", exc)
            mark_exhausted.assert_not_called()

    def test_a_rate_limit_error_never_marks_exhausted_transient_not_permanent(self):
        exc = anthropic.RateLimitError.__new__(anthropic.RateLimitError)
        exc.type = "rate_limit_error"
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", exc)
            mark_exhausted.assert_not_called()

    def test_a_plain_exception_with_no_type_attribute_never_marks_exhausted(self):
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", RuntimeError("connection reset"))
            mark_exhausted.assert_not_called()

    def test_groq_is_never_auto_marked_even_with_a_matching_error_shape(self):
        # Groq has no confirmed billing-error signal (see tracing.py's own
        # leading comment on why) — provider must be 'anthropic' specifically.
        exc = make_bad_request_error("billing_error")
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("groq", exc)
            mark_exhausted.assert_not_called()

    def test_traced_llm_call_still_re_raises_and_records_the_real_error_when_marking_is_wired_in(self):
        # End-to-end through the real context manager: a confirmed billing
        # error must still propagate unchanged to the caller, with marking
        # as a side effect, never swallowing or altering the original error.
        exc = make_bad_request_error("billing_error")
        with (
            patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted,
            patch("app.observability.execution_store.record_llm_execution"),
            patch("app.observability.tracing.langfuse_config.record_llm_generation", return_value=(None, None)),
        ):
            with self.assertRaises(anthropic.BadRequestError):
                with tracing.traced_llm_call("test", provider="anthropic", model="claude-x"):
                    raise exc
            mark_exhausted.assert_called_once_with("anthropic")


if __name__ == "__main__":
    unittest.main()

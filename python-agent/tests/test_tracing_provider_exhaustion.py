"""Regression tests for app.observability.tracing's confirmed-only provider-
exhaustion detection — the _mark_provider_exhausted_if_confirmed() call
inside traced_llm_call's own except block.

Covers the real fix made to this detection: Anthropic's billing_error ships
over HTTP 402, which has no dedicated SDK subclass (only the generic base
APIStatusError), so checking isinstance(exc, BadRequestError) (status_code
locked to 400) could never actually match a real billing error — the fix
checks APIStatusError instead, since `.type` is parsed generically on that
base class for every status code and subclass. Also covers Groq's new
confirmed signal (HTTP 400, error code "blocked_api_access", read off the
raw `.body` dict since Groq's SDK has no `.type` attribute at all).

Constructs real anthropic/groq exception instances (bypassing the full
httpx.Response-based constructor — Python lets attributes be set directly on
an exception instance) so this exercises the actual installed SDKs' own
exception classes, not hand-rolled stand-ins.

Plain stdlib unittest, matching this project's existing test style. Run with:
    .venv/Scripts/python.exe -m pytest tests/test_tracing_provider_exhaustion.py -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import anthropic  # noqa: E402
import groq  # noqa: E402

import app.observability.tracing as tracing  # noqa: E402


def make_anthropic_status_error(status_code: int, error_type: str | None) -> anthropic.APIStatusError:
    # The real 402 response constructs this generic base class directly (no
    # dedicated subclass exists for 402) — matches production exactly.
    exc = anthropic.APIStatusError.__new__(anthropic.APIStatusError)
    exc.status_code = status_code
    exc.type = error_type
    exc.message = "synthetic test error"
    return exc


def make_groq_bad_request_error(body: object) -> groq.BadRequestError:
    exc = groq.BadRequestError.__new__(groq.BadRequestError)
    exc.body = body
    exc.message = "synthetic test error"
    return exc


class TracingProviderExhaustionTests(unittest.TestCase):
    def test_a_confirmed_402_billing_error_marks_anthropic_exhausted(self):
        exc = make_anthropic_status_error(402, "billing_error")
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", exc)
            mark_exhausted.assert_called_once_with("anthropic")

    def test_the_legacy_invalid_request_error_type_also_marks_exhausted(self):
        exc = make_anthropic_status_error(400, "invalid_request_error")
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", exc)
            mark_exhausted.assert_called_once_with("anthropic")

    def test_a_real_badrequesterror_instance_is_still_caught_since_it_is_also_an_apistatuserror(self):
        # The fix broadens the isinstance check from BadRequestError to its
        # base APIStatusError — this confirms that broadening didn't DROP the
        # case the original (narrower) check was written for.
        exc = anthropic.BadRequestError.__new__(anthropic.BadRequestError)
        exc.type = "invalid_request_error"
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", exc)
            mark_exhausted.assert_called_once_with("anthropic")

    def test_an_unrelated_status_error_type_never_marks_exhausted(self):
        # e.g. a malformed request body — a real APIStatusError, but not a
        # billing signal, must never be treated as one.
        exc = make_anthropic_status_error(400, "not_found_error")
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", exc)
            mark_exhausted.assert_not_called()

    def test_a_rate_limit_error_never_marks_exhausted_transient_not_permanent(self):
        exc = make_anthropic_status_error(429, "rate_limit_error")
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", exc)
            mark_exhausted.assert_not_called()

    def test_a_plain_exception_with_no_type_attribute_never_marks_exhausted(self):
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("anthropic", RuntimeError("connection reset"))
            mark_exhausted.assert_not_called()

    def test_groq_blocked_api_access_nested_under_error_marks_groq_exhausted(self):
        exc = make_groq_bad_request_error({"error": {"message": "spend limit reached", "code": "blocked_api_access"}})
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("groq", exc)
            mark_exhausted.assert_called_once_with("groq")

    def test_groq_blocked_api_access_as_a_top_level_code_also_marks_exhausted(self):
        # Defensive fallback for the unconfirmed nesting — see this module's
        # own _groq_error_code() comment.
        exc = make_groq_bad_request_error({"code": "blocked_api_access"})
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("groq", exc)
            mark_exhausted.assert_called_once_with("groq")

    def test_an_unrelated_groq_error_code_never_marks_exhausted(self):
        exc = make_groq_bad_request_error({"error": {"code": "invalid_api_key"}})
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("groq", exc)
            mark_exhausted.assert_not_called()

    def test_a_groq_error_with_no_body_never_marks_exhausted(self):
        exc = make_groq_bad_request_error(None)
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("groq", exc)
            mark_exhausted.assert_not_called()

    def test_anthropics_billing_error_shape_never_marks_groq_exhausted(self):
        # Cross-provider isolation — a matching shape for the WRONG provider
        # must never cross-contaminate.
        exc = make_anthropic_status_error(402, "billing_error")
        with patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted:
            tracing._mark_provider_exhausted_if_confirmed("groq", exc)
            mark_exhausted.assert_not_called()

    def test_traced_llm_call_still_re_raises_and_records_the_real_error_when_marking_is_wired_in(self):
        # End-to-end through the real context manager: a confirmed billing
        # error must still propagate unchanged to the caller, with marking
        # as a side effect, never swallowing or altering the original error.
        exc = make_anthropic_status_error(402, "billing_error")
        with (
            patch("app.observability.tracing.provider_account_status.mark_exhausted") as mark_exhausted,
            patch("app.observability.execution_store.record_llm_execution"),
            patch("app.observability.tracing.langfuse_config.record_llm_generation", return_value=(None, None)),
        ):
            with self.assertRaises(anthropic.APIStatusError):
                with tracing.traced_llm_call("test", provider="anthropic", model="claude-x"):
                    raise exc
            mark_exhausted.assert_called_once_with("anthropic")


if __name__ == "__main__":
    unittest.main()

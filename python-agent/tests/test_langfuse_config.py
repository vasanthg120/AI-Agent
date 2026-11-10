"""Regression tests for app.core.langfuse_config — the dynamic, cached
Langfuse configuration reader that app.observability.tracing's
traced_llm_call/traced_tool_call use as a third (never-blocking) sink.

Covers: the TTL cache actually avoids a Mongo round-trip on every call (the
gap this module explicitly improves over app.memory.integration_store's
always-read-from-Mongo pattern and app.agent.anthropic_client's unbounded
@lru_cache, see this module's own docstring), invalidate_cache() forcing an
immediate re-read, sampling-rate edge cases (0/100), and that a disabled/
unconfigured/undecryptable config is treated as a clean no-op everywhere —
never raised.

Plain stdlib unittest, matching this project's existing test style (see
tests/test_organization_isolation.py's own comment on why) — mocks
app.memory.mongo_client.get_db() with an in-memory fake collection rather
than requiring a real Mongo connection, since every case here is about the
module's own caching/sampling logic, not real persistence. Run with:
    .venv/Scripts/python.exe -m pytest tests/test_langfuse_config.py -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.core.langfuse_config as langfuse_config  # noqa: E402
from app.encryption import encrypt  # noqa: E402


class FakeCollection:
    """Counts find_one calls so tests can assert the TTL cache is really
    skipping Mongo reads, not just happening to return the same value."""

    def __init__(self, doc):
        self.doc = doc
        self.find_one_calls = 0

    def find_one(self, _query):
        self.find_one_calls += 1
        return self.doc


class FakeDb:
    def __init__(self, doc):
        self.langfuse_config = FakeCollection(doc)


def enabled_doc(**overrides):
    doc = {
        "organizationId": "platform",
        "enabled": True,
        "publicKeyEncrypted": encrypt("pk-test"),
        "secretKeyEncrypted": encrypt("sk-test"),
        "baseUrl": "https://cloud.langfuse.com",
        "samplingRate": 100,
        "captureInputOutput": True,
    }
    doc.update(overrides)
    return doc


class LangfuseConfigTests(unittest.TestCase):
    def setUp(self):
        langfuse_config.invalidate_cache()

    def tearDown(self):
        langfuse_config.invalidate_cache()

    def test_disabled_is_a_clean_noop(self):
        with patch("app.core.langfuse_config.get_db", return_value=FakeDb(None)):
            self.assertFalse(langfuse_config.is_enabled())
            trace_id, trace_url = langfuse_config.record_llm_generation(
                "test", organization_id="org1", user_id="u1", conversation_id="c1", request_id="r1",
                provider="anthropic", model="claude-x", input_tokens=1, output_tokens=1, cost_usd=0.0,
                success=True, error=None,
            )
            self.assertIsNone(trace_id)
            self.assertIsNone(trace_url)
            # Must not raise even when called — a tool span records nothing but must stay silent.
            langfuse_config.record_tool_span("tool", organization_id="org1", user_id="u1", conversation_id="c1", success=True)

    def test_enabled_flag_false_is_treated_as_disabled_even_with_valid_keys(self):
        with patch("app.core.langfuse_config.get_db", return_value=FakeDb(enabled_doc(enabled=False))):
            self.assertFalse(langfuse_config.is_enabled())

    def test_undecryptable_credentials_are_treated_as_disabled_not_raised(self):
        doc = enabled_doc(secretKeyEncrypted="not-valid-ciphertext")
        with patch("app.core.langfuse_config.get_db", return_value=FakeDb(doc)):
            self.assertFalse(langfuse_config.is_enabled())

    def test_sampling_rate_zero_never_samples_in(self):
        for _ in range(20):
            self.assertFalse(langfuse_config._sampled_in(0))

        # A sampling rate of 0 must short-circuit before ever constructing a
        # real Langfuse SDK client — record_llm_generation's own first check.
        doc = enabled_doc(samplingRate=0)
        with patch("app.core.langfuse_config.get_db", return_value=FakeDb(doc)):
            trace_id, trace_url = langfuse_config.record_llm_generation(
                "test", organization_id=None, user_id="", conversation_id="", request_id="",
                provider="anthropic", model="x", input_tokens=0, output_tokens=0, cost_usd=None,
                success=True, error=None,
            )
            self.assertIsNone(trace_id)
            self.assertIsNone(trace_url)

    def test_sampling_rate_hundred_always_samples_in(self):
        for _ in range(20):
            self.assertTrue(langfuse_config._sampled_in(100))

    def test_cache_avoids_a_mongo_round_trip_on_every_call_within_the_ttl(self):
        fake_db = FakeDb(enabled_doc())
        with patch("app.core.langfuse_config.get_db", return_value=fake_db):
            langfuse_config._get_client_and_settings()
            langfuse_config._get_client_and_settings()
            langfuse_config._get_client_and_settings()
            # Exactly one real Mongo read for three calls inside the TTL window —
            # the gap this module explicitly fixes over integration_store.py's
            # always-read-from-Mongo pattern (see this module's own docstring).
            self.assertEqual(fake_db.langfuse_config.find_one_calls, 1)

    def test_invalidate_cache_forces_an_immediate_re_read(self):
        fake_db = FakeDb(enabled_doc())
        with patch("app.core.langfuse_config.get_db", return_value=fake_db):
            langfuse_config._get_client_and_settings()
            self.assertEqual(fake_db.langfuse_config.find_one_calls, 1)
            langfuse_config.invalidate_cache()
            langfuse_config._get_client_and_settings()
            self.assertEqual(fake_db.langfuse_config.find_one_calls, 2)

    def test_a_stale_cached_ttl_expires_and_re_reads(self):
        fake_db = FakeDb(enabled_doc())
        with patch("app.core.langfuse_config.get_db", return_value=fake_db):
            langfuse_config._get_client_and_settings()
            self.assertEqual(fake_db.langfuse_config.find_one_calls, 1)
            with patch("app.core.langfuse_config.time") as fake_time:
                # Jump the clock forward past the TTL — real time.monotonic()
                # already advanced a little during setup, so a 10-minute jump
                # is unambiguous regardless of how fast this test runs.
                fake_time.monotonic.return_value = 10_000_000.0
                langfuse_config._get_client_and_settings()
            self.assertEqual(fake_db.langfuse_config.find_one_calls, 2)


if __name__ == "__main__":
    unittest.main()

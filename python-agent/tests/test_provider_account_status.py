"""Regression tests for app.core.provider_account_status — the cached
reader/writer app.agent.orchestrator (routing skip) and
app.observability.tracing (confirmed-exhaustion marking) both use.

Covers: the TTL cache avoids a Mongo round-trip on every call (same gap
app.core.langfuse_config already fixed for its own config, see that
module's docstring), mark_exhausted() invalidates the cache immediately
rather than waiting out the TTL, and every function degrades to a safe
default (never raises) when Mongo itself is unavailable.

Plain stdlib unittest, matching this project's existing test style. Run with:
    .venv/Scripts/python.exe -m pytest tests/test_provider_account_status.py -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.core.provider_account_status as provider_account_status  # noqa: E402


class FakeCollection:
    def __init__(self, docs):
        self.docs = docs
        self.find_calls = 0
        self.updated = []

    def find(self, _query, _projection):
        self.find_calls += 1
        return self.docs

    def update_one(self, query, update, upsert=False):
        self.updated.append((query, update, upsert))


class FakeDb:
    def __init__(self, docs):
        self.provider_accounts = FakeCollection(docs)


class ProviderAccountStatusTests(unittest.TestCase):
    def setUp(self):
        with provider_account_status._lock:
            provider_account_status._cache.update(at=0.0, status_by_provider={})

    def tearDown(self):
        with provider_account_status._lock:
            provider_account_status._cache.update(at=0.0, status_by_provider={})

    def test_is_exhausted_true_for_a_confirmed_exhausted_provider(self):
        fake_db = FakeDb([{"provider": "anthropic", "status": "exhausted"}, {"provider": "groq", "status": "active"}])
        with patch("app.core.provider_account_status.get_db", return_value=fake_db):
            self.assertTrue(provider_account_status.is_exhausted("anthropic"))
            self.assertFalse(provider_account_status.is_exhausted("groq"))

    def test_an_unconfigured_provider_is_never_treated_as_exhausted(self):
        fake_db = FakeDb([])
        with patch("app.core.provider_account_status.get_db", return_value=fake_db):
            self.assertFalse(provider_account_status.is_exhausted("anthropic"))

    def test_cache_avoids_a_mongo_round_trip_on_every_call_within_the_ttl(self):
        fake_db = FakeDb([{"provider": "anthropic", "status": "exhausted"}])
        with patch("app.core.provider_account_status.get_db", return_value=fake_db):
            provider_account_status.is_exhausted("anthropic")
            provider_account_status.is_exhausted("anthropic")
            provider_account_status.is_exhausted("anthropic")
            self.assertEqual(fake_db.provider_accounts.find_calls, 1)

    def test_mark_exhausted_writes_status_and_invalidates_the_cache_immediately(self):
        fake_db = FakeDb([{"provider": "groq", "status": "active"}])
        with patch("app.core.provider_account_status.get_db", return_value=fake_db):
            self.assertFalse(provider_account_status.is_exhausted("groq"))  # populates the cache as 'active'
            self.assertEqual(fake_db.provider_accounts.find_calls, 1)

            provider_account_status.mark_exhausted("groq")
            self.assertEqual(fake_db.provider_accounts.updated[0][0], {"provider": "groq"})
            self.assertEqual(fake_db.provider_accounts.updated[0][1], {"$set": {"status": "exhausted"}})

            # The cache was invalidated, so the very next check must re-read Mongo
            # rather than return the stale pre-mark value until the TTL expires.
            fake_db.provider_accounts.docs = [{"provider": "groq", "status": "exhausted"}]
            self.assertTrue(provider_account_status.is_exhausted("groq"))
            self.assertEqual(fake_db.provider_accounts.find_calls, 2)

    def test_is_exhausted_never_raises_when_mongo_is_unavailable(self):
        with patch("app.core.provider_account_status.get_db", side_effect=RuntimeError("Mongo is down")):
            self.assertFalse(provider_account_status.is_exhausted("anthropic"))

    def test_mark_exhausted_never_raises_when_mongo_is_unavailable(self):
        with patch("app.core.provider_account_status.get_db", side_effect=RuntimeError("Mongo is down")):
            provider_account_status.mark_exhausted("anthropic")  # must not raise


if __name__ == "__main__":
    unittest.main()

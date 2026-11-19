"""Tests for crm_mongo_sync.py's nightly sync-window enforcement (Hoops: once
a night, after 7:00pm AEST) — the REAL enforcement layer; sync-window.ts on
the NestJS side is only a display mirror (see that file's own docstring).

Confirmed by direct code audit before this fix: no test existed anywhere for
_window_block/_window_due/window_night/next_window_opening/_window_tz, or
for sync_source()'s atomic concurrency claim — this file closes that gap.

Covers the actual production bug fix: the window used to assume a FIXED
UTC+10 offset ("AEST, no daylight saving") regardless of date. Sydney
observes AEDT (UTC+11) roughly Oct-Apr, so during that period the fixed
model read the window as opening/closing an hour later than the real Sydney
clock — exactly "I tried after 7pm and it still said no." _window_tz now
prefers a real IANA zone when the window carries one (`timezone`), falling
back to the fixed offset only for a window saved before that field existed.

Plain stdlib unittest, matching this project's existing convention. Run with:
    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.integrations.crm_mongo_sync import (  # noqa: E402
    _sync_in_progress,
    _window_block,
    _window_due,
    _window_tz,
    discover_source,
    next_window_opening,
    window_night,
    window_opens_label,
)

HOOPS_TZ = {"timezone": "Australia/Sydney", "start": "19:00", "end": "05:00", "label": "AEST"}
HOOPS_FIXED = {"utcOffsetMinutes": 600, "start": "19:00", "end": "05:00", "label": "AEST"}


def utc(iso: str) -> datetime:
    return datetime.fromisoformat(iso).replace(tzinfo=timezone.utc)


class WindowTimezoneTests(unittest.TestCase):
    """The actual bug fix: DST-aware vs. the old fixed-offset model."""

    def test_a_window_with_no_timezone_field_keeps_the_old_fixed_offset_behavior(self):
        self.assertEqual(str(_window_tz(HOOPS_FIXED)), "UTC+10:00")

    def test_a_window_with_a_real_timezone_resolves_to_the_named_zone(self):
        from zoneinfo import ZoneInfo

        self.assertEqual(_window_tz(HOOPS_TZ), ZoneInfo("Australia/Sydney"))

    def test_an_unknown_timezone_name_falls_back_to_the_fixed_offset_instead_of_raising(self):
        window = {"timezone": "Not/A/Real/Zone", "utcOffsetMinutes": 600, "start": "19:00", "end": "05:00"}
        self.assertEqual(str(_window_tz(window)), "UTC+10:00")

    def test_the_window_opens_an_hour_earlier_in_utc_during_aedt_than_the_fixed_model_would(self):
        # 2026-11-18 is inside AEDT (Sydney UTC+11) — 7:00pm Sydney local = 08:00 UTC.
        self.assertIsNone(window_night(HOOPS_TZ, utc("2026-11-18T07:59:00")))
        self.assertEqual(window_night(HOOPS_TZ, utc("2026-11-18T08:00:00")), datetime(2026, 11, 18).date())
        # The OLD fixed-UTC+10 model says this exact real-world instant is
        # still closed (it only opens at 09:00 UTC) — this reproduces the
        # reported bug directly against the pre-fix window shape.
        self.assertIsNone(window_night(HOOPS_FIXED, utc("2026-11-18T08:00:00")))

    def test_matches_the_fixed_offset_model_exactly_during_aest_no_daylight_saving(self):
        # 2026-07-15 is Sydney's winter — real AEST, UTC+10, same as the fixed model.
        self.assertIsNone(window_night(HOOPS_TZ, utc("2026-07-15T08:59:00")))
        self.assertEqual(window_night(HOOPS_TZ, utc("2026-07-15T09:00:00")), datetime(2026, 7, 15).date())
        self.assertEqual(window_night(HOOPS_FIXED, utc("2026-07-15T09:00:00")), datetime(2026, 7, 15).date())

    def test_next_window_opening_is_correct_across_the_dst_boundary(self):
        self.assertEqual(next_window_opening(HOOPS_TZ, utc("2026-11-18T06:00:00")), utc("2026-11-18T08:00:00"))

    def test_window_opens_label_is_unaffected_by_which_offset_model_is_used(self):
        self.assertEqual(window_opens_label(HOOPS_TZ), "7:00pm AEST")
        self.assertEqual(window_opens_label(HOOPS_FIXED), "7:00pm AEST")


class WindowBlockTests(unittest.TestCase):
    """_window_block — why a windowed source (Hoops) mustn't be read right
    now, or None if it may be. Pure function, no Mongo needed."""

    def _source(self, **sync_overrides):
        return {"label": "Hoops CRM", "sync": {"window": HOOPS_TZ, **sync_overrides}}

    def test_outside_the_window_is_blocked_with_a_clear_reason(self):
        reason = _window_block(self._source(), utc("2026-11-18T05:00:00"))
        self.assertIsNotNone(reason)
        self.assertIn("once a night, after 7:00pm AEST", reason)

    def test_inside_the_window_with_no_prior_success_tonight_is_allowed(self):
        self.assertIsNone(_window_block(self._source(), utc("2026-11-18T09:00:00")))

    def test_already_succeeded_tonight_is_blocked_with_a_different_reason(self):
        reason = _window_block(self._source(lastSuccessAt=utc("2026-11-18T08:30:00").isoformat()), utc("2026-11-18T10:00:00"))
        self.assertIsNotNone(reason)
        self.assertIn("Already synced tonight", reason)

    def test_a_success_from_a_previous_night_does_not_block_tonight(self):
        self.assertIsNone(_window_block(self._source(lastSuccessAt=utc("2026-11-17T08:30:00").isoformat()), utc("2026-11-18T09:00:00")))

    def test_a_non_windowed_source_is_never_blocked(self):
        self.assertIsNone(_window_block({"label": "Pantheras CRM", "sync": {}}, utc("2026-11-18T05:00:00")))


class WindowDueTests(unittest.TestCase):
    """_window_due — whether the SCHEDULER should attempt this source right
    now (manual "Sync now" bypasses this and calls _window_block directly —
    see sync_source's own two call sites, confirmed by code reading)."""

    def _source(self, **sync_overrides):
        return {
            "_id": "src-1",
            "organizationId": "org-1",
            "label": "Hoops CRM",
            "sync": {"window": HOOPS_TZ, **sync_overrides},
        }

    def test_blocked_by_the_window_itself_is_never_due(self):
        self.assertFalse(_window_due(self._source(), utc("2026-11-18T05:00:00")))

    def test_never_attempted_tonight_is_due_without_touching_mongo(self):
        with patch("app.integrations.crm_mongo_sync.get_db") as get_db:
            self.assertTrue(_window_due(self._source(), utc("2026-11-18T09:00:00")))
            get_db.assert_not_called()

    def test_a_recent_failed_attempt_tonight_is_not_due_again_within_the_retry_delay(self):
        source = self._source(lastSyncAt=utc("2026-11-18T09:10:00").isoformat())
        with patch("app.integrations.crm_mongo_sync.get_db") as get_db:
            get_db.return_value.crm_sync_runs.count_documents.return_value = 1
            self.assertFalse(_window_due(source, utc("2026-11-18T09:30:00")))

    def test_a_failed_attempt_past_the_retry_delay_is_due_again_up_to_the_try_limit(self):
        source = self._source(lastSyncAt=utc("2026-11-18T09:10:00").isoformat())
        with patch("app.integrations.crm_mongo_sync.get_db") as get_db:
            get_db.return_value.crm_sync_runs.count_documents.return_value = 1
            self.assertTrue(_window_due(source, utc("2026-11-18T10:15:00")))

    def test_already_at_the_max_tries_for_tonight_is_not_due_regardless_of_elapsed_time(self):
        source = self._source(lastSyncAt=utc("2026-11-18T09:10:00").isoformat())
        with patch("app.integrations.crm_mongo_sync.get_db") as get_db:
            get_db.return_value.crm_sync_runs.count_documents.return_value = 3
            self.assertFalse(_window_due(source, utc("2026-11-18T12:00:00")))


class _FakeCrmDataSources:
    """Simulates Mongo's real conditional find_one_and_update semantics for
    exactly the $or filter shape sync_source() itself uses — narrow and
    hand-rolled on purpose (not a generic Mongo mock), so this proves the
    REAL function's claim logic, not a re-implementation of it."""

    def __init__(self, doc: dict):
        self.doc = doc

    def find_one_and_update(self, filter_, update):
        if self.doc.get("_id") != filter_["_id"]:
            return None
        sync = self.doc.get("sync", {})
        clause_a = sync.get("lastStatus") != "running"
        running_since = sync.get("runningSince")
        clause_b = running_since is not None and running_since < filter_["$or"][1]["sync.runningSince"]["$lt"]
        if not (clause_a or clause_b):
            return None
        self.doc["sync"] = {**sync, **{k.split(".", 1)[1]: v for k, v in update["$set"].items()}}
        return self.doc

    def update_one(self, filter_, update):
        # sync_source's own error-path write (describe_failure's outcome) —
        # not under test here, just needs to not blow up on the mock.
        if "$set" in update:
            self.doc["sync"] = {**self.doc.get("sync", {}), **{k.split(".", 1)[1]: v for k, v in update["$set"].items()}}


class SyncSourceConcurrencyClaimTests(unittest.TestCase):
    """sync_source()'s atomic claim for a windowed source (Hoops) — the REAL
    function, not a re-implementation, with get_db()/adapter_for() mocked
    just enough to isolate the claim gate from the rest of a real sync."""

    def _source(self, sync_doc):
        return {"_id": "src-1", "organizationId": "org-1", "label": "Hoops CRM", "modules": [], "sync": {"window": HOOPS_TZ, **sync_doc}}

    def _run(self, existing_sync_doc):
        from app.integrations.crm_mongo_sync import sync_source

        doc = {"_id": "src-1", "sync": existing_sync_doc}
        fake_collection = _FakeCrmDataSources(doc)
        fake_db = MagicMock()
        fake_db.crm_data_sources = fake_collection
        with patch("app.integrations.crm_mongo_sync.get_db", return_value=fake_db), patch(
            "app.integrations.crm_mongo_sync._now", return_value=utc("2026-11-18T09:00:00")
        ), patch("app.integrations.crm_mongo_sync.adapter_for", side_effect=RuntimeError("stop before a real sync — claim gate only")) as adapter_for:
            result = sync_source(self._source(existing_sync_doc))
        return result, adapter_for

    def test_a_source_not_currently_running_is_claimed_and_proceeds_to_the_real_sync(self):
        result, adapter_for = self._run({"lastStatus": "idle"})
        # Claim succeeded, so sync_source went on to call adapter_for (which
        # we made raise) — the error, not a deferral, proves the claim passed.
        self.assertEqual(result.get("status"), "error")
        adapter_for.assert_called_once()

    def test_a_source_already_running_is_deferred_without_ever_reaching_adapter_for(self):
        result, adapter_for = self._run({"lastStatus": "running", "runningSince": utc("2026-11-18T08:50:00")})
        self.assertEqual(result, {"status": "deferred", "message": "Hoops CRM is already being synced.", "nextRunAt": None})
        adapter_for.assert_not_called()

    def test_a_stale_running_flag_past_45_minutes_is_reclaimed_and_proceeds(self):
        result, adapter_for = self._run({"lastStatus": "running", "runningSince": utc("2026-11-18T08:00:00")})
        self.assertEqual(result.get("status"), "error")
        adapter_for.assert_called_once()


class SyncInProgressTests(unittest.TestCase):
    """_sync_in_progress — the read-only mirror of sync_source()'s own claim
    condition that discover_source() uses to step aside instead of
    contending with an already-running sync for the same account."""

    def _source(self, **sync_overrides):
        return {"sync": {**sync_overrides}}

    def test_not_running_at_all_is_never_in_progress(self):
        self.assertFalse(_sync_in_progress(self._source(lastStatus="ok"), utc("2026-11-18T09:00:00")))
        self.assertFalse(_sync_in_progress({"sync": {}}, utc("2026-11-18T09:00:00")))

    def test_running_and_recent_is_in_progress(self):
        source = self._source(lastStatus="running", runningSince=utc("2026-11-18T08:50:00"))
        self.assertTrue(_sync_in_progress(source, utc("2026-11-18T09:00:00")))

    def test_running_but_stale_past_45_minutes_is_not_in_progress(self):
        source = self._source(lastStatus="running", runningSince=utc("2026-11-18T08:00:00"))
        self.assertFalse(_sync_in_progress(source, utc("2026-11-18T09:00:00")))

    def test_running_with_no_runningSince_at_all_is_treated_as_in_progress(self):
        # Matches sync_source()'s own Mongo claim query: a missing
        # runningSince never satisfies the "$lt" staleness clause, so the
        # claim (and this read-only mirror of it) both treat it as running.
        self.assertTrue(_sync_in_progress(self._source(lastStatus="running"), utc("2026-11-18T09:00:00")))


class DiscoverSourceBusyCheckTests(unittest.TestCase):
    """discover_source()'s awareness of an already-running sync for the same
    (windowed, one-request-at-a-time) account — the actual root cause of a
    real "HaiVE couldn't check the connection right now" report on a
    genuinely valid Hoops key: discover_source() and sync_source() share the
    same Hoops API key but, before this fix, had no awareness of each other,
    so a connection check started mid-sync made Hoops' own 429 land on the
    discover call, which then retried for up to ~110s per list, twice over."""

    def _hoops_source(self, **sync_overrides):
        return {"_id": "src-1", "organizationId": "org-1", "label": "Hoops CRM", "provider": "hoops", "modules": [], "sync": {"window": HOOPS_TZ, **sync_overrides}}

    def _non_windowed_source(self, **sync_overrides):
        return {"_id": "src-2", "organizationId": "org-1", "label": "Pantheras CRM", "provider": "prospectconnect", "modules": [], "sync": {**sync_overrides}}

    def _fake_adapter(self):
        adapter = MagicMock()
        adapter.modules = ()  # nothing to read — proves adapter_for was reached, without a real Hoops/HTTP call
        return adapter

    def test_a_sync_already_running_for_this_hoops_account_is_declined_fast_without_ever_calling_adapter_for(self):
        source = self._hoops_source(lastStatus="running", runningSince=utc("2026-11-18T08:50:00"))
        with patch("app.integrations.crm_mongo_sync._now", return_value=utc("2026-11-18T09:00:00")), patch(
            "app.integrations.crm_mongo_sync.adapter_for", side_effect=AssertionError("must not be called while a sync is running")
        ) as adapter_for:
            result = discover_source(source)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["kind"], "busy")
        self.assertIn("already syncing", result["message"])
        adapter_for.assert_not_called()

    def test_no_sync_currently_running_proceeds_to_the_real_discovery(self):
        source = self._hoops_source(lastStatus="ok")
        with patch("app.integrations.crm_mongo_sync._now", return_value=utc("2026-11-18T09:00:00")), patch(
            "app.integrations.crm_mongo_sync.adapter_for", return_value=self._fake_adapter()
        ) as adapter_for:
            result = discover_source(source)
        self.assertEqual(result, {"status": "ok", "modules": {}})
        adapter_for.assert_called_once()

    def test_a_stale_running_flag_past_45_minutes_does_not_block_discovery_either(self):
        source = self._hoops_source(lastStatus="running", runningSince=utc("2026-11-18T08:00:00"))
        with patch("app.integrations.crm_mongo_sync._now", return_value=utc("2026-11-18T09:00:00")), patch(
            "app.integrations.crm_mongo_sync.adapter_for", return_value=self._fake_adapter()
        ) as adapter_for:
            result = discover_source(source)
        self.assertEqual(result["status"], "ok")
        adapter_for.assert_called_once()

    def test_a_non_windowed_provider_is_never_subject_to_the_busy_check_even_while_marked_running(self):
        # The busy-check only applies to one-request-at-a-time providers
        # (sync.window set) — a plain-interval CRM never has this Hoops-
        # specific constraint, so its own "running" flag must never block
        # its own discover() call. Confirms the fix is scoped to Hoops,
        # never changing behaviour for any other CRM.
        source = self._non_windowed_source(lastStatus="running", runningSince=utc("2026-11-18T08:59:00"))
        with patch("app.integrations.crm_mongo_sync._now", return_value=utc("2026-11-18T09:00:00")), patch(
            "app.integrations.crm_mongo_sync.adapter_for", return_value=self._fake_adapter()
        ) as adapter_for:
            result = discover_source(source)
        self.assertEqual(result["status"], "ok")
        adapter_for.assert_called_once()


if __name__ == "__main__":
    unittest.main()

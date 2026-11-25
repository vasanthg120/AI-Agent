"""Live CRM data: a page open reads what is stale, in the background, one read at a time per
source; Hoops (nightly window) is never read here; the timer only drives nightly sources."""

import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.integrations import crm_mongo_sync as sync  # noqa: E402

NOW = datetime(2026, 11, 25, 6, 0, tzinfo=timezone.utc)
WINDOW = {"start": "19:00", "end": "23:59", "timezone": "Australia/Sydney"}


def source(key: str, provider: str, last_minutes_ago: float | None, window: bool = False, status: str = "ok") -> dict:
    s = {"_id": key, "provider": provider, "label": provider.title(), "organizationId": "org1", "sync": {"lastStatus": status}}
    if last_minutes_ago is not None:
        s["sync"]["lastSyncAt"] = NOW - timedelta(minutes=last_minutes_ago)
    if window:
        s["sync"]["window"] = WINDOW
    return s


class FakeSources:
    def __init__(self, claimable: set[str]):
        self.claimable = claimable
        self.claimed: list[str] = []

    def find_one_and_update(self, query, update):
        key = query["_id"]
        if key in self.claimable:
            self.claimed.append(key)
            return {"_id": key}
        return None


class FakeDb:
    def __init__(self, claimable: set[str]):
        self.crm_data_sources = FakeSources(claimable)


class Adapter:
    def __init__(self, incremental: bool):
        self.incremental = incremental


class RefreshOrgLiveTest(unittest.TestCase):
    def run_refresh(self, sources: list[dict], claimable: set[str]):
        db = FakeDb(claimable)
        ran: list[str] = []
        done = threading.Event()

        def fake_sync(src, trigger="scheduled"):
            ran.append(f"{src['_id']}:{trigger}")
            done.set()
            return {"status": "ok"}

        def fake_adapter(src):
            return Adapter(incremental=src["provider"] in ("gorilladash", "hoops"))

        with (
            mock.patch.object(sync, "_now", return_value=NOW),
            mock.patch.object(sync, "get_db", return_value=db),
            mock.patch.object(sync, "_syncable_sources", return_value=sources),
            mock.patch.object(sync, "sync_source", side_effect=fake_sync),
            mock.patch.object(sync, "adapter_for", side_effect=fake_adapter),
        ):
            result = sync.refresh_org_live("org1")
            for t in list(sync._live_threads.values()):
                t.join(timeout=5)
        return result, ran, db

    def test_reads_only_what_is_stale_and_never_hoops(self):
        sources = [
            source("gd", "gorilladash", last_minutes_ago=5),  # stale (incremental: 60 s)
            source("pc", "prospectconnect", last_minutes_ago=1),  # fresh enough (full read: 3 min)
            source("hp", "hoops", last_minutes_ago=600, window=True),  # nightly only
        ]
        result, ran, db = self.run_refresh(sources, claimable={"gd", "pc", "hp"})
        self.assertEqual(ran, ["gd:live"])
        self.assertEqual(db.crm_data_sources.claimed, ["gd"])
        by_id = {s["id"]: s for s in result["sources"]}
        self.assertEqual((by_id["gd"]["mode"], by_id["gd"]["refreshing"]), ("live", True))
        self.assertEqual((by_id["pc"]["mode"], by_id["pc"]["refreshing"]), ("live", False))
        self.assertEqual((by_id["hp"]["mode"], by_id["hp"]["refreshing"]), ("nightly", False))
        self.assertIsNotNone(by_id["hp"]["nextNightlyAt"])

    def test_a_full_read_crm_is_asked_less_often(self):
        result, ran, _ = self.run_refresh([source("pc", "prospectconnect", last_minutes_ago=4)], claimable={"pc"})
        self.assertEqual(ran, ["pc:live"])
        result, ran, _ = self.run_refresh([source("pc", "prospectconnect", last_minutes_ago=2)], claimable={"pc"})
        self.assertEqual(ran, [])

    def test_one_read_at_a_time(self):
        # Another process is already reading it: not claimed, shown as being read, not read twice.
        result, ran, _ = self.run_refresh([source("gd", "gorilladash", last_minutes_ago=30, status="running")], claimable=set())
        self.assertEqual(ran, [])
        self.assertTrue(result["sources"][0]["refreshing"])

    def test_never_read_is_read(self):
        result, ran, _ = self.run_refresh([source("gd", "gorilladash", last_minutes_ago=None)], claimable={"gd"})
        self.assertEqual(ran, ["gd:live"])


class TimerOnlyNightlyTest(unittest.TestCase):
    def test_the_timer_reads_only_nightly_sources(self):
        sources = [source("gd", "gorilladash", last_minutes_ago=600), source("hp", "hoops", last_minutes_ago=2000, window=True)]
        ran: list[str] = []
        with (
            mock.patch.object(sync, "_syncable_sources", return_value=sources),
            mock.patch.object(sync, "_due", return_value=True),
            mock.patch.object(sync, "sync_source", side_effect=lambda s, *a, **k: ran.append(s["_id"]) or {"status": "ok"}),
        ):
            sync.sync_all_due()
        self.assertEqual(ran, ["hp"])


if __name__ == "__main__":
    unittest.main()

"""When a synced deal was closed (Deal.closedAt) — the date its revenue counts on.

Revenue is a won deal's value in the month it was CLOSED (the backend's
crm/deal-filter.util.ts). Until 2026-11-25 the sync stamped a newly won deal's
expected closing date with today instead, and the next sync wrote the CRM's
forecast back: "Noble hospital - Uniforms", expected 29 Jul and won 16 Nov,
went back to July's revenue. These pin the replacement: the expected closing
date stays as the CRM has it, and closedAt carries the closing day.

Plain stdlib unittest on the pure functions the sync calls, like
test_crm_sync_owner_resolution.py — no Mongo needed.
"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.integrations.crm_mongo_sync import _closed_at, _deal_update  # noqa: E402

_SOURCE = {
    "_id": "src-1",
    "organizationId": "org-1",
    "provider": "prospectconnect",
    "fieldMappings": {"deals": {"externalId": "id", "name": "name", "amount": "amount", "status": "status", "closeDate": "close"}},
    "statusMapping": {"won": ["won"], "lost": ["lost"]},
}


def _raw(status: str, close: str | None) -> dict:
    return {"id": "d1", "name": "Noble hospital - Uniforms", "amount": 291373.95, "status": status, "close": close}


def _update(raw: dict, existing: dict | None, tz_name: str = "Asia/Kolkata"):
    op = _deal_update(_SOURCE, None, raw, {"d1": existing} if existing else {}, {}, {}, tz_name=tz_name)
    return op._doc


class ClosedAtTests(unittest.TestCase):
    def test_won_with_the_forecast_unchanged_is_closed_now_and_keeps_the_forecast(self):
        before = datetime.now(timezone.utc)
        doc = _update(_raw("won", "2026-07-29"), {"dealStatus": "open", "expectedClosingDate": "2026-07-29"})
        self.assertGreaterEqual(doc["$set"]["closedAt"], before)
        # Never stamped with today any more: the next sync would only write the forecast back.
        self.assertEqual(doc["$set"]["expectedClosingDate"], "2026-07-29")

    def test_the_next_sync_leaves_closed_at_alone(self):
        doc = _update(_raw("won", "2026-07-29"), {"dealStatus": "won", "expectedClosingDate": "2026-07-29"})
        self.assertNotIn("closedAt", doc["$set"])
        self.assertNotIn("$unset", doc)

    def test_a_crm_that_dates_the_closing_gives_its_own_day(self):
        # Hoops: an open quote carries its deadline; once won, the day of its job —
        # here read two nights late, still dated by the job.
        doc = _update(_raw("won", "2026-11-20"), {"dealStatus": "open", "expectedClosingDate": "2026-12-20"}, "Australia/Sydney")
        self.assertEqual(doc["$set"]["closedAt"], datetime(2026, 11, 20, 1, 0, tzinfo=timezone.utc))  # noon AEDT

    def test_a_new_date_in_the_future_is_not_a_closing_day(self):
        now = datetime(2026, 11, 16, 7, 44, tzinfo=timezone.utc)
        self.assertEqual(_closed_at("2026-11-30", "2026-07-29", "Asia/Kolkata", now), now)

    def test_today_before_noon_is_now_not_later_today(self):
        now = datetime(2026, 11, 16, 3, 0, tzinfo=timezone.utc)  # 08:30 in India
        self.assertEqual(_closed_at("2026-11-16", "2026-07-29", "Asia/Kolkata", now), now)

    def test_a_deal_with_no_date_at_all_is_closed_now(self):
        now = datetime(2026, 11, 24, 10, 59, tzinfo=timezone.utc)
        self.assertEqual(_closed_at(None, None, "Asia/Kolkata", now), now)

    def test_reopening_clears_it(self):
        doc = _update(_raw("open", "2026-12-15"), {"dealStatus": "won", "expectedClosingDate": "2026-07-29"})
        self.assertEqual(doc["$unset"], {"closedAt": ""})
        self.assertNotIn("closedAt", doc["$set"])

    def test_a_deal_first_seen_already_won_has_no_known_closing_time(self):
        doc = _update(_raw("won", "2026-07-29"), None)
        self.assertNotIn("closedAt", doc["$set"])


if __name__ == "__main__":
    unittest.main()

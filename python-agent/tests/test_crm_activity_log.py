"""The CRM activity log as the sync writes it (app.integrations.crm_mongo_sync):
_deal_activity/_quote_activity are pure — given what the CRM sends and the copy
stored before this sync, they say what changed. No Mongo needed.

What matters: a record seen for the first time is logged as created with the
CRM's own date; a sync that runs again with nothing changed logs nothing; a
status change is logged from -> to; a source's very first import never makes
the CRM's whole history look created today; the keys are the backend
backfill's (crm-activity.service.ts), so the two never double a row.
"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.integrations.crm_mongo_sync import _deal_activity, _is_sent_quote_status, _midday, _quote_activity  # noqa: E402

_SOURCE = {
    "_id": "src-1",
    "organizationId": "org-1",
    "provider": "hoops",
    "statusMapping": {"won": ["won"], "lost": ["lost"]},
    "fieldMappings": {
        "deals": {"externalId": "id", "name": "name", "owner": "owner", "amount": "amount", "status": "status", "closeDate": "close", "createdAt": "created"},
        "quotes": {
            "externalId": "id",
            "number": "number",
            "name": "name",
            "owner": "owner",
            "ownerName": "ownerName",
            "amount": "amount",
            "status": "status",
            "approvalStatus": "approval",
            "createdAt": "created",
            "customerCompany": "company",
        },
    },
}
_NOW = datetime(2026, 11, 11, 5, 0, tzinfo=timezone.utc)


def _deal(**over):
    return {"id": "d1", "name": "Polos for Sundar", "amount": 118000, "status": "open", "owner": "kshitij", "created": "2026-11-02T04:00:00Z", **over}


def _quote(**over):
    return {
        "id": "q1",
        "number": "4472",
        "name": "Polos",
        "amount": 118000,
        "status": "draft",
        "approval": "pending",
        "owner": "kshitij",
        "ownerName": "Kshitij Hedge",
        "company": "Sundar Textiles",
        "created": "2026-11-03T04:00:00Z",
        **over,
    }


class DealActivityTests(unittest.TestCase):
    def test_new_deal_is_logged_created_on_the_crms_date(self):
        rows = _deal_activity(_SOURCE, _deal(), None, False, "Asia/Kolkata", _NOW)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["kind"], row["occurredAtBasis"], row["dedupeKey"]), ("created", "crm", "src-1:deal:d1:created"))
        self.assertEqual(row["occurredAt"], datetime(2026, 11, 2, 4, 0, tzinfo=timezone.utc))
        self.assertEqual((row["ref"], row["value"], row["crmOwnerRef"], row["origin"]), ("Polos for Sundar", 118000, "kshitij", "crm_sync"))

    def test_nothing_changed_nothing_logged(self):
        existing = {"dealStatus": "open"}
        self.assertEqual(_deal_activity(_SOURCE, _deal(), existing, False, "Asia/Kolkata", _NOW), [])

    def test_status_change_is_logged_from_and_to_when_the_sync_saw_it(self):
        rows = _deal_activity(_SOURCE, _deal(status="won"), {"dealStatus": "open"}, False, "Asia/Kolkata", _NOW)
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            (rows[0]["kind"], rows[0]["fromStatus"], rows[0]["toStatus"], rows[0]["occurredAt"], rows[0]["occurredAtBasis"], rows[0]["dedupeKey"]),
            ("won", "open", "won", _NOW, "detected", "src-1:deal:d1:won:2026-11-11"),
        )
        reopened = _deal_activity(_SOURCE, _deal(status="open"), {"dealStatus": "lost"}, False, "Asia/Kolkata", _NOW)
        self.assertEqual(reopened[0]["kind"], "reopened")

    def test_a_deal_arriving_already_won_is_won_on_its_closing_date(self):
        rows = _deal_activity(_SOURCE, _deal(status="won", close="2026-10-30"), None, False, "Australia/Sydney", _NOW)
        won = [r for r in rows if r["kind"] == "won"][0]
        self.assertEqual(won["occurredAtBasis"], "closing_date")
        # Noon in Sydney on 30 October 2026 (+11) is 01:00 UTC the same day.
        self.assertEqual(won["occurredAt"], datetime(2026, 10, 30, 1, 0, tzinfo=timezone.utc))
        self.assertEqual(won["dedupeKey"], "src-1:deal:d1:won:2026-10-30")

    def test_first_import_never_invents_created_today(self):
        no_crm_date = _deal(created=None)
        self.assertEqual(_deal_activity(_SOURCE, no_crm_date, None, True, "Asia/Kolkata", _NOW), [])
        # After the first import, a new deal without a CRM date is logged when the sync first saw it.
        later = _deal_activity(_SOURCE, no_crm_date, None, False, "Asia/Kolkata", _NOW)
        self.assertEqual((later[0]["occurredAt"], later[0]["occurredAtBasis"]), (_NOW, "detected"))
        # A closed deal with no closing date during the first import: when it closed is unknown, so nothing.
        self.assertEqual(_deal_activity(_SOURCE, _deal(created=None, status="lost"), None, True, "Asia/Kolkata", _NOW), [])


class QuoteActivityTests(unittest.TestCase):
    def test_new_draft_is_created_only(self):
        rows = _quote_activity(_SOURCE, _quote(), None, False, "deal-1", _NOW)
        self.assertEqual([r["kind"] for r in rows], ["created"])
        self.assertEqual(
            (rows[0]["ref"], rows[0]["customerName"], rows[0]["crmOwnerLabel"], rows[0]["dealId"], rows[0]["dedupeKey"]),
            ("4472", "Sundar Textiles", "Kshitij Hedge", "deal-1", "src-1:quote:q1:created"),
        )

    def test_new_quote_already_sent_counts_as_sent_when_created_but_acceptance_time_is_not_invented(self):
        rows = _quote_activity(_SOURCE, _quote(status="accepted", approval="approved"), None, False, None, _NOW)
        self.assertEqual([r["kind"] for r in rows], ["created", "sent"])
        self.assertEqual((rows[1]["occurredAtBasis"], rows[1]["occurredAt"]), ("assumed", rows[0]["occurredAt"]))

    def test_sent_and_accepted_when_the_sync_sees_them(self):
        sent = _quote_activity(_SOURCE, _quote(status="sent"), {"quoteStatus": "draft", "clientApprovalStatus": "pending"}, False, None, _NOW)
        self.assertEqual([(r["kind"], r["fromStatus"], r["toStatus"], r["dedupeKey"]) for r in sent], [("sent", "draft", "sent", "src-1:quote:q1:sent")])
        accepted = _quote_activity(
            _SOURCE, _quote(status="accepted", approval="approved"), {"quoteStatus": "viewed", "clientApprovalStatus": "pending"}, False, None, _NOW
        )
        self.assertEqual([(r["kind"], r["dedupeKey"]) for r in accepted], [("accepted", "src-1:quote:q1:accepted:2026-11-11")])
        # Viewed after sent is not sent again; nothing else changed.
        self.assertEqual(_quote_activity(_SOURCE, _quote(status="viewed"), {"quoteStatus": "sent", "clientApprovalStatus": "pending"}, False, None, _NOW), [])

    def test_voided_is_never_sent(self):
        self.assertFalse(_is_sent_quote_status("voided"))
        self.assertFalse(_is_sent_quote_status("draft"))
        self.assertTrue(_is_sent_quote_status("published"))
        rows = _quote_activity(_SOURCE, _quote(status="voided"), {"quoteStatus": "draft", "clientApprovalStatus": "pending"}, False, None, _NOW)
        self.assertEqual(rows, [])

    def test_midday_falls_back_to_india_for_an_unknown_zone(self):
        self.assertEqual(_midday("Mars/Olympus", "2026-11-11"), datetime(2026, 11, 11, 6, 30, tzinfo=timezone.utc))


if __name__ == "__main__":
    unittest.main()

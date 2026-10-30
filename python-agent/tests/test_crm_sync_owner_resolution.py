"""Regression tests for CRM sync owner resolution — the multi-user deal-
owner mapping feature's "future syncs" policy (see
backend/src/crm/deal-owner-mapping.service.ts's own header comment and
backend/src/crm/schemas/deal-owner-mapping.schema.ts's ownerId/linkedUserIds
comments for the full design).

_deal_update/_quote_update (app.integrations.crm_mongo_sync) are pure
functions — no Mongo needed to test the two policy points that actually
matter, called directly with crafted inputs:

1. A DealOwnerMapping linking more than one HaiVE user to an external
   salesperson has no `ownerId` field at all (ambiguous — see the schema's
   own comment). _sync_deals/_sync_quotes now build owner_mapping_by_ref
   with an explicit `{"ownerId": {"$exists": True, "$ne": None}}` filter, so
   an ambiguous mapping is excluded from the dict entirely before
   _deal_update/_quote_update ever see it — proven here by simulating
   exactly what that filtered dict looks like (the ref simply isn't a key).
2. A deal whose owner was set by an explicit admin/manager assignment
   (Deal.ownerAssignedManually, set by deals.service.ts's assignOwner/
   assignOwnerBulk) must never be overwritten by a mapped owner, no matter
   how many times sync runs again.

Plain stdlib unittest — this project has no pytest dependency and no
Mongo-backed Python test fixtures established yet; these are pure
unit tests of the exact functions sync calls, with no mocking needed since
neither function touches Mongo/network itself.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.integrations.crm_mongo_sync import _deal_update, _quote_update  # noqa: E402

_SOURCE = {
    "_id": "src-1",
    "organizationId": "org-1",
    "provider": "prospectconnect",
    "fieldMappings": {
        "deals": {"externalId": "id", "name": "name", "owner": "owner", "amount": "amount", "status": "status"},
        "quotes": {"externalId": "id", "name": "name", "owner": "owner", "amount": "amount"},
    },
}


def _raw_deal(external_id: str, owner_ref: str) -> dict:
    return {"id": external_id, "name": "Test Deal", "owner": owner_ref, "amount": 1000, "status": "open"}


class DealOwnerResolutionTests(unittest.TestCase):
    def test_unambiguous_mapping_still_auto_assigns_a_never_touched_deal(self):
        # Preserves today's exact single-user behavior — the baseline this
        # whole feature must not regress.
        owner_mapping_by_ref = {"ext-owner-1": "user-a"}
        op = _deal_update(_SOURCE, None, _raw_deal("d1", "ext-owner-1"), {}, owner_mapping_by_ref, {})
        self.assertEqual(op._doc["$set"]["ownerId"], "user-a")

    def test_ambiguous_mapping_excluded_upstream_never_auto_assigns(self):
        # Simulates exactly what _sync_deals' now-filtered Mongo query
        # produces for an ambiguous (2+ linked users) mapping: the ref is
        # simply not a key in the dict at all.
        owner_mapping_by_ref: dict = {}
        op = _deal_update(_SOURCE, None, _raw_deal("d1", "ext-owner-ambiguous"), {}, owner_mapping_by_ref, {})
        self.assertNotIn("ownerId", op._doc["$set"])

    def test_manually_assigned_deal_is_never_overwritten_by_a_mapping_on_resync(self):
        owner_mapping_by_ref = {"ext-owner-1": "user-b"}  # mapping now points at a DIFFERENT user
        existing = {"externalId": "d1", "ownerId": "user-a", "ownerAssignedManually": True}
        op = _deal_update(_SOURCE, None, _raw_deal("d1", "ext-owner-1"), {"d1": existing}, owner_mapping_by_ref, {})
        self.assertNotIn("ownerId", op._doc["$set"])

    def test_a_deal_never_manually_touched_still_follows_relinked_mapping(self):
        # The contrast case: without the manual flag, a changed mapping
        # (e.g. an admin re-linked this salesperson to someone else) still
        # applies on the next sync — only the manual flag protects a deal,
        # not merely having had SOME owner before.
        owner_mapping_by_ref = {"ext-owner-1": "user-b"}
        existing = {"externalId": "d1", "ownerId": "user-a"}
        op = _deal_update(_SOURCE, None, _raw_deal("d1", "ext-owner-1"), {"d1": existing}, owner_mapping_by_ref, {})
        self.assertEqual(op._doc["$set"]["ownerId"], "user-b")

    def test_a_deal_with_no_owner_yet_and_an_ambiguous_mapping_stays_pending(self):
        existing = {"externalId": "d1"}  # no ownerId at all yet
        op = _deal_update(_SOURCE, None, _raw_deal("d1", "ext-owner-ambiguous"), {"d1": existing}, {}, {})
        self.assertNotIn("ownerId", op._doc["$set"])


class QuoteOwnerResolutionTests(unittest.TestCase):
    def _raw_quote(self, external_id: str, owner_ref: str) -> dict:
        return {"id": external_id, "name": "Test Quote", "owner": owner_ref, "amount": 500}

    def test_unambiguous_mapping_still_sets_quote_owner(self):
        quote_owner_mapping_by_ref = {"ext-owner-1": "user-a"}
        op = _quote_update(_SOURCE, self._raw_quote("q1", "ext-owner-1"), {}, {}, quote_owner_mapping_by_ref)
        self.assertEqual(op._doc["$set"]["ownerUserId"], "user-a")

    def test_ambiguous_mapping_excluded_upstream_never_sets_quote_owner(self):
        op = _quote_update(_SOURCE, self._raw_quote("q1", "ext-owner-ambiguous"), {}, {}, {})
        self.assertNotIn("ownerUserId", op._doc["$set"])


if __name__ == "__main__":
    unittest.main()

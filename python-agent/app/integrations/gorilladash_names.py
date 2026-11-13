"""Names for the Gorilla Dash enquiries stored as "Untitled deal".

Until 2026-11-13 the sync named a record from the first/last/business name on the
record itself. That is right for a Gorilla Dash person, but an enquiry carries
them on its "person" — so every enquiry was stored as "Untitled deal" (268 of
them on the local data), and nothing about the customer could be found from it.
gorilladash.display_name now reads both; this gives the enquiries already stored
their name, from the copy of the enquiry each deal keeps (`sourceData`) — without
asking Gorilla Dash for anything. Their CRM activity rows ("deal created") get the
same name. Runs at python-agent startup; a deal that has a real name is never
touched, so running it again changes nothing.
"""

from __future__ import annotations

import logging

from pymongo import UpdateMany, UpdateOne

from app.integrations.gorilladash import display_name
from app.memory.mongo_client import get_db

logger = logging.getLogger(__name__)

UNTITLED = ("Untitled deal", "", None)


def name_for(source_data: dict | None) -> str | None:
    """The enquiry's name, or None when its stored copy has nothing to name it by."""
    if not isinstance(source_data, dict):
        return None
    name = display_name(source_data)
    # The last resort ("Inquiry Form enquiry") is still better than "Untitled deal".
    return name or None


def repair_gorilladash_names(db=None) -> int:
    db = db if db is not None else get_db()
    deals = db.crm_deals.find(
        {"sourceProvider": "gorilladash", "name": {"$in": list(UNTITLED)}, "sourceData": {"$exists": True}},
        {"_id": 1, "organizationId": 1, "sourceData": 1},
    )
    deal_writes = []
    activity_writes = []
    for deal in deals:
        name = name_for(deal.get("sourceData"))
        if not name:
            continue
        deal_writes.append(UpdateOne({"_id": deal["_id"], "name": {"$in": list(UNTITLED)}}, {"$set": {"name": name}}))
        activity_writes.append(
            UpdateMany(
                {"organizationId": deal.get("organizationId"), "entity": "deal", "entityId": str(deal["_id"]), "ref": {"$in": list(UNTITLED)}},
                {"$set": {"ref": name}},
            )
        )
    if not deal_writes:
        return 0
    db.crm_deals.bulk_write(deal_writes, ordered=False)
    if activity_writes:
        db.crm_activities.bulk_write(activity_writes, ordered=False)
    logger.info("Gorilla Dash enquiries named: %d", len(deal_writes))
    return len(deal_writes)

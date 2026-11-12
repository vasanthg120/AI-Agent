"""One-time move of the Hoops sales already stored to the current won rule.

Until 2026-11-11 a Hoops sale was won when its quote was accepted. It is now
read as Hoops' own jobs report reads it (see hoops.transaction_fields): won
when its JOB IS CREATED, dated by the job; in the pipeline (`inPipeline`) while
that job is work in progress; an accepted quote with no job yet is open. (For a
few hours on 2026-11-11 it was "won when invoiced", before the user's jobs
report showed the rule; sources moved to that are moved on again.) New and
changed sales get the rule from the nightly sync; this re-classifies the ones
stored before, once per Hoops source, from the copy of its transaction each
deal keeps (`sourceData`: status, flags, jobs, invoice) — without asking Hoops
for anything (it allows one read a night).

It is a change of rule, not of the sales themselves, so it:
- writes no CRM activity rows (no "won"/"reopened" today for ~500 old sales,
  which Team Performance would credit to the salespeople);
- leaves lastActivityAt alone (nothing was worked on);
- clears closedAt only on a sale that is no longer closed, and sets none (when
  HaiVE first saw an invoice is unknown; the closing date stands in for it).

Runs at python-agent startup, holding the same claim a sync holds, so a nightly
sync never runs at the same time; a source whose sync is running is left for
the next start. Its status words move from an earlier default (accepted,
completed — or invoiced) to the current one (job); words an admin changed are kept.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from pymongo import UpdateOne

from app.integrations import hoops
from app.integrations.crm_adapters import map_status
from app.memory.mongo_client import get_db

logger = logging.getLogger(__name__)

RULE = "job-created-2026-11-11"
# Every default the won words have had; only these are replaced.
OLD_WON_WORDS = (["accepted", "completed"], ["invoiced"])
NEW_WON_WORDS = ["job"]
_STALE_CLAIM = timedelta(minutes=45)  # the sync's own rule for a claim left by a crash


def _iso(value) -> str | None:
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()
    return str(value) if value else None


def status_mapping_for(saved: dict | None) -> tuple[dict, bool]:
    """The source's won/lost words under the current rule, and whether they changed.
    Only the untouched old default is replaced — an admin's own words are kept."""
    saved = dict(saved or {})
    won = sorted(str(w).strip().lower() for w in saved.get("won") or [])
    if any(won == sorted(old) for old in OLD_WON_WORDS):
        return {**saved, "won": list(NEW_WON_WORDS), "lost": saved.get("lost") or ["voided"]}, True
    return saved, False


def reclassified(deal: dict, status_mapping: dict, currency: str, zone=None) -> dict | None:
    """What a stored Hoops deal's status, stage and closing date are under the
    current rule, from the transaction it keeps — or None when it keeps none.
    Fields its kept copy can't settle (a lost sale's date without voidedAt) stay as stored."""
    detail = deal.get("sourceData")
    if not isinstance(detail, dict) or not detail:
        return None
    row = {**detail, "_id": deal.get("externalId"), "createdAt": _iso(deal.get("createdAt"))}
    fields = hoops.transaction_fields(row, currency, zone)
    status = map_status(fields.get("_status"), status_mapping)
    return {
        "dealStatus": status,
        "stageId": fields.get("_stage"),
        "expectedClosingDate": fields.get("_closeDate") or deal.get("expectedClosingDate"),
        "inPipeline": bool(fields.get("_inPipeline")),
    }


def _update_for(deal: dict, target: dict) -> UpdateOne | None:
    changes = {k: v for k, v in target.items() if deal.get(k) != v}
    if not changes:
        return None
    update: dict = {"$set": changes}
    # No longer closed: it has no closing moment. (Newly closed: when is unknown, none is set.)
    if "dealStatus" in changes and target["dealStatus"] == "open" and deal.get("closedAt") is not None:
        update["$unset"] = {"closedAt": ""}
    return UpdateOne({"_id": deal["_id"]}, update)


def apply_to_source(db, source: dict) -> dict:
    """Re-classifies one claimed source's stored deals; returns what changed."""
    mapping, mapping_changed = status_mapping_for(source.get("statusMapping"))
    currency = str((source.get("metadata") or {}).get("currency") or "AUD")
    zone = hoops.business_zone(source["organizationId"])
    writes: list[UpdateOne] = []
    before: dict[str, int] = {}
    after: dict[str, int] = {}
    for deal in db.crm_deals.find(
        {"organizationId": source["organizationId"], "dataSourceId": str(source["_id"])},
        {"externalId": 1, "createdAt": 1, "sourceData": 1, "dealStatus": 1, "stageId": 1, "expectedClosingDate": 1, "closedAt": 1, "inPipeline": 1},
    ):
        target = reclassified(deal, mapping, currency, zone)
        if target is None:
            continue
        before[deal.get("dealStatus")] = before.get(deal.get("dealStatus"), 0) + 1
        after[target["dealStatus"]] = after.get(target["dealStatus"], 0) + 1
        op = _update_for(deal, target)
        if op is not None:
            writes.append(op)
    if writes:
        db.crm_deals.bulk_write(writes, ordered=False)
    return {"changed": len(writes), "before": before, "after": after, "statusMapping": mapping, "statusMappingChanged": mapping_changed}


def apply_hoops_won_rule() -> None:
    """Every Hoops source not yet on the current rule, once each (see the module docstring)."""
    db = get_db()
    for source in db.crm_data_sources.find({"provider": "hoops", "sync.wonRule": {"$ne": RULE}}):
        now = datetime.now(timezone.utc)
        claimed = db.crm_data_sources.find_one_and_update(
            {
                "_id": source["_id"],
                "$or": [{"sync.lastStatus": {"$ne": "running"}}, {"sync.runningSince": {"$lt": now - _STALE_CLAIM}}],
            },
            {"$set": {"sync.lastStatus": "running", "sync.runningSince": now}},
        )
        if not claimed:
            logger.info("Hoops won rule: source %s is syncing; it moves to the new rule on the next start.", source["_id"])
            continue
        previous = claimed.get("sync") or {}
        release: dict = {"$set": {"sync.lastStatus": previous.get("lastStatus") or "ok"}}
        if previous.get("runningSince") is not None:
            release["$set"]["sync.runningSince"] = previous["runningSince"]
        else:
            release["$unset"] = {"sync.runningSince": ""}
        try:
            result = apply_to_source(db, claimed)
            release["$set"]["sync.wonRule"] = RULE
            if result["statusMappingChanged"]:
                release["$set"]["statusMapping"] = result["statusMapping"]
            logger.info(
                "Hoops won rule (won when the job is created; pipeline = work in progress) applied to source %s (org %s): %s deals changed; before %s, after %s.",
                claimed["_id"],
                claimed.get("organizationId"),
                result["changed"],
                result["before"],
                result["after"],
            )
        except Exception as exc:  # noqa: BLE001 - retried on the next start; never takes the service down
            logger.warning("Hoops won rule not applied to source %s: %s", claimed["_id"], exc)
        finally:
            db.crm_data_sources.update_one({"_id": claimed["_id"]}, release)

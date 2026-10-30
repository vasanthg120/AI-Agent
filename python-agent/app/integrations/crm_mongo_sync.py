"""Mirrors each organization's connected CRMs into HaiVE's own collections
(crm_deals, crm_quotes, crm_contacts, crm_accounts) — what the dashboards,
reports and AI tools read.

Driven by data sources (crm_data_sources, managed by the backend's
DataSourcesService): one per connected CRM, each with its own adapter
(crm_adapters.py), field mappings, won/lost status values, modules and sync
settings. Every record written carries its source's id (dataSourceId), and
records are keyed on {organizationId, dataSourceId, externalId}, so two CRMs'
data never overwrite or mix with each other — the backend scopes every read
to the source the person selected.

Behaviour carried over from the single-CRM version (all confirmed live against
the customised CRM):

- Deal owners: the CRM's owner id is mirrored into externalOwnerRef (a foreign
  id space), and only becomes a real HaiVE ownerId through an admin mapping in
  Settings -> Deal Assignment (crm_deal_owner_mappings, resolved at sync time).
  No mapping yet -> ownerId is left untouched, never wiped. A mapping linking
  more than one HaiVE user to the same external salesperson has no ownerId at
  all (ambiguous — see deal-owner-mapping.service.ts's own comment), so it is
  excluded entirely at the query below rather than resolving to something
  arbitrary. A deal whose ownerId was set by an explicit admin/manager
  assignment (Deal.ownerAssignedManually) is never overwritten by a mapping
  here either, however many times sync runs again — only a deal with no such
  flag ever gets a mapped owner applied.
- Owner labels: the customised CRM's deal list returns a bare owner id, but its
  quotes carry the same user's name — cross-referenced onto
  Deal.externalOwnerLabel. Real data, never guessed.
- A deal's expected closing date is a forecast in most CRMs; when a deal turns
  won/lost and the CRM didn't also send a new date, it is stamped with today so
  won revenue lands in the month it was won.
- lastActivityAt only moves when a meaningful field changes (these writes
  bypass Mongoose's updatedAt, and stamping every poll would make every record
  look "actioned today").
- createdAt is set once, from the CRM's own creation date when it has one.
- A quote turning "approved" auto-drafts a royalty invoice (Phase 20a).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from pymongo import ReturnDocument, UpdateOne

from app.integrations.crm_adapters import AdapterError, adapter_for, field_paths, map_status, to_canonical
from app.memory.mongo_client import get_db

logger = logging.getLogger(__name__)

_DEAL_ACTIVITY_FIELDS = ("dealStatus", "monetaryValue", "expectedClosingDate", "stageId", "externalOwnerRef")
_QUOTE_ACTIVITY_FIELDS = ("quoteStatus", "clientApprovalStatus", "quoteAmount", "quoteNumber")
_MAX_FIELD_SAMPLES = 20
_SYNCABLE = ("prospectconnect", "hubspot", "salesforce", "zoho", "gorilladash")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_date(value) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value)
    if text.isdigit():  # epoch milliseconds (HubSpot)
        try:
            return datetime.fromtimestamp(int(text) / 1000, tz=timezone.utc)
        except (OverflowError, ValueError):
            return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _day(value) -> str | None:
    """A "YYYY-MM-DD" string from whatever date shape the CRM uses."""
    if not value:
        return None
    parsed = _parse_date(value)
    if parsed:
        return parsed.strftime("%Y-%m-%d")
    text = str(value)[:10]
    return text if len(text) == 10 and text[4] == "-" else None


def _number(value) -> float:
    try:
        return float(value) if value not in (None, "") else 0
    except (TypeError, ValueError):
        return 0


def _default_store_id(organization_id: str) -> str | None:
    """Only safe to auto-assign when the org has exactly one store."""
    stores = list(get_db().stores.find({"organizationId": organization_id}, {"_id": 1}).limit(2))
    return str(stores[0]["_id"]) if len(stores) == 1 else None


def _source_filter(source: dict) -> dict:
    return {"organizationId": source["organizationId"], "dataSourceId": str(source["_id"])}


# ---- deals -------------------------------------------------------------------


def _deal_update(source, store_id, raw, existing_by_external_id, owner_mapping_by_ref, owner_label_by_ref, details=None, products=None):
    c = to_canonical(raw, (source.get("fieldMappings") or {}).get("deals"))
    external_id = c.get("externalId")
    if not external_id:
        return None
    external_id = str(external_id)
    existing = existing_by_external_id.get(external_id)
    new_status = map_status(c.get("status"), source.get("statusMapping"))
    raw_closing = _day(c.get("closeDate"))
    fields = {
        **_source_filter(source),
        "sourceProvider": source["provider"],
        "externalId": external_id,
        "name": str(c.get("name") or "Untitled deal"),
        "dealStatus": new_status,
        "monetaryValue": _number(c.get("amount")),
        "expectedClosingDate": raw_closing,
        "stageId": str(c["stage"]) if c.get("stage") is not None else None,
        "pipelineId": str(c["pipeline"]) if c.get("pipeline") is not None else None,
    }
    if store_id:
        fields["storeId"] = store_id
    if details is not None:
        fields["sourceData"] = details
    # The product lines the CRM holds on the deal (only for CRMs that send them).
    # Not an "activity" field: a line being edited doesn't make the deal look freshly worked on.
    if products is not None:
        fields["products"] = products

    if (
        existing is not None
        and existing.get("dealStatus") != new_status
        and new_status in ("won", "lost")
        and existing.get("expectedClosingDate") == raw_closing
    ):
        fields["expectedClosingDate"] = _now().strftime("%Y-%m-%d")

    owner = c.get("owner")
    if owner:
        fields["externalOwnerRef"] = str(owner)
        fields["externalOwnerProvider"] = source["provider"]
        label = owner_label_by_ref.get(str(owner))
        if label:
            fields["externalOwnerLabel"] = label
        mapped_owner_id = owner_mapping_by_ref.get(str(owner))
        # Never overwrite a deal an admin/manager explicitly assigned
        # (Deal.ownerAssignedManually) — that stays authoritative no matter
        # how many times sync runs again; only an unflagged deal (never
        # manually touched) ever gets a mapped owner applied here.
        if mapped_owner_id and not (existing and existing.get("ownerAssignedManually")):
            fields["ownerId"] = mapped_owner_id

    if existing is None or any(existing.get(f) != fields.get(f) for f in _DEAL_ACTIVITY_FIELDS):
        fields["lastActivityAt"] = _now()

    return UpdateOne(
        {**_source_filter(source), "externalId": external_id},
        {"$set": fields, "$setOnInsert": {"createdAt": _parse_date(c.get("createdAt")) or _now()}},
        upsert=True,
    )


def _sync_deals(source: dict, adapter, seen_fields: set) -> int:
    db = get_db()
    organization_id = source["organizationId"]
    store_id = _default_store_id(organization_id)
    existing_by_external_id = {
        d["externalId"]: d
        for d in db.crm_deals.find(
            {**_source_filter(source), "externalId": {"$exists": True}},
            {"externalId": 1, "ownerAssignedManually": 1, **{f: 1 for f in _DEAL_ACTIVITY_FIELDS}},
        )
    }
    # ownerId exists only on an unambiguous mapping (exactly one linked
    # user — see deal-owner-mapping.service.ts's own comment); a mapping
    # linking more than one user has no ownerId at all and is deliberately
    # excluded here, not resolved to anything arbitrary.
    owner_mapping_by_ref = {
        m["externalOwnerRef"]: m["ownerId"]
        for m in db.crm_deal_owner_mappings.find(
            {"organizationId": organization_id, "provider": source["provider"], "ownerId": {"$exists": True, "$ne": None}},
            {"externalOwnerRef": 1, "ownerId": 1},
        )
    }
    owner_label_by_ref = {
        q["quoteOwner"]: q["quoteOwnerLabel"]
        for q in db.crm_quotes.find(
            {**_source_filter(source), "quoteOwner": {"$exists": True}, "quoteOwnerLabel": {"$exists": True, "$ne": None}},
            {"quoteOwner": 1, "quoteOwnerLabel": 1},
        )
    }
    synced = 0
    for rows in adapter.pages("deals"):
        for raw in rows[:_MAX_FIELD_SAMPLES]:
            seen_fields |= field_paths(raw)
        operations = [
            op
            for op in (
                _deal_update(
                    source,
                    store_id,
                    d,
                    existing_by_external_id,
                    owner_mapping_by_ref,
                    owner_label_by_ref,
                    adapter.details("deals", d),
                    adapter.products(d),
                )
                for d in rows
            )
            if op
        ]
        if operations:
            result = db.crm_deals.bulk_write(operations, ordered=False)
            synced += result.upserted_count + result.modified_count
    return synced


# ---- quotes ------------------------------------------------------------------


def _quote_update(source, raw, deal_native_id_by_external_id, existing_by_external_id, owner_mapping_by_ref=None, charges=None):
    c = to_canonical(raw, (source.get("fieldMappings") or {}).get("quotes"))
    external_id = c.get("externalId")
    if not external_id:
        return None
    external_id = str(external_id)
    deal_ref = c.get("dealRef")
    if isinstance(deal_ref, dict):
        deal_ref = deal_ref.get("id") or deal_ref.get("_id")
    deal_id = deal_native_id_by_external_id.get(str(deal_ref)) if deal_ref else None

    client_details = {
        k: v
        for k, v in {
            "companyName": c.get("customerCompany"),
            "contactName": c.get("customerName"),
            "email": c.get("customerEmail"),
            "phone": c.get("customerPhone"),
        }.items()
        if v
    }
    fields = {
        **_source_filter(source),
        "sourceProvider": source["provider"],
        "externalId": external_id,
        "quoteName": str(c.get("name") or "Untitled quote"),
        "quoteStatus": str(c.get("status") or "draft"),
        "clientApprovalStatus": str(c.get("approvalStatus") or "pending"),
        "quoteAmount": _number(c.get("amount")),
        "currency": str(c.get("currency") or "USD"),
        "expirationDate": _day(c.get("expirationDate")),
    }
    owner = c.get("owner")
    if isinstance(owner, dict):
        owner = owner.get("id") or owner.get("_id")
    if owner:
        fields["quoteOwner"] = str(owner)
        # The CRM owner already linked to a HaiVE user (Settings -> Deal Assignment)
        # owns this quotation too.
        mapped_owner_id = (owner_mapping_by_ref or {}).get(str(owner))
        if mapped_owner_id:
            fields["ownerUserId"] = mapped_owner_id
    if c.get("ownerName"):
        fields["quoteOwnerLabel"] = str(c["ownerName"])
    if deal_id:
        fields["dealId"] = str(deal_id)
    if c.get("number"):
        fields["quoteNumber"] = str(c["number"])
    if client_details:
        fields["clientDetails"] = client_details
    # The quotation's own tax and fee lines (only for CRMs that send them): with the deal's
    # product lines they are what the quotation's amount is made of.
    if charges is not None:
        fields["taxes"] = charges.get("taxes") or []
        fields["fees"] = charges.get("fees") or []

    existing = existing_by_external_id.get(external_id)
    if existing is None or any(existing.get(f) != fields.get(f) for f in _QUOTE_ACTIVITY_FIELDS):
        fields["lastActivityAt"] = _now()

    return UpdateOne(
        {**_source_filter(source), "externalId": external_id},
        {"$set": fields, "$setOnInsert": {"createdAt": _parse_date(c.get("createdAt")) or _now()}},
        upsert=True,
    )


def _sync_quotes(source: dict, adapter, seen_fields: set) -> int:
    db = get_db()
    organization_id = source["organizationId"]
    deal_native_id_by_external_id = {
        d["externalId"]: str(d["_id"])
        for d in db.crm_deals.find({**_source_filter(source), "externalId": {"$exists": True}}, {"externalId": 1})
    }
    existing_by_external_id = {
        q["externalId"]: q
        for q in db.crm_quotes.find(
            {**_source_filter(source), "externalId": {"$exists": True}}, {"externalId": 1, **{f: 1 for f in _QUOTE_ACTIVITY_FIELDS}}
        )
    }
    mapping = (source.get("fieldMappings") or {}).get("quotes") or {}
    # CRM owner -> HaiVE user, as linked in Settings -> Deal Assignment (shared
    # with deals). ownerId exists only on an unambiguous mapping (exactly one
    # linked user) — a mapping linking more than one user is excluded here,
    # same reasoning as _sync_deals' own owner_mapping_by_ref.
    quote_owner_mapping_by_ref = {
        m["externalOwnerRef"]: m["ownerId"]
        for m in db.crm_deal_owner_mappings.find(
            {"organizationId": source["organizationId"], "provider": source["provider"], "ownerId": {"$exists": True, "$ne": None}},
            {"externalOwnerRef": 1, "ownerId": 1},
        )
    }
    newly_approved: list[str] = []
    synced = 0
    for rows in adapter.pages("quotes"):
        for raw in rows[:_MAX_FIELD_SAMPLES]:
            seen_fields |= field_paths(raw)
        operations = []
        for raw in rows:
            op = _quote_update(
                source, raw, deal_native_id_by_external_id, existing_by_external_id, quote_owner_mapping_by_ref, adapter.charges(raw)
            )
            if not op:
                continue
            operations.append(op)
            c = to_canonical(raw, mapping)
            if str(c.get("approvalStatus") or "pending") != "approved":
                continue
            existing = existing_by_external_id.get(str(c.get("externalId")))
            if existing is None or existing.get("clientApprovalStatus") != "approved":
                newly_approved.append(str(c.get("externalId")))
        if operations:
            result = db.crm_quotes.bulk_write(operations, ordered=False)
            synced += result.upserted_count + result.modified_count
    if newly_approved:
        _draft_invoices_for_newly_approved(db, source, newly_approved)
    return synced


# ---- contacts & accounts -------------------------------------------------------


def _sync_simple(source: dict, adapter, module: str, collection: str, seen_fields: set) -> int:
    db = get_db()
    mapping = (source.get("fieldMappings") or {}).get(module) or {}
    synced = 0
    for rows in adapter.pages(module):
        for raw in rows[:_MAX_FIELD_SAMPLES]:
            seen_fields |= field_paths(raw)
        operations = []
        for raw in rows:
            c = to_canonical(raw, mapping)
            if not c.get("externalId"):
                continue
            fields = {k: v for k, v in c.items() if v not in (None, "") and k not in ("externalId", "createdAt")}
            if module == "contacts" and not fields.get("name"):
                fields["name"] = fields.get("email") or "Unnamed contact"
            if module == "accounts" and not fields.get("name"):
                fields["name"] = "Unnamed company"
            # When the CRM says when the record was created, that date is kept as its own field:
            # createdAt on records stored earlier is only when HaiVE first saw them.
            created = _parse_date(c.get("createdAt"))
            if created:
                fields["sourceCreatedAt"] = created
            operations.append(
                UpdateOne(
                    {**_source_filter(source), "externalId": str(c["externalId"])},
                    {
                        "$set": {**_source_filter(source), "sourceProvider": source["provider"], "externalId": str(c["externalId"]), **fields},
                        "$setOnInsert": {"createdAt": created or _now()},
                    },
                    upsert=True,
                )
            )
        if operations:
            result = db[collection].bulk_write(operations, ordered=False)
            synced += result.upserted_count + result.modified_count
    return synced


# ---- invoices for approved quotes (Phase 20a) --------------------------------


def _draft_invoice_for_approved_quote(db, organization_id: str, quote: dict) -> None:
    """Auto-drafts a royalty Invoice the moment a quote's clientApprovalStatus
    turns 'approved'. Carries over only real values (the quote's own amount);
    every invoice-specific field with no real source starts unset."""
    quote_id = str(quote["_id"])
    if db.royalty_invoices.find_one({"organizationId": organization_id, "quoteId": quote_id}):
        return
    deal = None
    deal_id = quote.get("dealId")
    if deal_id:
        try:
            deal = db.crm_deals.find_one({"_id": ObjectId(deal_id)})
        except Exception:
            deal = None
    counter = db.royalty_invoice_counters.find_one_and_update(
        {"organizationId": organization_id}, {"$inc": {"seq": 1}}, upsert=True, return_document=ReturnDocument.AFTER
    )
    now = _now()
    quote_amount = quote.get("quoteAmount") or 0
    fields: dict = {
        "organizationId": organization_id,
        "quoteId": quote_id,
        "invoiceNumber": f"INV-{counter['seq']:04d}",
        "invoiceDate": now,
        "originalValue": quote_amount,
        "currentValue": quote_amount,
        "currency": quote.get("currency") or "INR",
        "invoiceStatus": "draft",
        "voidStatus": False,
        "source": "auto_from_quote",
        "createdBy": "system:crm-sync",
        "createdAt": now,
        "updatedAt": now,
    }
    if deal:
        fields["dealId"] = str(deal["_id"])
        if deal.get("storeId"):
            fields["storeId"] = deal["storeId"]
        if deal.get("ownerId"):
            fields["salespersonId"] = deal["ownerId"]
    if quote.get("clientDetails"):
        fields["clientDetails"] = quote["clientDetails"]
    db.royalty_invoices.insert_one(fields)


def _draft_invoices_for_newly_approved(db, source: dict, external_ids: list[str]) -> None:
    for quote in db.crm_quotes.find({**_source_filter(source), "externalId": {"$in": external_ids}}):
        try:
            _draft_invoice_for_approved_quote(db, source["organizationId"], quote)
        except Exception:
            logger.exception("Auto-draft invoice failed for quote externalId=%s org=%s", quote.get("externalId"), source["organizationId"])


# ---- running a source ------------------------------------------------------------


_SAMPLES_PER_MODULE = 3
_MAX_SAMPLE_CHARS = 20_000


class _Recording:
    """An adapter that also keeps the first few records of each module it
    reads — what the mapping screen uses to suggest and preview field
    mappings. Everything else is the wrapped adapter's own behaviour."""

    def __init__(self, adapter):
        self._adapter = adapter
        self.samples: dict[str, list[dict]] = {}

    def __getattr__(self, name):
        return getattr(self._adapter, name)

    def pages(self, module: str):
        for rows in self._adapter.pages(module):
            kept = self.samples.setdefault(module, [])
            if len(kept) < _SAMPLES_PER_MODULE:
                kept.extend(rows[: _SAMPLES_PER_MODULE - len(kept)])
            yield rows


def _save_samples(source: dict, samples: dict[str, list[dict]]) -> None:
    import json

    db = get_db()
    for module, records in samples.items():
        if not records:
            continue
        safe = [r for r in records if len(json.dumps(r, default=str)) <= _MAX_SAMPLE_CHARS]
        if safe:
            db.crm_source_samples.update_one(
                {**_source_filter(source), "module": module},
                {"$set": {**_source_filter(source), "module": module, "records": safe, "updatedAt": _now()}},
                upsert=True,
            )


def describe_failure(exc: Exception) -> dict:
    """A failed sync as three things: what to tell a person (never a raw
    exception), what kind of problem it is (so the screen can offer the right
    next step), and the technical detail for whoever has to debug it."""
    detail = f"{exc.__class__.__name__}: {exc}"[:800]
    text = detail.lower()
    if any(k in text for k in ("401", "403", "unauthor", "forbidden", "expired", "not connected", "no credentials", "invalid token", "rejected")):
        kind, message = "auth", "HaiVE couldn't sign in to this CRM. The connection may have expired or been revoked — reconnect it."
    elif "429" in text or "rate limit" in text or "too many requests" in text:
        kind, message = "rate_limit", "The CRM is limiting how fast HaiVE can read from it. The next sync will pick up where this one stopped."
    elif any(k in text for k in ("timeout", "timed out", "connection", "unreachable", "name resolution", "502", "503", "504")):
        kind, message = "unreachable", "The CRM couldn't be reached. This is usually temporary — try again in a few minutes."
    else:
        kind, message = "other", "The sync couldn't be completed. Try again; if it keeps failing, check the connection and the field mapping."
    return {"message": message, "kind": kind, "detail": detail}


def _record_run(source: dict, started: datetime, trigger: str, status_: str, counts: dict, failure: dict | None = None) -> None:
    try:
        get_db().crm_sync_runs.insert_one(
            {
                **_source_filter(source),
                "trigger": trigger,
                "status": status_,
                "startedAt": started,
                "finishedAt": _now(),
                "counts": counts,
                **({"error": failure["message"], "errorKind": failure["kind"], "errorDetail": failure["detail"]} if failure else {}),
            }
        )
    except Exception:  # noqa: BLE001 - history is a record of the sync, never a reason for it to fail
        logger.exception("Could not record the sync run for %s", source.get("label"))


def sync_source(source: dict, modules: tuple[str, ...] | None = None, trigger: str = "scheduled") -> dict:
    """Syncs one data source and records the outcome on it (last sync time,
    status, counts, error) and in its history (crm_sync_runs)."""
    db = get_db()
    wanted = [m for m in (modules or ("deals", "quotes", "contacts", "accounts")) if m in (source.get("modules") or [])]
    db.crm_data_sources.update_one({"_id": source["_id"]}, {"$set": {"sync.lastStatus": "running"}})
    counts: dict[str, int] = {}
    seen: dict[str, set] = {}
    # Incremental CRMs: fetch only what changed since the *start* of the last
    # successful full run (not the newest timestamp seen — records edited while
    # that run was in progress would otherwise be skipped).
    started = _now()
    try:
        adapter = adapter_for(source)
        if adapter.incremental:
            adapter.since = _parse_date((source.get("sync") or {}).get("cursor"))
            # Records synced before their detail was kept: read everything once more.
            if adapter.stores_details and db.crm_deals.find_one({**_source_filter(source), "sourceData": {"$exists": False}}, {"_id": 1}):
                adapter.since = None
        adapter = _Recording(adapter)
        for module in wanted:
            if module not in adapter.modules or not ((source.get("fieldMappings") or {}).get(module) or {}).get("externalId"):
                continue  # this CRM (or its mapping) doesn't provide the module
            seen[module] = set()
            if module == "deals":
                counts["deals"] = _sync_deals(source, adapter, seen[module])
            elif module == "quotes":
                counts["quotes"] = _sync_quotes(source, adapter, seen[module])
            elif module == "contacts":
                counts["contacts"] = _sync_simple(source, adapter, "contacts", "crm_contacts", seen[module])
            elif module == "accounts":
                counts["accounts"] = _sync_simple(source, adapter, "accounts", "crm_accounts", seen[module])
    except Exception as exc:  # recorded on the source, never raised into the scheduler
        failure = describe_failure(exc)
        logger.warning("CRM sync of %s (org %s) failed: %s", source.get("label"), source.get("organizationId"), failure["detail"])
        db.crm_data_sources.update_one(
            {"_id": source["_id"]},
            {
                "$set": {
                    "sync.lastStatus": "error",
                    "sync.lastError": failure["message"],
                    "sync.lastErrorKind": failure["kind"],
                    "sync.lastErrorDetail": failure["detail"],
                    "sync.lastSyncAt": _now(),
                }
            },
        )
        _record_run(source, started, trigger, "error", counts, failure)
        return {"status": "error", "error": failure["message"], "errorKind": failure["kind"], **counts}

    _save_samples(source, adapter.samples)
    _record_run(source, started, trigger, "ok", counts)
    update = {"sync.lastStatus": "ok", "sync.lastSyncAt": _now(), "sync.lastSuccessAt": _now(), "sync.lastCounts": counts}
    if adapter.incremental and modules is None:
        update["sync.cursor"] = started
    for module, paths in seen.items():
        if paths:
            update[f"availableFields.{module}"] = sorted(paths)[:500]
    db.crm_data_sources.update_one(
        {"_id": source["_id"]},
        {"$set": update, "$unset": {"sync.lastError": "", "sync.lastErrorKind": "", "sync.lastErrorDetail": ""}},
    )
    return {"status": "ok", **counts}


def discover_source(source: dict) -> dict:
    """The first look at a newly connected CRM, before anything is synced:
    proves the connection really reads data, and brings back a first page of
    each kind of record — how many, which fields they carry, and a few
    samples for the mapping screen. Writes no CRM records."""
    try:
        adapter = adapter_for(source)
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", **describe_failure(exc)}
    found: dict[str, dict] = {}
    samples: dict[str, list[dict]] = {}
    update: dict = {}
    for module in ("deals", "quotes", "contacts", "accounts"):
        if module not in adapter.modules:
            continue
        try:
            rows = next(iter(adapter.pages(module)), [])
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "module": module, **describe_failure(exc)}
        paths: set[str] = set()
        for raw in rows[:_MAX_FIELD_SAMPLES]:
            paths |= field_paths(raw)
        found[module] = {"records": len(rows), "fields": len(paths)}
        samples[module] = rows[:_SAMPLES_PER_MODULE]
        if paths:
            update[f"availableFields.{module}"] = sorted(paths)[:500]
    _save_samples(source, samples)
    if update:
        get_db().crm_data_sources.update_one({"_id": source["_id"]}, {"$set": update})
    return {"status": "ok", "modules": found}


def _syncable_sources(organization_id: str | None = None) -> list[dict]:
    query: dict = {"status": "active", "provider": {"$in": list(_SYNCABLE)}, "sync.enabled": {"$ne": False}}
    if organization_id:
        query["organizationId"] = organization_id
    return list(get_db().crm_data_sources.find(query))


def _due(source: dict) -> bool:
    sync = source.get("sync") or {}
    last = _parse_date(sync.get("lastSyncAt"))
    interval = max(int(sync.get("intervalMinutes") or 10), 5)
    # A little slack so a 10-minute scheduler tick never skips a 10-minute source.
    return last is None or _now() - last >= timedelta(minutes=interval) - timedelta(seconds=60)


def sync_source_by_id(organization_id: str, data_source_id: str) -> dict:
    try:
        source = get_db().crm_data_sources.find_one({"_id": ObjectId(data_source_id), "organizationId": organization_id})
    except Exception:
        source = None
    if not source:
        return {"status": "error", "error": "Data source not found."}
    return sync_source(source, trigger="manual")


def discover_source_by_id(organization_id: str, data_source_id: str) -> dict:
    try:
        source = get_db().crm_data_sources.find_one({"_id": ObjectId(data_source_id), "organizationId": organization_id})
    except Exception:
        source = None
    if not source:
        return {"status": "error", "message": "Data source not found.", "kind": "other", "detail": ""}
    return discover_source(source)


def sync_org(organization_id: str) -> dict:
    """Every connected CRM of one organization, now (after connecting a CRM)."""
    return {str(s["_id"]): sync_source(s) for s in _syncable_sources(organization_id)}


def sync_all_due() -> dict:
    """The scheduler's job: every source whose own sync interval has passed."""
    summary = {}
    for source in _syncable_sources():
        if _due(source):
            summary[str(source["_id"])] = sync_source(source)
    return summary


# ---- names kept for existing callers (routes/sync.py, main.py) -------------------


def sync_deals_for_org(organization_id: str) -> int:
    return sum(int(sync_source(s, ("deals",)).get("deals", 0)) for s in _syncable_sources(organization_id))


def sync_quotes_for_org(organization_id: str) -> int:
    return sum(int(sync_source(s, ("quotes",)).get("quotes", 0)) for s in _syncable_sources(organization_id))


def sync_all_orgs() -> dict:
    return sync_all_due()


def sync_all_quote_orgs() -> dict:
    # Quotes now sync together with each source's other modules (sync_all_due).
    return {}

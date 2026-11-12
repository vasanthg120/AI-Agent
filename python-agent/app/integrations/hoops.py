"""Hoops (hoopscrm.com) Extended API — how HaiVE reads it, and what its records
become in HaiVE.

Hoops' rules for integrations (Hoops Extended API Reference, 19 Oct 2026),
all kept here or in the sync's nightly window:

- One request at a time per account. A request sent while another is running
  gets 429 "API call already in progress" — HaiVE never sends two at once, and
  when something else (another integration on the same key) is mid-call it
  waits and tries again.
- Not built for polling. Read at most once a night, after 7:00pm AEST
  (crm_mongo_sync's sync window, set on the data source), and only what changed
  since the last successful sync (`since`).
- Start small. The first night reads the last 30 days of transactions; older
  ones (as far back as chosen when connecting) are added a few pages a night.
  Customers are all brought in — one from years ago can buy again this week —
  a few pages a night too.
- Page with skip/limit, never page/pageSize (those cost Hoops a count query).
- A 500 with "timeout": true means the query was too big: ask for fewer.

What the records become (the mapping defaults in the backend's
provider-catalog.ts point at the "_" fields computed here): each transaction —
a quote or SalesDoc, with the job it became and its latest invoice — is both a
HaiVE deal and that deal's quotation (same id); each customer is an account
(companies) and its contacts are contacts (a customer with no contacts is its
own contact).
"""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timedelta, timezone, tzinfo
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import requests
from bson import ObjectId

from app.memory import integration_store
from app.memory.mongo_client import get_db

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.hoopscrm.com/rest/api"
TIMEOUT = 60
# Waits before retrying a 429 (another request for the account still running).
_RETRY_WAITS = (5, 15, 30, 60)

FIRST_IMPORT_DAYS = 30
# Upper bounds on one night's history walk, per list: the first night stops at
# 30 days back or this many pages, whichever comes first; later nights read this
# many pages further down — 1,000 quotes / 2,000 customers a night, one request
# at a time (raised from 5 on 2026-10-27: the user wants all of Hoops in HaiVE,
# and the PC isn't on every night).
FIRST_IMPORT_MAX_PAGES = 20
HISTORY_PAGES_PER_NIGHT = 20
# An open quote with no deadline in Hoops is expected this many days after it
# was created — like a quote's usual validity — so every open quote belongs to
# a month (the pipeline figures are by month), never left "undated".
OPEN_QUOTE_DAYS = 30
# Records deleted in Hoops since the last walk move older ones up the list; the
# walk restarts this many places early so none are skipped (re-reads are upserts).
_WALK_OVERLAP = 10

# path, the list's key in the response, page size, whether the history chosen
# when connecting applies (transactions) or the whole list is read (customers)
ENDPOINTS = {
    "transactions": ("/v2/ufg/transactions", "transactions", 50, True),
    "customers": ("/customers", "items", 100, False),
}
SAMPLE_PAGE_SIZE = 5

MAX_PRODUCT_LINES = 100


class HoopsError(Exception):
    pass


class HoopsTimeout(HoopsError):
    pass


def parse_date(value) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _day(value, zone: tzinfo | None = None) -> str | None:
    """The calendar day of a timestamp — in the business's own time zone when
    given, as Hoops' reports count it (a job created at 9:30am in Sydney on
    1 September is a September sale, though it is still 31 August in UTC)."""
    parsed = parse_date(value)
    if not parsed:
        return None
    return (parsed.astimezone(zone) if zone else parsed).strftime("%Y-%m-%d")


# Hoops is Australian: a business with no time zone set is taken to be in Sydney.
DEFAULT_ZONE = "Australia/Sydney"


def business_zone(organization_id: str) -> tzinfo:
    """The time zone a business's Hoops dates are counted in (its own setting)."""
    name = DEFAULT_ZONE
    try:
        org = get_db().organizations.find_one({"_id": ObjectId(organization_id)}, {"timezone": 1}) or {}
        name = org.get("timezone") or DEFAULT_ZONE
    except Exception:  # noqa: BLE001 - a malformed id or no database: the default zone
        pass
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - an unknown zone name: Sydney, then UTC
        try:
            return ZoneInfo(DEFAULT_ZONE)
        except Exception:  # noqa: BLE001
            return timezone.utc


def created_at(row: dict) -> datetime | None:
    """When a record was created: its createdAt, else the time inside its id
    (Hoops ids are 24-hex MongoDB ObjectIds, whose first 8 digits are the
    creation time) — customers and contacts carry no createdAt of their own."""
    parsed = parse_date(row.get("createdAt"))
    if parsed:
        return parsed
    rid = str(row.get("_id") or "")
    if len(rid) == 24:
        try:
            return datetime.fromtimestamp(int(rid[:8], 16), tz=timezone.utc)
        except ValueError:
            return None
    return None


class HoopsClient:
    def __init__(self, organization_id: str):
        creds = integration_store.get_credentials("hoops", organization_id)
        if not creds:
            raise HoopsError("Hoops is not connected (no credentials found).")
        key = str((creds.get("credentials") or {}).get("apiKey") or "").strip()
        if not key:
            raise HoopsError("The saved Hoops connection has no API key — reconnect it.")
        self.api_key = key
        base = str(creds.get("baseUrl") or DEFAULT_BASE_URL).rstrip("/")
        parsed = urlparse(base)
        if parsed.scheme != "https" and parsed.hostname not in ("localhost", "127.0.0.1"):
            raise HoopsError("The Hoops address must be https://.")
        self.base_url = base
        self.requests_made = 0
        # A page size Hoops timed out on is not asked for again in this sync.
        self._limits: dict[str, int] = {}

    def get(self, path: str, params: dict | None = None) -> dict:
        url = f"{self.base_url}{path}"
        for attempt in range(len(_RETRY_WAITS) + 1):
            response = requests.get(url, params=params, headers={"x-api-key": self.api_key, "Accept": "application/json"}, timeout=TIMEOUT)
            self.requests_made += 1
            if response.status_code != 429:
                break
            if attempt == len(_RETRY_WAITS):
                raise HoopsError("Hoops answered 429 (rate limit): another request for this account is still in progress.")
            logger.info("Hoops is busy with another request for this account; retrying in %ss", _RETRY_WAITS[attempt])
            time.sleep(_RETRY_WAITS[attempt])
        if response.status_code in (401, 403):
            raise HoopsError(f"Hoops rejected the API key (HTTP {response.status_code}).")
        try:
            body = response.json()
        except ValueError:
            body = None
        if response.status_code >= 500 and isinstance(body, dict) and body.get("timeout"):
            raise HoopsTimeout("Hoops timed out on this query (HTTP 500, timeout).")
        if response.status_code >= 400:
            message = body.get("message") if isinstance(body, dict) else response.text[:200]
            raise HoopsError(f"Hoops returned HTTP {response.status_code}: {message}")
        if not isinstance(body, dict):
            raise HoopsError("Hoops returned something that isn't JSON.")
        return body

    def page(self, endpoint: str, skip: int, limit: int | None = None, since: datetime | None = None) -> tuple[list[dict], bool]:
        """One page of a list, newest first, and whether more follow. A query
        too big for Hoops is asked again for fewer records."""
        path, key, default_limit, _dated = ENDPOINTS[endpoint]
        params: dict = {"skip": skip, "limit": min(limit or default_limit, self._limits.get(endpoint, default_limit))}
        if since is not None:
            params["since"] = _iso(since)
        while True:
            try:
                body = self.get(path, params)
                break
            except HoopsTimeout:
                if params["limit"] <= 5:
                    raise
                params["limit"] = max(5, params["limit"] // 2)
                self._limits[endpoint] = params["limit"]
        rows = [r for r in (body.get(key) or []) if isinstance(r, dict)]
        return rows, bool(body.get("hasMore"))


def collect(client: HoopsClient, endpoint: str, since: datetime | None, walk: dict | None, history_from: datetime | None, now: datetime):
    """Everything one night's sync reads from one list, and where the history
    walk got to. Returns (records, walk).

    1. Changes — with `since` (when the last successful sync started): every
       record created or updated since then.
    2. History — Hoops lists newest first, so older records are reached by
       walking down the list with skip. Transactions: the first night walks only
       the last 30 days; each later night continues a few pages further down,
       until the history start chosen when connecting (None: the whole list).
       Customers: the whole list, a few pages a night. Records created since the
       last walk push the older ones down: the walk moves down by that many
       (counted from the changes), less a small overlap.
    """
    dated = ENDPOINTS[endpoint][3]
    if not dated:
        history_from = None
    by_id: dict[str, dict] = {}
    walk_at = parse_date((walk or {}).get("at"))
    created_since_walk = 0
    if since is not None:
        skip = 0
        while True:
            rows, more = client.page(endpoint, skip, since=since)
            for row in rows:
                by_id[str(row.get("_id"))] = row
                created = created_at(row)
                if walk_at and created and created > walk_at:
                    created_since_walk += 1
            skip += len(rows)
            if not more or not rows:
                break

    if walk and walk.get("done"):
        return list(by_id.values()), walk

    first = not walk
    recent = now - timedelta(days=FIRST_IMPORT_DAYS)
    if first and dated:
        stop = max(history_from, recent) if history_from else recent
    else:
        stop = history_from
    skip = 0 if first else max(0, int(walk.get("skip") or 0) + created_since_walk - _WALK_OVERLAP)
    oldest = parse_date((walk or {}).get("oldest"))
    done = False
    for _ in range(FIRST_IMPORT_MAX_PAGES if first and dated else HISTORY_PAGES_PER_NIGHT):
        rows, more = client.page(endpoint, skip)
        skip += len(rows)
        for row in rows:
            created = created_at(row)
            if history_from and created and created < history_from:
                continue  # older than the history chosen when connecting
            by_id[str(row.get("_id"))] = row
        if rows:
            oldest = created_at(rows[-1]) or oldest
        if not more or not rows:
            done = True
            break
        if stop and oldest and oldest < stop:
            done = stop == history_from
            break
    return list(by_id.values()), {"skip": skip, "at": _iso(now), "oldest": _iso(oldest) if oldest else None, "done": done}


# ---- what the records become -------------------------------------------------------


def _text(value) -> str:
    """Plain text from a string or number — never an object's printout, and no HTML tags."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return ""
    return " ".join(re.sub(r"<[^>]+>", " ", str(value)).split())


def _person(record: dict | None) -> str:
    record = record if isinstance(record, dict) else {}
    return _text(f"{record.get('firstName') or ''} {record.get('lastName') or ''}") or _text(record.get("name"))


def _number(value) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


# Words in a transaction's own `status`, read alongside its accepted / voided
# flags and its jobs. Live statuses seen: CREATED, SENT, ACCEPTED, LOST, "Paid
# In square", and an account's own steps ("FOLLOW UP 1", "Provide Samples!",
# "ON HOLD"), which are open quotes at that step. A sale is won by its job, not
# by a word (see transaction_fields); these words only say whether a quote
# without a job was accepted. Voided/cancelled is not a sale at all (left out of
# Reporting); lost was sent and turned down (still counted as sent, as
# Pantheras' lost quotes are).
_VOID_WORDS = ("VOID", "CANCEL")
_LOST_WORDS = ("DECLIN", "REJECT", "LOST")
_DRAFT_WORDS = ("DRAFT", "CREATED")
_WON_WORDS = ("ACCEPT", "APPROV", "WON", "CONVERT", "INVOIC", "PAID", "COMPLET")


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


ACCEPTED_NO_JOB = "Accepted – no job yet"
IN_PRODUCTION = "In production"


def transaction_fields(row: dict, currency: str, zone: tzinfo | None = None) -> dict:
    """A transaction with the fields HaiVE maps (see the module docstring).

    Live records keep the customer, contact and owner inside `summary` (the
    reference shows them at the top level — both are read). _status is what the
    status mapping reads: voided / job / accepted / quoted / draft.

    Hoops' own jobs report decides it (user, 2026-11-11, from that report):
    - a sale is WON WHEN ITS JOB IS CREATED (the report's "Won" section —
      November: only job #2373), dated by the job, at the quote's value;
    - _inPipeline: the job is still WORK IN PROGRESS — neither completed nor
      voided (the report's "Work in progress", which HaiVE's pipeline shows).
      A paid or invoiced job is still in progress until Hoops completes it;
    - an accepted quote with no job yet is open ("Accepted – no job yet"),
      not won and not in the pipeline; quotes waiting on the customer are open.
    _closeDate: a won sale is dated by its job; a voided one when it was
    voided; an open one carries the quote deadline, or — when Hoops has none —
    30 days after it was created. Never the last edit (updatedAt) for a won
    sale: that moved old sales into whichever month they were last touched in."""
    summary = _dict(row.get("summary"))
    customer = _dict(row.get("customer")) or _dict(summary.get("customer"))
    contact = _dict(row.get("contact")) or _dict(summary.get("contact"))
    owner = _dict(summary.get("owner")) or _dict(row.get("owner"))
    all_jobs = [j for j in (row.get("jobs") or []) if isinstance(j, dict)]
    jobs = [j for j in all_jobs if not j.get("voided")]
    raw = _text(row.get("status")).upper()

    cancelled = bool(row.get("voided")) or any(w in raw for w in _VOID_WORDS)
    # With a job list, a job only counts if it isn't voided; older records carry just the number.
    has_job = bool(jobs) if all_jobs else bool(row.get("jobNumber") or row.get("jobCreatedAt"))
    # The job is the sale, whatever the quote's own status still says.
    won = not cancelled and has_job
    lost = not cancelled and not won and any(w in raw for w in _LOST_WORDS)
    voided = cancelled or lost  # either way the sale didn't happen: the deal is lost
    # Only Hoops completing the job ends work in progress (a "Paid…" status doesn't).
    completed = won and (bool(row.get("completed")) or any(j.get("completed") for j in jobs))
    accepted = not voided and (won or bool(row.get("accepted")) or any(w in raw for w in _WON_WORDS))
    draft = not (voided or accepted) and any(raw.startswith(w) for w in _DRAFT_WORDS)
    status = "voided" if voided else "job" if won else "accepted" if accepted else "draft" if draft else "quoted"
    # An open quote's stage is the account's own step ("Follow up 2", "Provide samples!").
    own_step = _text(row.get("status"))
    stage = (
        "Voided"
        if cancelled
        else "Lost"
        if lost
        else "Completed"
        if completed
        else IN_PRODUCTION
        if won
        else ACCEPTED_NO_JOB
        if accepted
        else "Draft"
        if draft
        else (own_step[:1].upper() + own_step[1:].lower())[:60]
        if own_step
        else "Quote sent"
    )

    if won:
        first_job = jobs[0] if jobs else {}
        close = row.get("jobCreatedAt") or first_job.get("createdAt") or row.get("acceptedAt") or row.get("createdAt")
    elif voided:
        close = row.get("voidedAt") or row.get("updatedAt")
    else:
        created = parse_date(row.get("createdAt"))
        close = row.get("deadline") or (_iso(created + timedelta(days=OPEN_QUOTE_DAYS)) if created else None)

    number = _text(row.get("number"))
    products = [p for p in (summary.get("products") or []) if isinstance(p, dict)]
    title = (
        _text(row.get("reference"))
        or _text(row.get("jobTitle"))
        or _text(row.get("description"))
        or _text(products[0].get("title") if products else None)
        or _text(row.get("docTypeName"))
    )[:80]
    customer_name = _text(customer.get("name"))
    individual = str(customer.get("type") or "").upper() == "INDIVIDUAL"
    name = " · ".join(p for p in (f"#{number}" if number else "", customer_name, title) if p) or "Hoops sale"

    return {
        **row,
        "_name": name[:160],
        "_status": status,
        "_stage": stage,
        # The day in the business's own time zone (Hoops' reports count days there).
        "_closeDate": _day(close, zone),
        # Work in progress: what HaiVE's pipeline figures count for Hoops (see the docstring).
        "_inPipeline": won and not completed,
        "_quoteStatus": "voided" if cancelled else "lost" if lost else "accepted" if accepted else "draft" if draft else "viewed" if row.get("viewed") else "sent",
        "_approval": "rejected" if voided else "approved" if accepted else "pending",
        "_customerCompany": "" if individual else customer_name,
        "_contactName": _person(contact) or (customer_name if individual else ""),
        "_email": _text(contact.get("email") or customer.get("email")),
        "_phone": _text(contact.get("phone") or customer.get("phone")),
        "_ownerName": _person(owner),
        "_currency": currency,
    }


def transaction_detail(row: dict) -> dict:
    """What a deal keeps of its transaction besides HaiVE's own fields (stored as
    `sourceData`): its Hoops status and flags, job and invoice, and the summary
    (customer, contact, owner, products) — not the line items, which are already
    the deal's product lines."""
    keep = (
        "status",
        "docTypeName",
        "documentType",
        "jobTypeName",
        "number",
        "viewed",
        "accepted",
        "acceptedAt",
        "voided",
        "voidedAt",
        "completed",
        "completedAt",
        "deadline",
        "leadSource",
        "jobNumber",
        "jobCreatedAt",
        "summary",
    )
    detail = {k: row.get(k) for k in keep if row.get(k) not in (None, "", [])}
    jobs = [j for j in (row.get("jobs") or []) if isinstance(j, dict)]
    if jobs:
        detail["jobs"] = [{k: j.get(k) for k in ("number", "voided", "completed", "completedAt", "createdAt") if k in j} for j in jobs[:10]]
    invoice = _dict(row.get("invoice"))
    if invoice:
        detail["invoice"] = {k: invoice.get(k) for k in ("totalAmount", "totalTaxAmount", "balance", "transactionDate") if k in invoice}
    return detail


def contacts_of(customer: dict) -> list[dict]:
    """A customer's contacts as HaiVE contacts, each with the customer's name as
    its company. A customer with no contacts is its own contact."""
    company = _text(customer.get("name")) if str(customer.get("type") or "COMPANY").upper() != "INDIVIDUAL" else ""
    out = []
    for contact in customer.get("contacts") or []:
        if not isinstance(contact, dict) or not contact.get("_id"):
            continue
        created = created_at(contact)
        out.append(
            {
                **contact,
                "_name": _person(contact) or _text(contact.get("email")) or company or "Hoops contact",
                "_company": company,
                "_customerId": customer.get("_id"),
                "_createdAt": _iso(created) if created else None,
            }
        )
    if not out and customer.get("_id"):
        created = created_at(customer)
        out.append(
            {
                "_id": customer.get("_id"),
                "email": customer.get("email"),
                "phone": customer.get("phone"),
                "_name": _text(customer.get("name")) or _text(customer.get("email")) or "Hoops customer",
                "_company": company,
                "_customerId": customer.get("_id"),
                "_createdAt": _iso(created) if created else None,
            }
        )
    return out


def account_of(customer: dict) -> dict | None:
    """A company customer as a HaiVE account (a customer who is a person isn't a company)."""
    if str(customer.get("type") or "COMPANY").upper() == "INDIVIDUAL":
        return None
    website = _text(customer.get("website"))
    domain = urlparse(website if "//" in website else f"https://{website}").hostname if website else None
    if not domain and "@" in str(customer.get("email") or ""):
        domain = str(customer["email"]).split("@", 1)[1].strip().lower()
    return {**customer, "_domain": (domain or "").removeprefix("www.") or None}


def product_lines(row: dict) -> list[dict] | None:
    """A transaction's line items in HaiVE's product-line shape (what the
    Customers page shows as the quotation's items)."""
    items = row.get("items")
    if not isinstance(items, list):
        return None
    out: list[dict] = []
    for item in items[:MAX_PRODUCT_LINES]:
        if not isinstance(item, dict):
            continue
        quantity = _number(item.get("quantity")) or 0
        unit_price = _number(item.get("unitPrice"))
        if unit_price is None:
            unit_price = _number(item.get("sellPrice")) or 0
        total = _number(item.get("subTotal"))
        if total is None:
            total = _number(item.get("invoiceAmount"))
        if total is None:
            total = quantity * unit_price
        name = _text(item.get("name") or item.get("code") or item.get("description"))[:200]
        line: dict = {"name": name or "Item", "quantity": quantity, "unitPrice": round(unit_price, 2), "total": round(total, 2)}
        detail = " · ".join(p for p in (_text(item.get("description"))[:400], _text(item.get("color")), _text(item.get("size"))) if p and p != name)
        if detail:
            line["description"] = detail[:600]
        reference = item.get("productId") or item.get("decorationId") or item.get("code")
        if reference:
            line["externalId"] = str(reference)
        out.append(line)
    return out


def charges(row: dict) -> dict[str, list[dict]]:
    """A transaction's tax and shipping, as the quotation's tax and fee lines
    (what Reporting takes tax from: amount ex tax = total - tax)."""
    tax = _number(row.get("taxTotal"))
    shipping = _number(row.get("shippingTotal"))
    return {
        "taxes": [{"name": "Tax", "amount": round(tax, 2)}] if tax else [],
        "fees": [{"name": "Shipping", "amount": round(shipping, 2)}] if shipping else [],
    }

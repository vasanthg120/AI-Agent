"""How HaiVE reads records out of each kind of CRM.

Each adapter knows only a provider's *transport* — where its records live,
how it authenticates, how it pages. What the records *mean* (which field is
the amount, which status means "won") is never hard-coded here: it comes from
the data source's field and status mappings (crm_data_sources, editable in
Settings -> Data Sources), applied by `to_canonical` / `map_status` below. So a
CRM that stores its amount in a custom field, or calls a won deal "Signed",
is a configuration change, not a code change — and adding a new CRM is one
adapter class plus a catalog entry (backend/src/data-sources/provider-catalog.ts),
with no dashboard or business-logic changes.
"""

from __future__ import annotations

import logging
from typing import Iterator
from urllib.parse import urlparse

import requests

from app.integrations import prospectconnect
from app.memory import integration_store

logger = logging.getLogger(__name__)

PAGE_SIZE = 100
MAX_PAGES = 50
TIMEOUT = 20


class AdapterError(Exception):
    """A CRM could not be read (not connected, rejected credentials, ...)."""


# ---- mapping helpers --------------------------------------------------------


def get_path(record: dict, path: str | None):
    """Value at a dotted path ("properties.amount", "Owner.id"), or None."""
    if not path:
        return None
    value = record
    for part in path.split("."):
        if isinstance(value, dict):
            value = value.get(part)
        else:
            return None
    return value


def to_canonical(record: dict, mapping: dict[str, str] | None) -> dict:
    """One CRM record as HaiVE's canonical fields — only the mapped ones."""
    return {field: get_path(record, path) for field, path in (mapping or {}).items() if path}


def map_status(raw, status_mapping: dict | None) -> str:
    """open / won / lost from the CRM's own status or stage value, using the
    source's configured won/lost values (exact match first, then contained —
    "Closed Won" matches "won")."""
    value = str(raw or "").strip().lower()
    if not value:
        return "open"
    mapping = status_mapping or {}
    won = [str(v).strip().lower() for v in mapping.get("won") or [] if str(v).strip()]
    lost = [str(v).strip().lower() for v in mapping.get("lost") or [] if str(v).strip()]
    if value in won:
        return "won"
    if value in lost:
        return "lost"
    # Lost is checked before won for "contains": a stage like "closed won't renew"
    # is rarer than "closed lost - won by competitor", and neither should be won.
    if any(v in value for v in lost if len(v) >= 3):
        return "lost"
    if any(v in value for v in won if len(v) >= 3):
        return "won"
    return "open"


def field_paths(record: dict, prefix: str = "", depth: int = 0) -> set[str]:
    """Every dotted field path on a record (two levels deep) — what the
    mapping editor offers as choices."""
    paths: set[str] = set()
    for key, value in record.items():
        if not isinstance(key, str):
            continue
        path = f"{prefix}{key}"
        if isinstance(value, dict) and depth < 2:
            paths |= field_paths(value, f"{path}.", depth + 1)
        else:
            paths.add(path)
    return paths


def _auth_token(creds: dict) -> str | None:
    auth_type = creds.get("authType")
    credentials = creds.get("credentials") or {}
    if auth_type in ("apiKey", "apiKeyBaseUrl"):
        return credentials.get("apiKey")
    if auth_type == "bearer":
        return (credentials.get("bearerToken") or "").removeprefix("Bearer ").strip() or None
    if auth_type == "customHeaders":
        headers = credentials.get("headers") or {}
        value = next((v for k, v in headers.items() if k.lower() == "authorization"), None)
        return str(value).split(" ", 1)[-1] if value else None
    return None


def _top_level_fields(mapping: dict[str, str] | None) -> list[str]:
    return sorted({path.split(".")[0] for path in (mapping or {}).values() if path})


# ---- adapters -----------------------------------------------------------------


class Adapter:
    provider = ""
    # Which modules this adapter can read.
    modules: tuple[str, ...] = ()
    # Can fetch only what changed since a timestamp (see sync_source's cursor).
    incremental = False
    # Set by sync_source for incremental adapters: fetch only records changed after this.
    since = None

    def __init__(self, source: dict):
        self.source = source
        self.organization_id = source["organizationId"]
        self.mappings = source.get("fieldMappings") or {}

    def pages(self, module: str) -> Iterator[list[dict]]:  # pragma: no cover - interface
        raise NotImplementedError


class ProspectConnectAdapter(Adapter):
    """The customised CRM. Its API is POST-with-body throughout; the deal list
    asks for fields by name, and its amount field is requested as "value" but
    returned as "monetary_value" (an API quirk, see crm_deal_tool)."""

    provider = "prospectconnect"
    modules = ("deals", "quotes")

    def _credentials(self) -> tuple[str, str]:
        creds = prospectconnect.resolve_external_credentials(self.organization_id)
        if not creds:
            # Never fall back to HaiVE's own backend here: that would copy HaiVE's
            # own records into this CRM's data source.
            raise AdapterError("The CRM is not connected (no credentials found).")
        return creds

    def pages(self, module: str) -> Iterator[list[dict]]:
        base_url, api_key = self._credentials()
        if module == "deals":
            requested = {"value" if f == "monetary_value" else f for f in _top_level_fields(self.mappings.get("deals"))}
            requested |= {"name", "value", "deal_status", "expected_closing_date", "stage_id", "pipeline_id", "sales_person"}
            requested.discard("id")
            for page in range(MAX_PAGES):
                body = prospectconnect.post_json(
                    base_url,
                    api_key,
                    "/deal/getDealsByBusinessId",
                    # page stays 1 and offset pages, exactly as the sync always has.
                    {"page": 1, "offset": page * PAGE_SIZE, "page_limit": PAGE_SIZE, "search": "", "fields": sorted(requested)},
                )
                rows = body.get("deal") or body.get("deals") or body.get("data") or []
                if not rows:
                    return
                yield rows
                if len(rows) < PAGE_SIZE:
                    return
        elif module == "quotes":
            start_after = 0
            for _ in range(MAX_PAGES):
                body = prospectconnect.post_json(
                    base_url, api_key, "/quotes/getQuotes", {"limit": PAGE_SIZE, "search": "", "startAfter": start_after}
                )
                rows = [q for q in body.get("quotes") or [] if isinstance(q, dict)]
                if not rows:
                    return
                yield rows
                if len(rows) < PAGE_SIZE:
                    return
                start_after += PAGE_SIZE


class _RestAdapter(Adapter):
    """Shared plumbing for REST CRMs connected through Integrations (bearer
    token / API key)."""

    default_base_url = ""

    def __init__(self, source: dict):
        super().__init__(source)
        creds = integration_store.get_credentials(source.get("integrationProvider") or self.provider, self.organization_id)
        if not creds:
            raise AdapterError(f"{source.get('label') or self.provider} is not connected (no credentials found).")
        token = _auth_token(creds)
        if not token:
            raise AdapterError("The saved credentials have no usable token — reconnect using a bearer token or API key.")
        self.token = token
        base = creds.get("baseUrl") or self.default_base_url
        if not base:
            raise AdapterError("No base URL is configured for this CRM.")
        parsed = urlparse(base)
        self.base_url = f"{parsed.scheme}://{parsed.netloc}"

    def _get(self, url: str, params: dict | None = None, headers: dict | None = None) -> dict:
        response = requests.get(url, params=params, headers=headers or self.headers(), timeout=TIMEOUT)
        if response.status_code in (401, 403):
            raise AdapterError(f"The CRM rejected the saved credentials (HTTP {response.status_code}).")
        response.raise_for_status()
        return response.json()

    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}


class HubSpotAdapter(_RestAdapter):
    provider = "hubspot"
    modules = ("deals", "contacts", "accounts")
    default_base_url = "https://api.hubapi.com"
    _objects = {"deals": "deals", "contacts": "contacts", "accounts": "companies"}

    def pages(self, module: str) -> Iterator[list[dict]]:
        properties = sorted(
            {path.split(".", 1)[1] for path in (self.mappings.get(module) or {}).values() if path and path.startswith("properties.")}
        )
        after = None
        for _ in range(MAX_PAGES):
            params = {"limit": PAGE_SIZE, "archived": "false"}
            if properties:
                params["properties"] = ",".join(properties)
            if after:
                params["after"] = after
            body = self._get(f"{self.base_url}/crm/v3/objects/{self._objects[module]}", params)
            rows = body.get("results") or []
            if rows:
                yield rows
            after = ((body.get("paging") or {}).get("next") or {}).get("after")
            if not after:
                return


class SalesforceAdapter(_RestAdapter):
    provider = "salesforce"
    modules = ("deals", "contacts", "accounts")
    _objects = {"deals": "Opportunity", "contacts": "Contact", "accounts": "Account"}
    api_version = "v59.0"

    def pages(self, module: str) -> Iterator[list[dict]]:
        fields = sorted({"Id", *[p for p in (self.mappings.get(module) or {}).values() if p]})
        query = f"SELECT {', '.join(fields)} FROM {self._objects[module]} ORDER BY CreatedDate DESC"
        body = self._get(f"{self.base_url}/services/data/{self.api_version}/query", {"q": query})
        for _ in range(MAX_PAGES):
            rows = body.get("records") or []
            if rows:
                yield rows
            next_url = body.get("nextRecordsUrl")
            if not next_url or body.get("done", True):
                return
            body = self._get(f"{self.base_url}{next_url}")


class ZohoAdapter(_RestAdapter):
    provider = "zoho"
    modules = ("deals", "contacts", "accounts")
    default_base_url = "https://www.zohoapis.com"
    _objects = {"deals": "Deals", "contacts": "Contacts", "accounts": "Accounts"}

    def headers(self) -> dict:
        return {"Authorization": f"Zoho-oauthtoken {self.token}", "Accept": "application/json"}

    def pages(self, module: str) -> Iterator[list[dict]]:
        fields = sorted({p.split(".")[0] for p in (self.mappings.get(module) or {}).values() if p} - {"id"})
        for page in range(1, MAX_PAGES + 1):
            params = {"page": page, "per_page": PAGE_SIZE}
            if fields:
                params["fields"] = ",".join(fields)
            response = requests.get(
                f"{self.base_url}/crm/v2/{self._objects[module]}", params=params, headers=self.headers(), timeout=TIMEOUT
            )
            if response.status_code == 204:  # Zoho: no records
                return
            if response.status_code in (401, 403):
                raise AdapterError(f"The CRM rejected the saved credentials (HTTP {response.status_code}).")
            response.raise_for_status()
            body = response.json()
            rows = body.get("data") or []
            if rows:
                yield rows
            if not (body.get("info") or {}).get("more_records"):
                return


class GorillaDashAdapter(Adapter):
    """Gorilla Dash: enquiries (leads) -> HaiVE deals, people -> contacts.
    Both lists take updated_after, so after the first full sync only changed
    records are fetched. Each record gets a computed "_display_name" (person
    and/or business name), since HaiVE's name field is a single value."""

    provider = "gorilladash"
    modules = ("deals", "contacts")
    incremental = True
    _paths = {"deals": "/api/v1/enquiries", "contacts": "/api/v1/people"}

    def __init__(self, source: dict):
        super().__init__(source)
        from app.integrations import gorilladash

        self._gd = gorilladash
        try:
            self.client = gorilladash.GorillaDashClient(self.organization_id)
        except gorilladash.GorillaDashError as exc:
            raise AdapterError(str(exc)) from exc

    def pages(self, module: str) -> Iterator[list[dict]]:
        params = {}
        if self.since is not None:
            params["updated_after"] = self.since.isoformat()
        try:
            for rows in self.client.pages(self._paths[module], per_page=500, **params):
                yield [{**row, "_display_name": self._gd.display_name(row)} for row in rows]
        except self._gd.GorillaDashError as exc:
            raise AdapterError(str(exc)) from exc


ADAPTERS: dict[str, type[Adapter]] = {
    "prospectconnect": ProspectConnectAdapter,
    "hubspot": HubSpotAdapter,
    "salesforce": SalesforceAdapter,
    "zoho": ZohoAdapter,
    "gorilladash": GorillaDashAdapter,
}


def adapter_for(source: dict) -> Adapter:
    cls = ADAPTERS.get(source.get("provider") or "")
    if not cls:
        raise AdapterError(f"HaiVE can't sync {source.get('label') or source.get('provider')} yet.")
    return cls(source)

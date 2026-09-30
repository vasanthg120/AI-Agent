"""Gorilla Dash API client (https://api.gorilladash.com, docs.gorilladash.com).

Used by the CRM sync (people and enquiries -> HaiVE's data source for Gorilla
Dash, see crm_adapters.GorillaDashAdapter) and by the AI agent's Gorilla Dash
tools (tools/gorilladash_lookup_tool.py, tools/gorilladash_action_tool.py).

API facts this client is built around (from Gorilla Dash's published OpenAPI):

- Every call except /up needs GorillaDash-Api-Key, GorillaDash-Api-Secret and
  X-Requested-With: XMLHttpRequest headers.
- Success is 201 (not 200) on every endpoint except /up — any 2xx is success.
- 401 = wrong key/secret, 403 = API not enabled for the account, or a
  location ("tribe") key asking for something outside its own location.
- Lists carry pagination {count, total, currentPage, totalPages}; more than
  1,000 per page is a 422.
- 120 requests/min per key per IP (300/min per IP) — a 429 is retried after
  its Retry-After.

Credentials are the organization's "gorilladash" integration (HTTP Basic in
the store: username = API key, password = API secret), saved by the backend
only after it verified them against /api/v1/ping.
"""

from __future__ import annotations

import logging
import time
from typing import Iterator

import requests

from app.memory import integration_store

logger = logging.getLogger(__name__)

PROVIDER = "gorilladash"
DEFAULT_BASE_URL = "https://api.gorilladash.com"
MAX_PER_PAGE = 1000
TIMEOUT = 20
MAX_RETRIES_ON_429 = 2
MAX_RETRY_WAIT_SECONDS = 30


class GorillaDashError(Exception):
    """A readable problem talking to Gorilla Dash (safe to show a person)."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def credentials_for(organization_id: str | None) -> tuple[str, str, str] | None:
    """(base_url, api_key, api_secret) for this organization, or None."""
    creds = integration_store.get_credentials(PROVIDER, organization_id)
    if not creds:
        return None
    values = creds.get("credentials") or {}
    auth_type = creds.get("authType")
    if auth_type == "basic":
        key, secret = values.get("username"), values.get("password")
    elif auth_type == "customHeaders":
        headers = {k.lower(): v for k, v in (values.get("headers") or {}).items()}
        key, secret = headers.get("gorilladash-api-key"), headers.get("gorilladash-api-secret")
    else:
        key = secret = None
    if not key or not secret:
        return None
    return (creds.get("baseUrl") or DEFAULT_BASE_URL).rstrip("/"), key, secret


def _message_for(status: int, body: dict | None) -> str:
    detail = ""
    if isinstance(body, dict):
        detail = str(body.get("message") or body.get("error") or "").strip()
    if status == 401:
        return "Gorilla Dash rejected the saved API key and secret. Reconnect them in Settings → Data Sources."
    if status == 403:
        return (
            "Gorilla Dash refused this request: either the API isn't turned on for your account, or the key is a "
            "single-location key asking about another location."
        )
    if status == 404:
        return "Gorilla Dash couldn't find that record."
    if status == 422:
        return f"Gorilla Dash didn't accept the request: {detail or 'invalid data'}"[:400]
    if status == 429:
        return "Gorilla Dash's rate limit was reached (120 requests a minute). Try again in a minute."
    return f"Gorilla Dash returned an error (HTTP {status}){': ' + detail[:200] if detail else ''}."


class GorillaDashClient:
    def __init__(self, organization_id: str | None, *, session=requests):
        creds = credentials_for(organization_id)
        if not creds:
            raise GorillaDashError("Gorilla Dash isn't connected. An administrator can connect it in Settings → Data Sources.")
        self.base_url, self._key, self._secret = creds
        self._http = session

    def _headers(self, with_body: bool) -> dict:
        headers = {
            "GorillaDash-Api-Key": self._key,
            "GorillaDash-Api-Secret": self._secret,
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json",
        }
        if with_body:
            headers["Content-Type"] = "application/json"
        return headers

    def request(self, method: str, path: str, *, params: dict | None = None, json: dict | None = None) -> dict:
        url = f"{self.base_url}{path}"
        clean_params = {k: v for k, v in (params or {}).items() if v not in (None, "")}
        for attempt in range(MAX_RETRIES_ON_429 + 1):
            response = self._http.request(
                method, url, params=clean_params or None, json=json, headers=self._headers(json is not None), timeout=TIMEOUT
            )
            if response.status_code == 429 and attempt < MAX_RETRIES_ON_429:
                wait = min(float(response.headers.get("Retry-After") or 5), MAX_RETRY_WAIT_SECONDS)
                logger.info("Gorilla Dash rate limit hit; retrying in %ss", wait)
                time.sleep(wait)
                continue
            break
        try:
            body = response.json() if response.content else {}
        except ValueError:
            body = {}
        # 201 is Gorilla Dash's normal success code — any 2xx counts.
        if not 200 <= response.status_code < 300:
            raise GorillaDashError(_message_for(response.status_code, body), response.status_code)
        return body if isinstance(body, dict) else {"data": body}

    def get(self, path: str, **params) -> dict:
        return self.request("GET", path, params=params)

    def post(self, path: str, body: dict, **params) -> dict:
        return self.request("POST", path, params=params, json=body)

    def put(self, path: str, body: dict, **params) -> dict:
        return self.request("PUT", path, params=params, json=body)

    def pages(self, path: str, *, per_page: int = 500, max_pages: int = 100, **params) -> Iterator[list[dict]]:
        """Every page of a list endpoint, following pagination.totalPages."""
        per_page = max(1, min(per_page, MAX_PER_PAGE))
        page = 1
        while page <= max_pages:
            body = self.get(path, page=page, results_per_page=per_page, **params)
            rows = records_of(body)
            if rows:
                yield rows
            pagination = body.get("pagination") or {}
            total_pages = int(pagination.get("totalPages") or 0)
            if not rows or (total_pages and page >= total_pages) or (not total_pages and len(rows) < per_page):
                return
            page += 1


def records_of(body: dict) -> list[dict]:
    """The records in a list response — under "data" (Gorilla Dash's usual
    envelope) or the first list value, whichever is present."""
    data = body.get("data")
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict):
        for value in data.values():
            if isinstance(value, list):
                return [r for r in value if isinstance(r, dict)]
    for key, value in body.items():
        if key != "pagination" and isinstance(value, list):
            return [r for r in value if isinstance(r, dict)]
    return []


def record_of(body: dict) -> dict:
    data = body.get("data")
    return data if isinstance(data, dict) else body


def display_name(record: dict) -> str:
    """"Priya Sharma (Acme)" / "Acme" / "priya@acme.com" — whichever the record has."""
    person = " ".join(str(record.get(k) or "").strip() for k in ("first_name", "last_name")).strip()
    business = str(record.get("business_name") or "").strip()
    if person and business:
        return f"{person} ({business})"
    return person or business or str(record.get("email") or record.get("name") or "").strip()

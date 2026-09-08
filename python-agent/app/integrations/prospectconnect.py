from urllib.parse import urlparse

import requests

from app.cache import cache
from app.config import settings
from app.memory import integration_store
from app.service_token import mint_service_token

# Known-read endpoints, safe to cache. Deliberately excludes /contact/upsert
# (the only write path through this module) by simply not listing it here —
# no special-casing needed at any call site.
_CACHEABLE_PATHS = {
    "/contact/search/contact",
    "/contact/search/contact-by-ids",
    "/deal/getDealsByBusinessId",
    "/note/getNotes",
    "/account/fetch-account-list",
    "/quotes/getQuotes",
    "/tag/fetchTagList",
    "/deal/getPipelineList",
}


def resolve_credentials(organization_id: str | None = None, user_id: str = "") -> tuple[str, str]:
    """Returns (api_root, api_key) for wherever this org's CRM data lives.

    Four tiers, in order:
    1. An external CRM connected via the frontend's Integrations page for
       this specific org, classic apiKey+baseUrl shape (Mongo-backed, can
       change at runtime) — the old dedicated "Connect CRM" card.
    2. Same per-org connection, but the newer multi-auth shape (bearer/
       basic/apiKey/customHeaders — see auth-methods.ts/integration_store.
       get_credentials) saved via the generic "Add Integration" or "Import
       Connector Config" flow, under either provider name "crm" or
       "prospectconnect" (its own connector id). Real bug, fixed here: an
       org that connects their real CRM this way (confirmed live — this is
       how production orgs actually do it today) was previously invisible
       to every crm_*_tool.py call, which only ever checked tier 1's exact
       shape/provider name — so the sync silently fell through to tier 4
       and 404'd against routes the native backend doesn't implement, going
       stale with no error surfaced anywhere. Only usable when the auth
       style resolves to a single Authorization header value (bearer/basic)
       — apiKey-style credentials commonly use a different header name by
       default (see buildAuthHeaders' "X-Api-Key" default), which this
       module's single {"Authorization": api_key} header convention can't
       represent, so those fall through to the next tier rather than
       silently sending a wrong header.
    3. The static .env global fallback (pre-multi-tenancy behavior,
       preserved for callers with no organization_id — e.g. the scheduled
       report context).
    4. **Native fallback**: if organization_id is known and none of the
       above is configured, target this app's own backend at
       `{backend_url}/crm`, authenticating with a short-lived self-signed
       JWT (see app.service_token.mint_service_token) instead of a static api_key — every org
       gets a working CRM without connecting anything external. The `api_key`
       returned here is the literal `Authorization` header value (see
       post_json/post below, which send it unprefixed) — for this tier it's
       `"Bearer <token>"`, which is exactly what the backend's passport-jwt
       strategy expects, so no other code in this module needs to change.

    api_root is normalized to the bare scheme+host for every tier — resource
    paths (/contact/..., /deal/..., /note/..., ...) are appended by each
    tool, regardless of whether the stored base URL includes a sub-path.
    """
    base_url = integration_store.get_base_url("crm", organization_id)
    api_key = integration_store.get_api_key("crm", organization_id)
    if base_url and api_key:
        parsed = urlparse(base_url)
        return f"{parsed.scheme}://{parsed.netloc}", api_key

    if organization_id:
        for provider in ("crm", "prospectconnect"):
            creds = integration_store.get_credentials(provider, organization_id)
            if not creds or not creds.get("baseUrl"):
                continue
            # Real bug, fixed here: this used to build headers via the
            # generic buildAuthHeaders convention and only look for a key
            # literally named "Authorization" — which only ever exists for
            # the bearer/basic auth types. But the Add Integration wizard
            # defaults to (and most customers pick) the "API Key" auth type,
            # which stores the same raw key under "X-Api-Key" instead
            # (auth-methods.ts's buildAuthHeaders default). That mismatch
            # made every apiKey-connected org silently fall through to tier
            # 4 (the empty native backend) — CRM tools and the dashboard
            # sync job both looked "connected" in the UI but never actually
            # talked to the real CRM, so no data ever showed up. Extract the
            # raw token value directly per auth type instead of depending on
            # which header name it happened to land under — this module
            # always sends it under its own hardcoded "Authorization" header
            # (see post_json/get_json below) regardless of what the customer
            # named it when connecting.
            auth_type = creds["authType"]
            credentials = creds["credentials"]
            if auth_type in ("apiKey", "apiKeyBaseUrl"):
                auth_header = credentials.get("apiKey")
            elif auth_type == "bearer":
                # Confirmed live against the real API: ProspectConnect
                # rejects (401) a "Bearer "-prefixed token and only accepts
                # the raw token value — same fact this module's own tier-4
                # comment above already documents for post_json/post's
                # header convention. An org connected via the generic
                # "bearer" auth type still stores (and should store) a real
                # RFC6750-style token, so strip the scheme prefix only for
                # THIS provider's actual wire format, rather than
                # reinterpreting what "bearer" means everywhere else this
                # generic multi-auth system is used.
                auth_header = (credentials.get("bearerToken") or "").removeprefix("Bearer ") or None
            elif auth_type == "customHeaders":
                headers = credentials.get("headers") or {}
                auth_header = next(
                    (value for name, value in headers.items() if name.lower() == "authorization"),
                    None,
                )
            else:
                # 'basic' has no single raw token to extract (it's a
                # username+password pair) — ProspectConnect doesn't support
                # basic auth, so there's nothing usable here; fall through.
                auth_header = None
            if not auth_header:
                continue
            parsed = urlparse(creds["baseUrl"])
            return f"{parsed.scheme}://{parsed.netloc}", auth_header

    if settings.crm_base_url and settings.crm_api_key:
        parsed = urlparse(settings.crm_base_url)
        return f"{parsed.scheme}://{parsed.netloc}", settings.crm_api_key

    if organization_id:
        token = mint_service_token(user_id, organization_id)
        return f"{settings.backend_url}/crm", f"Bearer {token}"

    return "", ""


def post_json(api_root: str, api_key: str, path: str, payload: dict):
    """Like post(), but returns the parsed JSON body and raises on failure
    instead of returning a human-readable error string — for callers (e.g.
    the RAG sync job) that need structured data rather than LLM-ready text.

    Read-only endpoints (see _CACHEABLE_PATHS) are cached briefly — CRM data
    is shared/business-wide (not per-user), so this speeds up both repeated
    lookups within one agentic turn and lookups across different users.
    """
    cacheable = path in _CACHEABLE_PATHS
    key = cache.cache_key(f"crm:{api_root}", path, payload) if cacheable else None
    if key is not None:
        hit = cache.get_json(key)
        if hit is not None:
            return hit

    url = f"{api_root.rstrip('/')}{path}"
    # ProspectConnect's auth docs specify the raw key in Authorization,
    # with no "Bearer " scheme prefix.
    response = requests.post(url, headers={"Authorization": api_key}, json=payload, timeout=15)
    response.raise_for_status()
    body = response.json()

    if key is not None:
        cache.set_json(key, body, settings.crm_cache_ttl_seconds)
    return body


def get_json(api_root: str, api_key: str, path: str, params: dict | None = None):
    """GET counterpart to post_json — same caching/auth, needed for the
    handful of ProspectConnect endpoints that are real GETs (confirmed via
    this org's own imported connector manifest, e.g. /deal/getPipelineList),
    unlike the rest of this API which is POST-with-body throughout."""
    cacheable = path in _CACHEABLE_PATHS
    key = cache.cache_key(f"crm:{api_root}", path, params or {}) if cacheable else None
    if key is not None:
        hit = cache.get_json(key)
        if hit is not None:
            return hit

    url = f"{api_root.rstrip('/')}{path}"
    response = requests.get(url, headers={"Authorization": api_key}, params=params, timeout=15)
    response.raise_for_status()
    body = response.json()

    if key is not None:
        cache.set_json(key, body, settings.crm_cache_ttl_seconds)
    return body


def post(api_root: str, api_key: str, path: str, payload: dict) -> str:
    try:
        return str(post_json(api_root, api_key, path, payload))
    except requests.RequestException as exc:
        response = getattr(exc, "response", None)
        if response is not None:
            snippet = response.text[:300] or "(empty body)"
            return f"CRM request failed ({response.status_code}) at {api_root.rstrip('/')}{path}: {snippet}"
        return f"CRM request failed: {exc}"
    except ValueError:
        return f"CRM returned a non-JSON response at {api_root.rstrip('/')}{path}."
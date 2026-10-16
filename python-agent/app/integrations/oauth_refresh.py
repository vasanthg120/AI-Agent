"""Shared lazy-refresh-on-read for OAuth2 CRM credentials stored in
integration_credentials (authType == 'oauth2' — see
backend/src/integrations/schemas/integration-credential.schema.ts and
auth-methods.ts).

This generalizes the exact pattern app/memory/outlook_store.py already uses
for Outlook (check expiry with a buffer, refresh if needed, re-encrypt and
write back, mark needs_reauth on an unrecoverable failure) into one function
parameterized by provider, instead of copy-pasting a bespoke per-provider
store. Outlook/Gmail keep their own existing stores unchanged — those predate
this, live in their own dedicated schemas (outlook_connections/
gmail_connections, per-user mailboxes), and are out of scope here; Zoho/
Salesforce are CRM connections, already one-per-organization, so they reuse
the same integration_credentials row every other CRM provider uses (see
IntegrationsService.resolveAuth on the Node side for the equivalent lazy
refresh used by DynamicExecutorService).
"""

import json
import logging
from datetime import datetime, timedelta, timezone

import requests

from app.config import settings
from app.encryption import decrypt, decrypt_token, encrypt
from app.memory.mongo_client import get_db

logger = logging.getLogger(__name__)

# Same 60s buffer outlook_store.py uses — refreshes slightly before the
# provider would actually reject the token, so a request never races an
# expiry that happens mid-flight.
EXPIRY_BUFFER_SECONDS = 60


def _is_expiring(expires_at) -> bool:
    if not expires_at:
        return True
    if isinstance(expires_at, str):
        try:
            expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError:
            return True
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= datetime.now(timezone.utc) + timedelta(seconds=EXPIRY_BUFFER_SECONDS)


def _refresh_zoho(refresh_token: str, oauth_meta: dict, client_id: str, client_secret: str) -> dict:
    # Zoho's refresh must go to the SAME data center's accounts server the
    # original authorization used (oauth_meta['accountsServer'], saved at
    # connect time) — falling back to the configured default only for a row
    # saved before that was recorded. client_id/client_secret are resolved
    # by the caller (get_valid_oauth_credentials below): the organization's
    # own saved Zoho app if it configured one (Settings -> Integrations'
    # credential modal), else this platform's shared app — a refresh MUST
    # use the same client credentials the original authorization was issued
    # under, same reasoning as the accounts-server pin above.
    base = (oauth_meta or {}).get("accountsServer") or settings.zoho_accounts_base_url
    response = requests.post(
        f"{base.rstrip('/')}/oauth/v2/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=15,
    )
    response.raise_for_status()
    data = response.json()
    if "access_token" not in data:
        # Zoho returns 200 with an {"error": "..."} body for e.g. a revoked
        # refresh token, rather than a 4xx — raise_for_status() alone would
        # miss this.
        raise RuntimeError(data.get("error", "Zoho did not return an access token"))
    return {
        "accessToken": data["access_token"],
        "expiresIn": int(data.get("expires_in", 3600)),
        # api_domain can change between calls (Zoho's own documented
        # behavior) — always take the freshest value, never pin the first one.
        "oauthMeta": {**(oauth_meta or {}), "apiDomain": data.get("api_domain", (oauth_meta or {}).get("apiDomain", ""))},
    }


def _refresh_salesforce(refresh_token: str, oauth_meta: dict, client_id: str, client_secret: str) -> dict:
    base = (oauth_meta or {}).get("authBaseUrl") or settings.salesforce_auth_base_url
    response = requests.post(
        f"{base.rstrip('/')}/services/oauth2/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=15,
    )
    response.raise_for_status()
    data = response.json()
    if "access_token" not in data:
        raise RuntimeError(data.get("error_description") or data.get("error", "Salesforce did not return an access token"))
    return {
        "accessToken": data["access_token"],
        # Salesforce doesn't return expires_in on refresh — sessions are
        # long-lived by org policy, not a fixed token TTL like Zoho/Microsoft.
        # Refreshing on a conservative fixed window (2h) means this never
        # trusts a session to outlive what Haive itself tracks.
        "expiresIn": 7200,
        "oauthMeta": {**(oauth_meta or {}), "instanceUrl": data.get("instance_url", (oauth_meta or {}).get("instanceUrl", ""))},
    }


_REFRESHERS = {"zoho": _refresh_zoho, "salesforce": _refresh_salesforce}

# Platform-fallback client id/secret per provider — only Zoho currently
# supports an organization bringing its own app (doc["oauthClientId"]/
# doc["oauthClientSecretEncrypted"], see IntegrationsService.
# saveOAuthAppCredentials on the Node side); Salesforce stays
# platform-app-only, unchanged, per the explicit scope of that feature.
_PLATFORM_APP_CREDENTIALS = {
    "zoho": (lambda: settings.zoho_client_id, lambda: settings.zoho_client_secret),
    "salesforce": (lambda: settings.salesforce_client_id, lambda: settings.salesforce_client_secret),
}


def _resolve_app_credentials(provider: str, doc: dict) -> tuple[str, str]:
    org_client_id = doc.get("oauthClientId")
    org_client_secret_encrypted = doc.get("oauthClientSecretEncrypted")
    if org_client_id and org_client_secret_encrypted:
        return org_client_id, decrypt(org_client_secret_encrypted)
    platform_id_fn, platform_secret_fn = _PLATFORM_APP_CREDENTIALS.get(provider, (lambda: "", lambda: ""))
    return platform_id_fn(), platform_secret_fn()


def get_valid_oauth_credentials(provider: str, organization_id: str) -> dict | None:
    """Returns {accessToken, baseUrl, oauthMeta} for an oauth2-authType CRM
    credential, refreshing it first if expired/near-expiry. Returns None if
    nothing is connected, the stored row isn't authType=='oauth2', or it's
    already marked needs_reauth (a dead connection stops being retried every
    sync run — the customer has to reconnect via the Settings -> Integrations
    CRM card, same recovery path Outlook/Gmail already use)."""
    db = get_db()
    doc = db.integration_credentials.find_one({"provider": provider, "organizationId": organization_id})
    if not doc or doc.get("authType") != "oauth2" or doc.get("status") == "needs_reauth":
        return None

    oauth_meta = doc.get("oauthMeta") or {}
    if not _is_expiring(doc.get("tokenExpiresAt")):
        credentials = json.loads(decrypt(doc["credentialsEncrypted"]))
        return {"accessToken": credentials.get("accessToken", ""), "baseUrl": doc.get("baseUrl"), "oauthMeta": oauth_meta}

    refresher = _REFRESHERS.get(provider)
    refresh_token_encrypted = doc.get("refreshTokenEncrypted")
    if not refresher or not refresh_token_encrypted:
        logger.warning("Cannot refresh oauth2 credential for provider=%s org=%s — no refresher/refresh token on file", provider, organization_id)
        return None

    try:
        refresh_token = decrypt_token(refresh_token_encrypted)
        client_id, client_secret = _resolve_app_credentials(provider, doc)
        refreshed = refresher(refresh_token, oauth_meta, client_id, client_secret)
    except Exception:
        logger.warning(
            "OAuth refresh failed for provider=%s org=%s — marking needs_reauth",
            provider,
            organization_id,
            exc_info=True,
        )
        db.integration_credentials.update_one({"_id": doc["_id"]}, {"$set": {"status": "needs_reauth"}})
        return None

    expires_at = datetime.now(timezone.utc) + timedelta(seconds=refreshed["expiresIn"])
    db.integration_credentials.update_one(
        {"_id": doc["_id"]},
        {
            "$set": {
                "credentialsEncrypted": encrypt(json.dumps({"accessToken": refreshed["accessToken"]})),
                "tokenExpiresAt": expires_at,
                "oauthMeta": refreshed["oauthMeta"],
            }
        },
    )
    return {"accessToken": refreshed["accessToken"], "baseUrl": doc.get("baseUrl"), "oauthMeta": refreshed["oauthMeta"]}

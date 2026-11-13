import logging
from datetime import datetime, timedelta

import requests

from app.config import settings
from app.encryption import decrypt_token, encrypt
from app.memory.mongo_client import get_db

# "organizations" (not a specific tenant ID) so any franchise business's
# Microsoft 365 tenant can connect — this app is registered as multi-tenant
# in Azure AD, matching backend/src/outlook/outlook.service.ts. One
# platform-owned Azure App Registration for every organization; customers
# never provide their own OAuth credentials.
TOKEN_ENDPOINT = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
GRAPH_SCOPES = "offline_access User.Read Mail.Read Calendars.Read Contacts.Read"

logger = logging.getLogger(__name__)


class MicrosoftAppCredentialsError(RuntimeError):
    """Microsoft refused HaiVE's own app credentials (client id / secret) - every
    mailbox fails the same way and reconnecting a mailbox cannot help: the
    MS_GRAPH_CLIENT_SECRET in this service's settings has to be put right."""


def get_connection(user_id: str) -> dict | None:
    # A user may have several connected mailboxes; the backend's Outlook
    # Account Management UI lets them pick which one is active (see
    # backend/src/outlook/outlook.service.ts setActive) — that's the one
    # the agent acts as. needs_reauth connections are excluded — a prior
    # refresh already established the grant is dead; don't keep retrying it
    # every call (see _refresh's failure path below).
    return get_db().outlook_connections.find_one(
        {"userId": user_id, "isActive": True, "status": {"$ne": "needs_reauth"}}
    )


def get_valid_access_token(user_id: str) -> str | None:
    """Returns a live Graph access token for this user, refreshing if needed.

    Tokens are written by the NestJS backend after the OAuth callback; this
    only reads/refreshes them (backend owns the initial exchange since it
    holds the redirect flow). Returns None if there's no connection, or if
    the connection's refresh grant has been revoked (see _refresh) — either
    way the caller should treat this exactly like "not connected".
    """
    connection = get_connection(user_id)
    if not connection:
        return None

    if datetime.utcnow() >= connection["expiresAt"] - timedelta(seconds=60):
        connection = _refresh(connection)
        if connection is None:
            return None

    return decrypt_token(connection["accessToken"])


def _refresh(connection: dict) -> dict | None:
    response = requests.post(
        TOKEN_ENDPOINT,
        data={
            "client_id": settings.ms_graph_client_id,
            "client_secret": settings.ms_graph_client_secret,
            "grant_type": "refresh_token",
            "refresh_token": decrypt_token(connection["refreshToken"]),
            "scope": GRAPH_SCOPES,
        },
        timeout=10,
    )

    if response.status_code == 400 and response.json().get("error") == "invalid_grant":
        # Refresh token expired or revoked (user changed their Microsoft
        # password, removed the app's consent, etc.) — no amount of retrying
        # fixes this; only reconnecting through the consent screen again
        # will. Mark it so get_connection stops selecting this row, and the
        # Outlook Account Management UI can show "needs reconnecting"
        # instead of silently failing every tool call.
        get_db().outlook_connections.update_one(
            {"userId": connection["userId"], "email": connection["email"]},
            {"$set": {"status": "needs_reauth"}},
        )
        return None

    if response.status_code in (400, 401):
        try:
            body = response.json()
        except ValueError:
            body = {}
        if body.get("error") in ("invalid_client", "unauthorized_client"):
            codes = ",".join(str(c) for c in body.get("error_codes") or [])
            logger.error("Microsoft refused the app credentials (%s %s) - check MS_GRAPH_CLIENT_SECRET", body.get("error"), codes)
            raise MicrosoftAppCredentialsError(
                f"Microsoft refused HaiVE's app sign-in (AADSTS{codes or '?'}): the MS_GRAPH_CLIENT_SECRET in the AI service "
                "settings is wrong or has expired. Put the current secret value from Azure (App registrations, Certificates & "
                "secrets) there and restart the AI service - the mailboxes themselves don't need reconnecting."
            )

    response.raise_for_status()
    payload = response.json()

    new_access_token = payload["access_token"]
    new_refresh_token = payload.get("refresh_token", decrypt_token(connection["refreshToken"]))
    new_expires_at = datetime.utcnow() + timedelta(seconds=payload.get("expires_in", 3600))
    encrypted_access_token = encrypt(new_access_token)
    encrypted_refresh_token = encrypt(new_refresh_token)

    get_db().outlook_connections.update_one(
        {"userId": connection["userId"], "email": connection["email"]},
        {
            "$set": {
                "accessToken": encrypted_access_token,
                "refreshToken": encrypted_refresh_token,
                "expiresAt": new_expires_at,
                "status": "connected",
            }
        },
    )
    connection["accessToken"] = encrypted_access_token
    connection["refreshToken"] = encrypted_refresh_token
    connection["expiresAt"] = new_expires_at
    return connection

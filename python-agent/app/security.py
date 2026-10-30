import jwt
from fastapi import HTTPException, Request, status

from app.config import settings


def get_current_user(request: Request) -> dict:
    """Re-validates the JWT the backend already checked and forwarded.

    The agent is never openly callable: every route depends on this so a
    request without a valid backend-issued token is rejected here too.

    The backend now mints tokens with an `organizationId` claim (multi-tenant
    Phase 1) alongside the required `sub` — it flows through here unchanged
    since this returns the whole payload dict, so any route/tool that later
    needs to scope a query by tenant (CRM, documents, memory — see the
    roadmap's Phase 2+) can read `user["organizationId"]` with no security.py
    change needed. Short-lived internal tokens (e.g. the ones NestJS mints for
    the scheduled morning/EOD job, `{"sub": userId}`) have no organizationId —
    treat it as optional (`user.get("organizationId")`), never required, when
    consuming it.
    """
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")

    token = header[7:]
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token") from exc

    if "sub" not in payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token payload")
    return payload


def assert_user_id_matches(user_id: str, user: dict) -> None:
    """Rejects a request-body/form user_id that doesn't match the
    authenticated token's own `sub`.

    Several routes (app.routes.chat's ChatRequest.user_id,
    app.routes.roles's RoleGenerateRequest/RoleGenerateFromDescriptionRequest
    user_id) take a caller-supplied user_id alongside get_current_user's
    token — needed because the real identity-bearing value for some of
    those (billing attribution, Qdrant document ownership, Mem0 memory)
    predates this check and was never re-derived from the token directly.
    NestJS (the only intended caller — see get_current_user's own docstring)
    always sends the JWT's own sub as user_id, so this never rejects
    legitimate traffic; it only closes the direct-call impersonation path
    for whichever identity-sensitive operation that route's user_id drives.
    """
    if user_id != user.get("sub"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "user_id does not match the authenticated session.")

from fastapi import APIRouter, Depends, HTTPException, status

from app.integrations import zapier_mcp
from app.security import get_current_user

router = APIRouter()


# Called by the backend right after an administrator connects Zapier (and on
# "Refresh"): lists the Zapier MCP server's actions for the caller's own
# organization and caches them. The connection token itself never leaves the
# server side.
@router.post("/integrations/zapier/discover")
def discover_zapier(user: dict = Depends(get_current_user)):
    organization_id = user.get("organizationId")
    if not organization_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Token has no organizationId")
    try:
        catalog = zapier_mcp.discover(organization_id)
    except zapier_mcp.ZapierError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    return {
        "mode": catalog["mode"],
        "apps": catalog["apps"],
        "toolCount": len(catalog["tools"]),
        "refreshedAt": catalog["refreshedAt"],
    }

from fastapi import APIRouter, Depends, HTTPException, status

from app.integrations.crm_mongo_sync import sync_all_orgs as sync_crm_deals_to_mongo
from app.integrations.crm_mongo_sync import sync_all_quote_orgs as sync_crm_quotes_to_mongo
from app.integrations.crm_mongo_sync import sync_org, sync_source_by_id
from app.rag.business_sync import sync_all
from app.security import get_current_user

router = APIRouter()


@router.post("/sync/business-context/run")
def run_sync(user: dict = Depends(get_current_user)):
    return sync_all()


@router.post("/sync/crm-deals/run")
def run_crm_deal_sync(user: dict = Depends(get_current_user)):
    return sync_crm_deals_to_mongo()


@router.post("/sync/crm-quotes/run")
def run_crm_quote_sync(user: dict = Depends(get_current_user)):
    return sync_crm_quotes_to_mongo()


# Called by IntegrationsService right after a customer connects (or
# reconnects) their CRM, so real data shows up on the dashboard immediately
# instead of waiting for the next crm_mongo_sync_interval_minutes poll (up to
# 10 minutes of an apparently-connected-but-empty dashboard otherwise).
# Scoped to just the caller's own org (unlike the two endpoints above, which
# sweep every org) since only one org's data actually needs to appear sooner.
@router.post("/sync/crm/run-for-org")
def run_crm_sync_for_org(user: dict = Depends(get_current_user)):
    organization_id = user.get("organizationId")
    if not organization_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Token has no organizationId")
    results = sync_org(organization_id)
    return {
        "dealsSynced": sum(int(r.get("deals", 0)) for r in results.values()),
        "quotesSynced": sum(int(r.get("quotes", 0)) for r in results.values()),
        "sources": results,
    }


# "Sync now" for one data source (Settings -> Data Sources). The source must
# belong to the caller's own organization.
@router.post("/sync/crm/run-for-source")
def run_crm_sync_for_source(body: dict, user: dict = Depends(get_current_user)):
    organization_id = user.get("organizationId")
    if not organization_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Token has no organizationId")
    data_source_id = str((body or {}).get("dataSourceId") or "")
    if not data_source_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "dataSourceId is required")
    return sync_source_by_id(organization_id, data_source_id)

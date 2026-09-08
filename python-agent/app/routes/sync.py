from fastapi import APIRouter, Depends, HTTPException, status

from app.integrations.crm_mongo_sync import sync_all_orgs as sync_crm_deals_to_mongo
from app.integrations.crm_mongo_sync import sync_all_quote_orgs as sync_crm_quotes_to_mongo
from app.integrations.crm_mongo_sync import sync_deals_for_org, sync_quotes_for_org
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
    deals_synced = sync_deals_for_org(organization_id)
    quotes_synced = sync_quotes_for_org(organization_id)
    return {"dealsSynced": deals_synced, "quotesSynced": quotes_synced}

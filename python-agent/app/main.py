import sys

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI

from app.config import settings
from app.integrations.crm_mongo_sync import sync_all_orgs as sync_crm_deals_to_mongo
from app.integrations.crm_mongo_sync import sync_all_quote_orgs as sync_crm_quotes_to_mongo
from app.mcp_server import app as mcp_app
from app.rag.business_sync import sync_all
from app.routes import business_intelligence as business_intelligence_routes, business_knowledge as business_knowledge_routes, chat, customer_activity as customer_activity_routes, documents, email_intelligence as email_intelligence_routes, finance as finance_routes, health, outlook as outlook_routes, prompts as prompt_routes, reports, roles, sync, tasks, voice as voice_routes, workflows as workflow_routes
from app.workflows import definitions as _workflow_definitions  # noqa: F401 - import triggers workflow registration

# Windows' console defaults to a legacy codepage (cp1252) that can't encode
# emoji — crewai's internal logging (app/agent/crew_reports.py) writes some,
# which crashes the scheduled report job with UnicodeEncodeError on Windows
# even though the same code runs fine on Linux/Docker (UTF-8 by default).
# reconfigure() only exists when stdout is a real TextIOWrapper (not when
# redirected to certain non-standard streams), hence the hasattr guard.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

app = FastAPI(title="AI Agent Service")

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(documents.router)
app.include_router(roles.router)
app.include_router(reports.router)
app.include_router(sync.router)
app.include_router(tasks.router)
app.include_router(workflow_routes.router)
app.include_router(prompt_routes.router)
app.include_router(outlook_routes.router)
app.include_router(finance_routes.router)
app.include_router(customer_activity_routes.router)
app.include_router(business_knowledge_routes.router)
app.include_router(email_intelligence_routes.router)
app.include_router(business_intelligence_routes.router)
app.include_router(voice_routes.router)
app.mount("/mcp", mcp_app)

# Keeps CRM/Outlook data indexed for search_business_context without anyone
# having to trigger it manually. Single-process deployment (no --workers,
# one python-agent replica) — safe as one in-process scheduler; re-sync is
# idempotent (see business_sync.py's deterministic point ids) so this would
# stay correct even if that topology ever changed, just redundant.
scheduler = BackgroundScheduler()


@app.on_event("startup")
def _start_scheduler():
    scheduler.add_job(sync_all, "interval", minutes=settings.rag_sync_interval_minutes, id="rag_sync")
    scheduler.add_job(
        sync_crm_deals_to_mongo,
        "interval",
        minutes=settings.crm_mongo_sync_interval_minutes,
        id="crm_mongo_sync",
    )
    scheduler.add_job(
        sync_crm_quotes_to_mongo,
        "interval",
        minutes=settings.crm_mongo_sync_interval_minutes,
        id="crm_quote_mongo_sync",
    )
    scheduler.start()


@app.on_event("shutdown")
def _stop_scheduler():
    scheduler.shutdown(wait=False)

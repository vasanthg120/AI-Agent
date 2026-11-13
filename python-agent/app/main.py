import logging
import sys

import requests

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI
from fastapi.responses import JSONResponse

# Python's root logger has no handler by default, so every logger.info() call
# anywhere in this app (this file's own workflow logs, the new [PERF] timing
# lines in routes/chat.py, etc.) was silently dropped rather than reaching
# stdout — uvicorn's default logging config only wires up its own
# 'uvicorn'/'uvicorn.access'/'uvicorn.error' loggers, not the root logger.
# This only adds a handler + level; it changes no behavior of any request.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

from app.config import settings
from app.integrations.crm_mongo_sync import sync_all_orgs as sync_crm_deals_to_mongo
from app.integrations.crm_mongo_sync import sync_all_quote_orgs as sync_crm_quotes_to_mongo
from app.integrations.hoops_won_rule import apply_hoops_won_rule
from app.integrations.gorilladash_names import repair_gorilladash_names
from app.memory.outlook_store import MicrosoftAppCredentialsError
from app.mcp_server import app as mcp_app
from app.rag.business_sync import sync_all
from app.rag.vector_store import stamp_role_documents
from app.routes import admin_providers as admin_providers_routes, business_intelligence as business_intelligence_routes, business_knowledge as business_knowledge_routes, call_copilot as call_copilot_routes, chat, customer_activity as customer_activity_routes, documents, email_intelligence as email_intelligence_routes, finance as finance_routes, gmail as gmail_routes, health, outlook as outlook_routes, prompts as prompt_routes, reports, roles, sync, voice as voice_routes, workflows as workflow_routes, zapier as zapier_routes, chat_attachments as chat_attachment_routes, customers as customer_routes
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


# Microsoft refusing the app's own secret is a configuration problem, not a
# crash: answer with the reason in words (the email sync records it) instead
# of a bare 500 that hid it for days.
@app.exception_handler(MicrosoftAppCredentialsError)
async def _microsoft_app_credentials(_request, exc: MicrosoftAppCredentialsError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


# Microsoft Graph failing (its mail service down, a mailbox it can't reach) is
# said in words with Microsoft's request id — the email sync records it — not
# as a bare 500 that reads like a HaiVE crash.
@app.exception_handler(requests.HTTPError)
async def _microsoft_graph_error(_request, exc: requests.HTTPError):
    response = exc.response
    url = str(getattr(response, "url", "") or "")
    if response is None or "graph.microsoft.com" not in url:
        return JSONResponse(status_code=500, content={"detail": "Something went wrong talking to an outside service."})
    request_id = response.headers.get("request-id", "")
    status = response.status_code
    if status >= 500:
        detail = (
            f"Microsoft 365's mail service didn't answer for this mailbox (Microsoft error {status}, request id {request_id}). "
            "It's on Microsoft's side; HaiVE tries again on the next sync and catches up on everything missed."
        )
    elif status in (401, 403):
        detail = f"Microsoft refused access to this mailbox ({status}). Reconnect it in Settings, Integrations."
    elif status == 404:
        detail = "Microsoft says this mailbox can't be reached through Microsoft 365 (it may not be an Exchange Online mailbox, or has no licence)."
    else:
        detail = f"Microsoft 365 refused the request ({status}, request id {request_id})."
    return JSONResponse(status_code=503, content={"detail": detail})

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(documents.router)
app.include_router(roles.router)
app.include_router(reports.router)
app.include_router(sync.router)
app.include_router(zapier_routes.router)
app.include_router(chat_attachment_routes.router)
app.include_router(customer_routes.router)
app.include_router(workflow_routes.router)
app.include_router(prompt_routes.router)
app.include_router(outlook_routes.router)
app.include_router(gmail_routes.router)
app.include_router(finance_routes.router)
app.include_router(customer_activity_routes.router)
app.include_router(business_knowledge_routes.router)
app.include_router(email_intelligence_routes.router)
app.include_router(business_intelligence_routes.router)
app.include_router(voice_routes.router)
app.include_router(admin_providers_routes.router)
app.include_router(call_copilot_routes.router)
app.mount("/mcp", mcp_app)

# Keeps CRM/Outlook data indexed for search_business_context without anyone
# having to trigger it manually. Single-process deployment (no --workers,
# one python-agent replica) — safe as one in-process scheduler; re-sync is
# idempotent (see business_sync.py's deterministic point ids) so this would
# stay correct even if that topology ever changed, just redundant.
scheduler = BackgroundScheduler()


@app.on_event("startup")
def _start_scheduler():
    scheduler.add_job(stamp_role_documents, id="stamp_role_documents")
    # Once per Hoops source: stored sales re-classified to "won when invoiced".
    scheduler.add_job(apply_hoops_won_rule, id="hoops_won_rule")
    scheduler.add_job(repair_gorilladash_names, id="gorilladash_names")
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

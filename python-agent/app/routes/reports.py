from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.agent.anthropic_client import extract_report_structure
from app.agent.crew_reports import REPORT_PROMPTS, run_report_crew
from app.security import get_current_user

router = APIRouter()


class StructureReportRequest(BaseModel):
    reply: str
    report_type: str


class ReportTask(BaseModel):
    title: str
    priority: str
    category: str | None = None
    isOverdue: bool = False


class StructureReportResponse(BaseModel):
    tasks: list[ReportTask]
    summary: str


@router.post("/reports/structure", response_model=StructureReportResponse)
def structure_report(payload: StructureReportRequest, user: dict = Depends(get_current_user)):
    return StructureReportResponse(**extract_report_structure(payload.reply, payload.report_type))


class GenerateReportRequest(BaseModel):
    report_type: str
    request_id: str = ""


class GenerateReportResponse(BaseModel):
    reply: str
    tasks: list[ReportTask]
    summary: str


@router.post("/reports/generate", response_model=GenerateReportResponse)
def generate_report(payload: GenerateReportRequest, user: dict = Depends(get_current_user)):
    """Runs the prioritize -> write crew (app/agent/crew_reports.py) for the
    scheduled morning/EOD job, then structures the result the same way the
    plain chat path already does — one round trip instead of the two the
    caller previously needed (generate, then separately structure)."""
    if payload.report_type not in REPORT_PROMPTS:
        raise ValueError(f"Unknown report_type: {payload.report_type}")

    reply = run_report_crew(
        payload.report_type,
        organization_id=user.get("organizationId"),
        user_id=user.get("sub", ""),
        request_id=payload.request_id,
    )
    structured = extract_report_structure(reply, payload.report_type)
    return GenerateReportResponse(reply=reply, **structured)

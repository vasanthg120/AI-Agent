import io
import mimetypes
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from pypdf import PdfReader

from app.agent.anthropic_client import analyze_finance_activity, extract_finance_document, extract_finance_document_from_text
from app.models.schemas import FinanceExtractResponse
from app.rag.embeddings import embed
from app.rag.loader import load_text
from app.rag.splitter import split_text
from app.rag.vector_store import upsert_chunks
from app.security import get_current_user

router = APIRouter()

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
_TEXT_EXTENSIONS = {".xlsx", ".xls", ".csv", ".docx"}

# Flagged assumption (see Phase 10a plan notes) — re-confirm against live
# Anthropic docs before relying on these long-term; ~28MB raw leaves
# headroom under Anthropic's ~32MB encoded-request ceiling (~33% base64
# overhead), and 100 pages is the current understood PDF page limit.
_MAX_FILE_BYTES = 28 * 1024 * 1024
_MAX_PDF_PAGES = 100


def _synthesize_rag_text(extracted: dict, filename: str) -> str:
    """Fallback embedding text for pure image scans with no text layer at
    all (no OCR library in this app, by design) — built from the AI's own
    summary + extracted fields, so the document stays findable via RAG."""
    lines = [
        extracted.get("summary") or "",
        f"Vendor: {extracted.get('vendorName') or 'unknown'}",
        f"Invoice #: {extracted.get('invoiceNumber') or 'unknown'}",
        f"Amount: {extracted.get('paymentAmount')} {extracted.get('currency') or ''}".strip(),
        f"Category: {extracted.get('expenseCategory') or 'unknown'}",
    ]
    return "\n".join(line for line in lines if line)


@router.post("/finance/extract", response_model=FinanceExtractResponse)
async def extract_finance(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    organization_id = user.get("organizationId")
    if not organization_id:
        raise HTTPException(400, "organizationId is required for finance document extraction")
    user_id = user.get("sub", "")

    content = await file.read()
    filename = file.filename or "document"
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if len(content) > _MAX_FILE_BYTES:
        raise HTTPException(422, "This document exceeds the size limit for direct processing — split it into smaller files and re-upload")

    text = ""
    if ext == ".pdf":
        try:
            page_count = len(PdfReader(io.BytesIO(content)).pages)
        except Exception:  # noqa: BLE001 - a corrupt/unreadable PDF should 422, not 500
            raise HTTPException(422, "Could not read this PDF — it may be corrupted") from None
        if page_count > _MAX_PDF_PAGES:
            raise HTTPException(
                422,
                f"This PDF has {page_count} pages, over the {_MAX_PDF_PAGES}-page limit for direct "
                "processing — split it into smaller files and re-upload",
            )
        extracted = extract_finance_document(content, "application/pdf", filename, organization_id=organization_id, user_id=user_id)
        text = load_text(filename, content)  # text layer, if any — free, already read the bytes above
    elif ext in _IMAGE_EXTENSIONS:
        mime_type = mimetypes.guess_type(filename)[0] or "image/png"
        extracted = extract_finance_document(content, mime_type, filename, organization_id=organization_id, user_id=user_id)
    elif ext in _TEXT_EXTENSIONS:
        text = load_text(filename, content)
        if not text.strip():
            raise HTTPException(422, "Could not extract any text from the uploaded document")
        extracted = extract_finance_document_from_text(text, filename, organization_id=organization_id, user_id=user_id)
    else:
        raise HTTPException(422, f"Unsupported file type '{ext}' for finance document extraction")

    if not text.strip():
        text = _synthesize_rag_text(extracted, filename)

    document_id = str(uuid.uuid4())
    chunks = split_text(text)
    vector_chunk_count = 0
    if chunks:
        vectors = embed(chunks)
        upsert_chunks(
            document_id,
            user.get("sub", ""),
            filename,
            chunks,
            vectors,
            source_type="finance_document",
            organization_id=organization_id,
        )
        vector_chunk_count = len(chunks)

    return FinanceExtractResponse(vectorDocumentId=document_id, vectorChunkCount=vector_chunk_count, **extracted)


class PrioritizedPayment(BaseModel):
    vendorName: str
    documentId: str
    amount: float | None = None
    rationale: str


class FlaggedAnomaly(BaseModel):
    documentId: str | None = None
    vendorName: str
    anomalyType: str
    note: str


class FinanceActivityResponse(BaseModel):
    prioritizedPayments: list[PrioritizedPayment]
    flaggedAnomalies: list[FlaggedAnomaly]
    aiSummary: str


# The request body is the deterministic vendor-payment payload NestJS's
# finance-summary.service.ts already assembled — accepted as a raw dict for
# the same reason /customer-activity/analyze does (internal trusted input,
# shape owned on the NestJS side; the output shape is what's contractually
# enforced, via FINANCE_ACTIVITY_TOOL's forced tool_choice).
@router.post("/finance/analyze", response_model=FinanceActivityResponse)
def analyze_finance(payload: dict, user: dict = Depends(get_current_user)):
    return FinanceActivityResponse(
        **analyze_finance_activity(
            payload,
            organization_id=user.get("organizationId"),
            user_id=user.get("sub", ""),
            request_id=payload.get("request_id", ""),
        )
    )

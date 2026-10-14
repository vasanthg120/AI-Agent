import io
import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool

from app.rag.loader import SUPPORTED_EXTENSIONS, load_text
from app.security import get_current_user

router = APIRouter()
logger = logging.getLogger(__name__)

# What is kept of one document. A 400-page contract is ~1M characters; the
# chat only ever shows the model a relevant slice of it per turn
# (memory/chat_attachment_store.py), so this bounds storage, not usefulness.
MAX_EXTRACTED_CHARS = 1_000_000
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
CHAT_EXTENSIONS = SUPPORTED_EXTENSIONS | set(IMAGE_TYPES)
# The vision model takes images up to 5MB / ~1568px on the long edge; larger
# ones are scaled down first (which also proves the file really is an image).
_MAX_IMAGE_EDGE = 1568
# A scanned PDF (no text layer) is read by the vision model, page images and all.
_MAX_SCANNED_PDF_PAGES = 20
_MAX_SCANNED_PDF_BYTES = 20 * 1024 * 1024


def _prepare_image(content: bytes) -> tuple[bytes, str]:
    from PIL import Image

    with Image.open(io.BytesIO(content)) as image:
        image.load()
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        image.thumbnail((_MAX_IMAGE_EDGE, _MAX_IMAGE_EDGE))
        out = io.BytesIO()
        image.save(out, format="JPEG", quality=90)
        return out.getvalue(), "image/jpeg"


def _pdf_pages(content: bytes) -> int:
    from pypdf import PdfReader

    return len(PdfReader(io.BytesIO(content)).pages)


def _read_visually(content: bytes, mime_type: str, filename: str, user: dict) -> str:
    from app.agent import anthropic_client

    try:
        return anthropic_client.transcribe_visual_document(
            content, mime_type, filename, organization_id=user.get("organizationId"), user_id=str(user.get("sub") or "")
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Visual transcription of a chat attachment failed: %s", exc.__class__.__name__)
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "This file couldn't be read by the AI right now. Please try again in a minute.",
        ) from exc


def _extension(filename: str) -> str:
    return "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


# Called by the backend (never the browser) for a file someone attached in the
# AI chat: returns its plain text. Nothing is stored here — the backend keeps
# the text, encrypted, with the attachment's owner and organization.
@router.post("/chat/attachments/extract")
async def extract_attachment(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    filename = file.filename or "document"
    if _extension(filename) not in CHAT_EXTENSIONS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "This file type can't be read.")
    content = await file.read()
    extension = _extension(filename)
    if extension in IMAGE_TYPES:
        try:
            image_bytes, mime_type = _prepare_image(content)
        except Exception as exc:  # noqa: BLE001 - not a real/readable image
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "This image couldn't be opened. Save it again as PNG or JPG and retry.") from exc
        text = await run_in_threadpool(_read_visually, image_bytes, mime_type, filename, user)
        return {"text": text[:MAX_EXTRACTED_CHARS], "chars": min(len(text), MAX_EXTRACTED_CHARS), "truncated": False}
    try:
        text = load_text(filename, content)
    except Exception as exc:  # noqa: BLE001 - a damaged/protected file is the user's to fix, not a server error
        logger.info("Chat attachment %s could not be read: %s", _extension(filename), exc.__class__.__name__)
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "This file couldn't be read. It may be damaged or password-protected — remove the password or export it again, then retry.",
        ) from exc
    # Mongo strings can't hold NUL, and it never belongs in extracted text.
    text = text.replace("\x00", "").strip()
    if not text and extension == ".pdf":
        # No text layer: a scan. Small ones are read by the vision model.
        if len(content) > _MAX_SCANNED_PDF_BYTES or _pdf_pages(content) > _MAX_SCANNED_PDF_PAGES:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"This PDF is a scan with no text layer and is too long to read as images (limit {_MAX_SCANNED_PDF_PAGES} pages). "
                "Run it through OCR, or attach the pages you need.",
            )
        text = (await run_in_threadpool(_read_visually, content, "application/pdf", filename, user)).strip()
    if not text:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "No readable text was found in this file. If it's a scan or photo, run it through OCR (or export a text PDF) and retry.",
        )
    truncated = len(text) > MAX_EXTRACTED_CHARS
    return {"text": text[:MAX_EXTRACTED_CHARS], "chars": min(len(text), MAX_EXTRACTED_CHARS), "truncated": truncated}

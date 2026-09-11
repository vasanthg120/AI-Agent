"""Platform-admin "Test Connection" for the centrally-controlled AI
providers (Anthropic, Sarvam, Groq) — distinct from the plain "Connected"
badge on Admin Settings, which only checks whether a credential row exists
in MongoDB (see backend/src/integrations/integrations.service.ts's status()).
This route makes one real, minimal call using the already-resolved platform
credential, so an admin can tell "a key is on file" apart from "that key
actually works right now."

Reached only via backend/src/integrations/admin-integrations.controller.ts's
new POST /integrations/admin/:provider/verify (platform-admin-gated there);
this route itself uses the same shared-secret trust model every other
python-agent route does (get_current_user just needs a validly-signed JWT —
NestJS is the real authorization boundary, same as every other bridge call
in this app).
"""

from fastapi import APIRouter, Depends, HTTPException

from app.agent import anthropic_client, groq_client
from app.integrations import sarvam_client
from app.security import get_current_user

router = APIRouter()

_SUPPORTED_PROVIDERS = {"anthropic", "sarvam", "groq"}


def _verify_anthropic() -> dict:
    try:
        api_key = anthropic_client._resolve_api_key()
    except RuntimeError as exc:
        return {"ok": False, "message": str(exc)}
    try:
        anthropic_client._client(api_key).models.list(limit=1)
        return {"ok": True, "message": "Connected — Anthropic accepted this key."}
    except Exception:  # noqa: BLE001 - any SDK/network failure means "not verified", never a 500
        return {"ok": False, "message": "Anthropic rejected this key or could not be reached."}


def _verify_groq() -> dict:
    api_key = groq_client._resolve_api_key()
    if not api_key:
        return {"ok": False, "message": "Groq AI provider is not configured. Please connect Groq from Platform Admin Settings."}
    try:
        groq_client._client(api_key).models.list()
        return {"ok": True, "message": "Connected — Groq accepted this key."}
    except Exception:  # noqa: BLE001
        return {"ok": False, "message": "Groq rejected this key or could not be reached."}


def _verify_sarvam() -> dict:
    # Sarvam has no free "ping"/models-list endpoint this app already knows
    # about — the smallest real check available is a one-word text-to-speech
    # call, reusing synthesize_speech exactly as voice.py already does.
    try:
        sarvam_client.synthesize_speech("hi", "en")
        return {"ok": True, "message": "Connected — Sarvam AI accepted this key."}
    except sarvam_client.SarvamApiError as exc:
        return {"ok": False, "message": exc.user_message}
    except Exception:  # noqa: BLE001
        return {"ok": False, "message": "Sarvam AI could not be reached."}


@router.post("/admin/providers/{provider}/verify")
def verify_provider(provider: str, user: dict = Depends(get_current_user)):
    if provider not in _SUPPORTED_PROVIDERS:
        raise HTTPException(400, f"Unknown provider '{provider}'")
    if provider == "anthropic":
        return _verify_anthropic()
    if provider == "groq":
        return _verify_groq()
    return _verify_sarvam()

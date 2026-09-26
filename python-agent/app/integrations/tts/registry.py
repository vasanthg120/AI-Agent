"""The one place a text-to-speech provider is looked up by id. Adding an engine
(OpenAI, Azure, ...) = one adapter module implementing `TtsProvider` plus one
line here; routes, NestJS and the frontend need no change."""

from app.integrations.tts.base import TtsError, TtsProvider
from app.integrations.tts.elevenlabs import ElevenLabsTtsProvider
from app.integrations.tts.sarvam import SarvamTtsProvider

# What speaks when a request names no provider — exactly the behavior before
# voice configuration existed.
DEFAULT_PROVIDER = "sarvam"

_PROVIDERS: dict[str, TtsProvider] = {p.id: p for p in (SarvamTtsProvider(), ElevenLabsTtsProvider())}


def get_provider(provider_id: str) -> TtsProvider:
    try:
        return _PROVIDERS[provider_id]
    except KeyError:
        raise TtsError(f"'{provider_id}' is not a supported voice provider.", 400) from None

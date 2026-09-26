"""Provider-independent text-to-speech contract.

The rest of the app (NestJS's voice module, the frontend) works with a
normalized voice model — an accent, a gender, a personality — and never with
a provider's own voice names or parameters. Everything provider-specific
lives behind `TtsProvider`, so a new engine (OpenAI, Azure, ...) is one new
adapter plus one registry line, with no change to routes, NestJS or the UI.

`voiceRef` is the provider-private selector NestJS forwards untouched from its
voice catalog: Sarvam needs `{"speaker": "priya"}`, ElevenLabs needs
`{"accent": "british", "gender": "female", "variant": "standard"}`. It is
never shown to end users.
"""

from dataclasses import dataclass
from typing import Optional, Protocol

# The normalized speaking-style vocabulary — each adapter translates these to
# whatever its engine can actually vary (Sarvam: pace/temperature; ElevenLabs:
# stability/style/speed). Kept in sync with backend/src/voice/catalog.
PERSONALITIES = ("professional", "friendly", "conversational", "confident", "empathetic", "energetic", "calm")


class TtsError(Exception):
    """Any provider failure. `user_message` is always safe to show an end
    user — never a key, a stack trace, or a provider's raw error body."""

    def __init__(self, user_message: str, status_code: Optional[int] = None):
        super().__init__(user_message)
        self.user_message = user_message
        self.status_code = status_code


@dataclass(frozen=True)
class TtsResult:
    audio: bytes
    media_type: str


@dataclass(frozen=True)
class VoiceAvailability:
    available: bool
    reason: Optional[str] = None


class TtsProvider(Protocol):
    id: str

    def is_configured(self) -> bool:
        """True when this provider's platform credential is on file."""

    def check_voices(self, voice_refs: list[dict]) -> list[VoiceAvailability]:
        """Whether each voice can be spoken right now — same order as the
        input, with a user-safe reason for every one that can't. Batched so a
        provider does its credential lookup / remote voice-list fetch once per
        request rather than once per voice."""

    def synthesize(self, text: str, voice_ref: dict, language: str, personality: Optional[str]) -> TtsResult:
        """Speak `text`. Raises TtsError on any failure."""

"""Sarvam AI (bulbul:v3) adapter — the Indian-English voices, and the only
engine that speaks Indian languages (ta, hi, te, ...)."""

from typing import Optional

from app.integrations import sarvam_client
from app.integrations.tts.base import TtsError, TtsResult, VoiceAvailability
from app.memory import integration_store

# Sarvam's own answer to "which speakers exist for bulbul:v3?" — obtained by
# sending an unknown speaker name to the live API, whose 400 lists them all
# (docs.sarvam.ai lists the same 37 but gives no gender or style metadata).
VALID_SPEAKERS = frozenset(
    "aditya ritu ashutosh priya neha rahul pooja rohan simran kavya amit dev ishita shreya ratan varun manan "
    "sumit roopa kabir aayan shubh advait anand tanya tarun sunny mani gokul vijay shruti suhani mohit kavitha "
    "rehan soham rupali".split()
)

# personality -> (pace, temperature). bulbul:v3 has no pitch/loudness control
# (docs.sarvam.ai), so speaking style is limited to how fast and how varied the
# delivery is: calmer = slower + steadier, energetic = faster + more varied.
# Sarvam's default temperature is 0.6. These are tuned presets, meant to be
# adjusted by ear rather than treated as fixed truth.
PERSONALITY_PRESETS: dict[str, tuple[float, float]] = {
    "professional": (1.00, 0.40),
    "friendly": (1.05, 0.80),
    "conversational": (1.05, 0.90),
    "confident": (1.00, 0.55),
    "empathetic": (0.92, 0.70),
    "energetic": (1.18, 0.95),
    "calm": (0.88, 0.35),
}


class SarvamTtsProvider:
    id = "sarvam"

    def is_configured(self) -> bool:
        return bool(integration_store.get_api_key("sarvam", organization_id="platform"))

    def check_voices(self, voice_refs: list[dict]) -> list[VoiceAvailability]:
        if not self.is_configured():
            not_connected = VoiceAvailability(
                False, "Sarvam AI isn't connected — an administrator needs to add its key in Platform Admin."
            )
            return [not_connected] * len(voice_refs)
        retired = VoiceAvailability(False, "This voice is no longer offered by Sarvam AI.")
        return [
            retired if ref.get("speaker") and ref["speaker"] not in VALID_SPEAKERS else VoiceAvailability(True)
            for ref in voice_refs
        ]

    def synthesize(self, text: str, voice_ref: dict, language: str, personality: Optional[str]) -> TtsResult:
        pace, temperature = PERSONALITY_PRESETS.get(personality or "", (None, None))
        try:
            audio = sarvam_client.synthesize_speech(
                text,
                language,
                speaker=voice_ref.get("speaker"),
                pace=pace,
                temperature=temperature,
            )
        except sarvam_client.SarvamApiError as err:
            raise TtsError(err.user_message, err.status_code) from None
        return TtsResult(audio=audio, media_type="audio/wav")

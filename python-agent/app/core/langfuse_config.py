"""Dynamic, platform-wide Langfuse configuration — reads what NestJS's
LangfuseConfigService (backend/src/langfuse/) writes to the "langfuse_config"
Mongo collection (same AES-256-GCM-encrypted-secret convention as
app/memory/integration_store.py, see app/encryption.py), builds a cached
Langfuse SDK client, and exposes small record_* helpers that
app/observability/tracing.py calls as a third sink alongside its existing
OTel span + Mongo agent_executions write. Every call here is wrapped so a
Langfuse outage, a bad key, or a library bug can never break the real
LLM/tool call it's observing — a missed trace, never a broken request.

Unlike integration_store.py's uncached per-call Mongo read, this module
caches the resolved config/client for a short TTL (same "module-level dict +
time.monotonic() freshness check" pattern app/integrations/tts/elevenlabs.py
already uses for its voice-list cache) rather than hitting Mongo on every
single LLM/tool call, and rather than copying anthropic_client.py's
unbounded @lru_cache (which has no TTL at all — a rotated secret would need
a process restart to take effect, which the admin "Rotate Secret Key" flow
this integration adds explicitly needs to avoid).

Langfuse Python SDK v5 (OTel-based) API used here — verified against the
official reference (python.reference.langfuse.com) and
observability/sdk/python/instrumentation docs, not assumed from training
data: Langfuse(public_key=, secret_key=, base_url=) constructs the client;
start_as_current_observation(name=, as_type=, input=, output=, metadata=,
level=, status_message=, model=, usage_details=, cost_details=,
end_on_exit=True) is a context manager that both creates AND fully
populates one observation in a single call (no separate .update() needed —
every value this module needs is already known by the time it's called,
since tracing.py only calls in after the real LLM/tool call has completed);
get_trace_url(*, trace_id=) returns the ready-to-open UI URL, resolving the
project id internally — this module never reconstructs that URL by hand.
"""

import logging
import random
import threading
import time
from dataclasses import dataclass

from app.encryption import decrypt
from app.memory.mongo_client import get_db

logger = logging.getLogger(__name__)

_CONFIG_TTL_SECONDS = 60
_lock = threading.Lock()
_cache: dict = {"at": 0.0, "settings": None, "client": None}


@dataclass
class LangfuseSettings:
    public_key: str
    secret_key: str
    base_url: str
    sampling_rate: float
    capture_input_output: bool


def _load_settings() -> LangfuseSettings | None:
    doc = get_db().langfuse_config.find_one({"organizationId": "platform"})
    if not doc or not doc.get("enabled") or not doc.get("publicKeyEncrypted") or not doc.get("secretKeyEncrypted"):
        return None
    try:
        public_key = decrypt(doc["publicKeyEncrypted"])
        secret_key = decrypt(doc["secretKeyEncrypted"])
    except Exception:
        logger.warning("Langfuse credentials on file could not be decrypted — treating Langfuse as disabled.")
        return None
    return LangfuseSettings(
        public_key=public_key,
        secret_key=secret_key,
        base_url=doc.get("baseUrl") or "https://cloud.langfuse.com",
        sampling_rate=doc.get("samplingRate", 100),
        capture_input_output=doc.get("captureInputOutput", True),
    )


def _get_client_and_settings():
    """(client, settings) from cache if fresh, otherwise re-reads Mongo and
    rebuilds the client. (None, None) means "Langfuse is off right now" —
    disabled, unconfigured, or the client failed to construct — which every
    caller treats as a plain no-op, never an error."""
    with _lock:
        if time.monotonic() - _cache["at"] < _CONFIG_TTL_SECONDS:
            return _cache["client"], _cache["settings"]

    settings_ = _load_settings()
    client = None
    if settings_:
        try:
            from langfuse import Langfuse

            client = Langfuse(public_key=settings_.public_key, secret_key=settings_.secret_key, base_url=settings_.base_url)
        except Exception:
            logger.exception("Failed to initialize the Langfuse client — Langfuse tracing is disabled until this resolves.")
            client, settings_ = None, None

    with _lock:
        _cache.update(at=time.monotonic(), settings=settings_, client=client)
    return client, settings_


def is_enabled() -> bool:
    client, settings_ = _get_client_and_settings()
    return client is not None and settings_ is not None


def invalidate_cache() -> None:
    """Forces the next call to re-read Mongo instead of waiting out the TTL.
    Not wired to a push channel yet (none exists between NestJS and
    python-agent) — kept as the explicit seam a future webhook/poll could
    call into without another caching redesign; until then, a credential or
    sampling-rate change takes effect within _CONFIG_TTL_SECONDS."""
    with _lock:
        _cache.update(at=0.0, settings=None, client=None)


def _sampled_in(sampling_rate: float) -> bool:
    if sampling_rate >= 100:
        return True
    if sampling_rate <= 0:
        return False
    return random.random() * 100 < sampling_rate


def record_llm_generation(
    name: str,
    *,
    organization_id: str | None,
    user_id: str,
    conversation_id: str,
    request_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float | None,
    success: bool,
    error: str | None,
    input_data=None,
    output_data=None,
) -> tuple[str | None, str | None]:
    """Records one already-completed LLM call as a Langfuse generation.
    Returns (trace_id, trace_url), or (None, None) if Langfuse is off, this
    call wasn't sampled in, or anything went wrong — never raises. tracing.py
    additionally wraps its own call to this in a try/except as a second line
    of defense, so a bug here is still never fatal to the real LLM call."""
    client, settings_ = _get_client_and_settings()
    if not client or not settings_ or not _sampled_in(settings_.sampling_rate):
        return None, None
    try:
        with client.start_as_current_observation(
            name=name,
            as_type="generation",
            model=model,
            input=input_data if settings_.capture_input_output else None,
            output=output_data if settings_.capture_input_output else None,
            usage_details={"input_tokens": input_tokens, "output_tokens": output_tokens},
            cost_details={"total": cost_usd} if cost_usd is not None else None,
            level="ERROR" if not success else "DEFAULT",
            status_message=error,
            metadata={
                "organizationId": organization_id,
                "userId": user_id,
                "conversationId": conversation_id,
                "requestId": request_id,
                "provider": provider,
            },
        ) as generation:
            trace_id = generation.trace_id
        return trace_id, client.get_trace_url(trace_id=trace_id)
    except Exception:
        logger.exception("Failed to record a Langfuse generation — continuing without a trace for this call.")
        return None, None


def record_tool_span(
    name: str,
    *,
    organization_id: str | None,
    user_id: str,
    conversation_id: str,
    success: bool,
) -> None:
    """Records one already-completed tool call as a Langfuse tool
    observation. Same never-raises guarantee as record_llm_generation
    above — a tool call's own trace isn't currently surfaced anywhere in the
    UI (unlike LLM calls, which get a stored trace_id/trace_url on their
    agent_executions row), so this intentionally returns nothing; it exists
    so a tool execution shows up nested under its parent trace in Langfuse's
    own UI, which is section 7's "tool execution... visible as nested
    observations" requirement."""
    client, settings_ = _get_client_and_settings()
    if not client or not settings_ or not _sampled_in(settings_.sampling_rate):
        return
    try:
        with client.start_as_current_observation(
            name=name,
            as_type="tool",
            level="ERROR" if not success else "DEFAULT",
            metadata={"organizationId": organization_id, "userId": user_id, "conversationId": conversation_id},
        ):
            pass
    except Exception:
        logger.exception("Failed to record a Langfuse tool span — continuing without a trace for this call.")

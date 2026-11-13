"""OpenTelemetry tracing setup — every LLM call and tool execution gets a
span with model/token/latency/cost attributes (see traced_llm_call below),
closing the "every AI request should be traceable end-to-end" gap.
opentelemetry-api/sdk are already installed (a crewai dependency — see
requirements.txt — previously unused by this app's own code), so this adds
no new dependency.

Exports to console by default: there's no OTel collector/Jaeger available in
this dev environment (see python-agent/.env's note about Docker Desktop
being unavailable here). Set OTEL_EXPORTER_OTLP_ENDPOINT to route spans to a
real collector instead, with zero code changes anywhere that calls tracer.

Both context managers also persist a record to Mongo (see
app.observability.execution_store) — the OTel span alone is console-only in
this environment and was never queryable by the NestJS backend's Command
Center API (Phase 5). One instrumentation point, so callers only need to
pass a few more parameters, not learn a second API.

Known limitation: tool execution (app.agent.graph's tools_node) and the
orchestrator's specialist fan-out (app.agent.orchestrator) both run inside a
ThreadPoolExecutor — OTel span context doesn't automatically propagate
across that thread boundary via .submit()/.map(), so those spans won't
always nest correctly under a request's root span in the exporter output.
Not fixed here (would need explicit context propagation into each worker
thread); flagged rather than silently accepted as "it just works."
"""

import os
import time
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor

from app.core import langfuse_config, provider_account_status
from app.observability import execution_store
from app.observability.cost import estimate_cost

_provider = TracerProvider(resource=Resource.create({"service.name": "python-agent"}))

_otlp_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
if _otlp_endpoint:
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

    _provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=_otlp_endpoint)))
else:
    _provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))

trace.set_tracer_provider(_provider)
tracer = trace.get_tracer("python-agent")

# Confirmed-only provider-exhaustion detection (LLM Provider Finance feature)
# — verified against the installed anthropic==0.120.2 SDK's own
# _exceptions.py, not guessed.
#
# FIX (previously shipped as isinstance(exc, BadRequestError), which could
# never actually fire): Anthropic's real billing_error is delivered over
# HTTP 402, confirmed against the current official docs — and 402 has no
# dedicated subclass in the SDK's _exceptions.py (only 400/401/403/404/409/
# 413/422/429/503/529/504 do), so a real 402 response constructs the generic
# base APIStatusError, which BadRequestError (status_code hard-locked to 400)
# can never match. The fix checks APIStatusError instead: `.type` is parsed
# generically in THAT class's own __init__ for every subclass and status
# code (confirmed by reading _exceptions.py directly), so this one change
# catches 402/billing_error without broadening which `.type` values count —
# RateLimitError (429) still can't match since "rate_limit_error" isn't in
# the set below.
#
# Groq's SDK exposes no `.type` field at all (groq._exceptions.APIStatusError
# only has status_code/body), but console.groq.com/docs/spend-limits
# confirms a real, documented signal: a configured spend limit being hit
# returns HTTP 400 with error code "blocked_api_access". The exact JSON
# nesting isn't shown in the docs text, so this checks the OpenAI-compatible
# {"error": {"code": ...}} shape Groq's API otherwise follows, AND a
# top-level {"code": ...} as a defensive fallback — never a guess at a
# single unconfirmed nesting.
try:
    import anthropic as _anthropic_sdk
except Exception:  # pragma: no cover - the SDK is always installed in practice
    _anthropic_sdk = None

try:
    import groq as _groq_sdk
except Exception:  # pragma: no cover - the SDK is always installed in practice
    _groq_sdk = None

_ANTHROPIC_EXHAUSTED_ERROR_TYPES = {"billing_error", "invalid_request_error"}
_GROQ_EXHAUSTED_ERROR_CODE = "blocked_api_access"


def _groq_error_code(body: object) -> str | None:
    if not isinstance(body, dict):
        return None
    nested = body.get("error")
    if isinstance(nested, dict) and isinstance(nested.get("code"), str):
        return nested["code"]
    if isinstance(body.get("code"), str):
        return body["code"]
    return None


def _mark_provider_exhausted_if_confirmed(provider: str, exc: Exception) -> None:
    if (
        provider == "anthropic"
        and _anthropic_sdk is not None
        and isinstance(exc, _anthropic_sdk.APIStatusError)
        and getattr(exc, "type", None) in _ANTHROPIC_EXHAUSTED_ERROR_TYPES
    ):
        provider_account_status.mark_exhausted(provider)
    elif (
        provider == "groq"
        and _groq_sdk is not None
        and isinstance(exc, _groq_sdk.APIStatusError)
        and _groq_error_code(getattr(exc, "body", None)) == _GROQ_EXHAUSTED_ERROR_CODE
    ):
        provider_account_status.mark_exhausted(provider)


@contextmanager
def traced_llm_call(
    name: str,
    *,
    organization_id: str | None = None,
    user_id: str = "",
    conversation_id: str = "",
    provider: str = "anthropic",
    model: str = "",
    request_id: str = "",
    **attributes,
):
    """Wraps one LLM API call. Usage: `with traced_llm_call("classify",
    organization_id=..., user_id=..., conversation_id=..., provider="anthropic",
    model=...) as usage: ... usage["input_tokens"] = response.usage.input_tokens;
    usage["output_tokens"] = ...` — token/cost attributes are only recorded
    if the caller fills in `usage`; an empty dict (e.g. the call raised
    before getting a response) still records latency/success/error, never
    breaks the call itself (the original exception always re-raises
    unchanged).

    request_id correlates this call back to the billing reservation for the
    chat turn it belongs to (see backend/src/billing/reservation.service.ts)
    — threaded in from app.routes.chat, through orchestrator/graph/
    llm_client, down to every call site. Empty string for call sites that
    don't thread it (yet), which is fine — settle() just won't find rows.
    """
    start = time.monotonic()
    with tracer.start_as_current_span(f"llm.{name}") as span:
        span.set_attribute("provider", provider)
        if model:
            span.set_attribute("model", model)
        for key, value in attributes.items():
            span.set_attribute(key, value)
        usage: dict = {}
        success = True
        error: str | None = None
        try:
            yield usage
        except Exception as exc:
            success = False
            error = str(exc)[:500]
            try:
                _mark_provider_exhausted_if_confirmed(provider, exc)
            except Exception:
                pass  # observability must never mask the real exception below
            raise
        finally:
            latency_ms = (time.monotonic() - start) * 1000
            span.set_attribute("latency_ms", latency_ms)
            span.set_attribute("success", success)
            input_tokens = usage.get("input_tokens", 0)
            output_tokens = usage.get("output_tokens", 0)
            cache_creation_input_tokens = usage.get("cache_creation_input_tokens", 0)
            cache_read_input_tokens = usage.get("cache_read_input_tokens", 0)
            reasoning_tokens = usage.get("reasoning_tokens")
            cost_usd = (
                estimate_cost(
                    input_tokens,
                    output_tokens,
                    provider,
                    model,
                    cache_creation_input_tokens,
                    cache_read_input_tokens,
                )
                if usage
                else None
            )
            if usage:
                span.set_attribute("tokens.input", input_tokens)
                span.set_attribute("tokens.output", output_tokens)
                if cost_usd is not None:
                    span.set_attribute("cost.usd", cost_usd)
            # A third sink alongside the OTel span above and the Mongo write
            # below — see app/core/langfuse_config.py's own module docstring
            # for the full reasoning. Deliberately its own try/except,
            # separate from the Mongo write's: Langfuse being briefly down
            # must never also cost us the Mongo row (billing/AI-Usage
            # dashboard data), and vice versa.
            langfuse_trace_id: str | None = None
            langfuse_trace_url: str | None = None
            try:
                langfuse_trace_id, langfuse_trace_url = langfuse_config.record_llm_generation(
                    name,
                    organization_id=organization_id,
                    user_id=user_id,
                    conversation_id=conversation_id,
                    request_id=request_id,
                    provider=provider,
                    model=model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cost_usd=cost_usd,
                    success=success,
                    error=error,
                    input_data=usage.get("input"),
                    output_data=usage.get("output"),
                )
            except Exception:
                pass  # observability must never break the actual LLM call
            try:
                execution_store.record_llm_execution(
                    organization_id=organization_id,
                    user_id=user_id,
                    conversation_id=conversation_id,
                    name=name,
                    provider=provider,
                    model=model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cache_creation_input_tokens=cache_creation_input_tokens,
                    cache_read_input_tokens=cache_read_input_tokens,
                    reasoning_tokens=reasoning_tokens,
                    cost_usd=cost_usd,
                    latency_ms=latency_ms,
                    success=success,
                    error=error,
                    request_id=request_id,
                    langfuse_trace_id=langfuse_trace_id,
                    langfuse_trace_url=langfuse_trace_url,
                )
            except Exception:
                pass  # persistence must never break the actual LLM call


@contextmanager
def traced_tool_call(
    name: str,
    user_id: str = "",
    *,
    organization_id: str | None = None,
    conversation_id: str = "",
):
    start = time.monotonic()
    with tracer.start_as_current_span(f"tool.{name}") as span:
        span.set_attribute("tool.name", name)
        span.set_attribute("user_id", user_id)
        outcome: dict = {}
        try:
            yield outcome
        finally:
            latency_ms = (time.monotonic() - start) * 1000
            success = outcome.get("success", True)
            span.set_attribute("latency_ms", latency_ms)
            span.set_attribute("success", success)
            try:
                langfuse_config.record_tool_span(
                    name,
                    organization_id=organization_id,
                    user_id=user_id,
                    conversation_id=conversation_id,
                    success=success,
                )
            except Exception:
                pass  # observability must never break the actual tool call
            try:
                execution_store.record_tool_execution(
                    organization_id=organization_id,
                    user_id=user_id,
                    conversation_id=conversation_id,
                    name=name,
                    latency_ms=latency_ms,
                    success=success,
                )
            except Exception:
                pass  # persistence must never break the actual tool call

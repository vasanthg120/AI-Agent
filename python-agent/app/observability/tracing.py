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
            raise
        finally:
            latency_ms = (time.monotonic() - start) * 1000
            span.set_attribute("latency_ms", latency_ms)
            span.set_attribute("success", success)
            input_tokens = usage.get("input_tokens", 0)
            output_tokens = usage.get("output_tokens", 0)
            cache_creation_input_tokens = usage.get("cache_creation_input_tokens", 0)
            cache_read_input_tokens = usage.get("cache_read_input_tokens", 0)
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
                    cost_usd=cost_usd,
                    latency_ms=latency_ms,
                    success=success,
                    error=error,
                    request_id=request_id,
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

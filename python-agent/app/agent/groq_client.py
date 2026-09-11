"""Fast, tool-free completion path for general-knowledge/coding/casual
requests (see app.agent.anthropic_client.PLAN_TOOL's "general" mode) —
CRM/Outlook/RAG/multi-step reasoning never comes here, they stay on the
Anthropic path in app.agent.anthropic_client.

Mirrors anthropic_client.call()'s shape (normalized output items, on_event
delta/progress streaming, cancel_event support) so app.agent.orchestrator
can swap providers for this one branch with no changes to anything
downstream (final_text(), tools_used tracking, cancellation).
"""

from functools import lru_cache
from typing import Callable

from groq import Groq

from app.config import settings
from app.memory import integration_store
from app.observability.tracing import traced_llm_call

from app.agent.llm_client import SYSTEM_PROMPT


@lru_cache
def _client(api_key: str) -> Groq:
    return Groq(api_key=api_key)


def _resolve_api_key() -> str:
    # Platform-wide credential ONLY (organizationId="platform"), same exact
    # rule as anthropic_client.py._resolve_api_key / sarvam_client.py's
    # _require_api_key — no static .env fallback, no arbitrary-organization
    # credential. Set via Admin-haive Settings -> AI Provider -> Groq.
    # Safe to enforce strictly here: call() below raises on a missing key,
    # and orchestrator.py already treats ANY Groq failure as "fall through to
    # the unchanged Claude path" — so an unconnected Groq credential just
    # means the fast lane stays off, never a broken reply.
    return integration_store.get_api_key("groq", organization_id="platform")


def _item_text(item: dict) -> str:
    """Tool-call bookkeeping (function_call/function_call_output) from an
    earlier turn is irrelevant to a tool-free general question — flattened
    out rather than translated, unlike anthropic_client's item conversion."""
    if item.get("type") in ("function_call", "function_call_output"):
        return ""
    content = item.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") in ("output_text", "input_text", "text")
        )
    return ""


def _to_groq_messages(input_items: list[dict]) -> list[dict]:
    messages: list[dict] = []
    for item in input_items:
        text = _item_text(item)
        if not text:
            continue
        role = "assistant" if item.get("role") == "assistant" else "user"
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"] += "\n" + text
        else:
            messages.append({"role": role, "content": text})
    return messages


def call(
    input_items: list[dict],
    on_event: Callable[[dict], None] | None = None,
    system_prompt: str | None = None,
    cancel_event=None,
    *,
    organization_id: str | None = None,
    user_id: str = "",
    conversation_id: str = "",
    request_id: str = "",
) -> list[dict]:
    """Raises on any failure (missing key, API error) — app.agent.orchestrator
    treats that as a signal to fall back to the unchanged Anthropic path, so
    a Groq outage or quota exhaustion never blocks a reply."""
    api_key = _resolve_api_key()
    if not api_key:
        raise RuntimeError("No Groq API key configured")

    messages = [{"role": "system", "content": system_prompt or SYSTEM_PROMPT}] + _to_groq_messages(input_items)

    with traced_llm_call(
        "general",
        organization_id=organization_id,
        user_id=user_id,
        conversation_id=conversation_id,
        provider="groq",
        model=settings.groq_model,
        request_id=request_id,
    ) as usage:
        accumulated: list[str] = []
        stream = _client(api_key).chat.completions.create(
            model=settings.groq_model,
            max_tokens=1024,
            messages=messages,
            stream=True,
            # Groq's OpenAI-wire-compatible REST API emits a final usage-only
            # chunk (empty choices) when this is set, but the installed groq
            # SDK (1.6.0) has no typed `stream_options` param for it yet —
            # `extra_body` passes it straight through to the raw request body.
            # Best-effort token capture either way; guarded below since an
            # unexpected chunk shape must never break the actual reply.
            extra_body={"stream_options": {"include_usage": True}},
        )
        for chunk in stream:
            if cancel_event is not None and cancel_event.is_set():
                break
            try:
                if getattr(chunk, "usage", None):
                    usage["input_tokens"] = chunk.usage.prompt_tokens
                    usage["output_tokens"] = chunk.usage.completion_tokens
            except Exception:
                pass
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                accumulated.append(delta)
                if on_event:
                    on_event({"type": "delta", "text": delta})

    return [
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "".join(accumulated)}],
        }
    ]

"""Persists what app.observability.tracing's context managers already
compute (latency/tokens/cost/success) to Mongo — the OTel spans alone are
console-only in this dev environment (see tracing.py's docstring) and were
never queryable by the NestJS backend's Command Center API.

Field names are deliberately camelCase, not Python's native snake_case —
every other collection in this shared "agent" database (Conversation,
DailyReport, TimelineEvent, ...) uses camelCase, and NestJS reads this
collection directly (read-only from its side; this module is the only
writer), so matching that convention keeps the database internally
consistent instead of introducing the one snake_case collection in it.
"""

from datetime import datetime, timezone

from app.memory.mongo_client import get_db


def record_llm_execution(
    *,
    organization_id: str | None,
    user_id: str,
    conversation_id: str,
    name: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float | None,
    latency_ms: float,
    success: bool,
    error: str | None,
    request_id: str = "",
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
) -> None:
    now = datetime.now(timezone.utc)
    get_db().agent_executions.insert_one(
        {
            "organizationId": organization_id,
            "userId": user_id,
            "conversationId": conversation_id,
            # Correlates this row back to the billing reservation that
            # pre-authorized the chat turn it belongs to (see
            # backend/src/billing/reservation.service.ts's settle()) — empty
            # string for call sites that don't thread a request_id through
            # yet (e.g. the scheduled report crew), which settle() simply
            # won't find any rows for.
            "requestId": request_id,
            "kind": "llm",
            "name": name,
            "provider": provider,
            "model": model,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            # Cache tokens are reported separately by Anthropic and are NOT
            # already included in inputTokens — see cost.py's docstring.
            # totalTokens intentionally excludes them too (matches Anthropic's
            # own "input + output" definition of billable-turn size); they're
            # kept as their own fields for the Admin token-usage breakdown.
            "cacheCreationInputTokens": cache_creation_input_tokens,
            "cacheReadInputTokens": cache_read_input_tokens,
            "totalTokens": input_tokens + output_tokens,
            "costUsd": cost_usd,
            "currency": "USD",
            "latencyMs": latency_ms,
            "success": success,
            "error": error,
            "occurredAt": now,
            # Written directly (not left to Mongoose's timestamps:true) —
            # this collection's sole writer is pymongo, which bypasses
            # Mongoose's document middleware entirely.
            "createdAt": now,
        }
    )


def record_tool_execution(
    *,
    organization_id: str | None,
    user_id: str,
    conversation_id: str,
    name: str,
    latency_ms: float,
    success: bool,
) -> None:
    now = datetime.now(timezone.utc)
    get_db().agent_executions.insert_one(
        {
            "organizationId": organization_id,
            "userId": user_id,
            "conversationId": conversation_id,
            "kind": "tool",
            "name": name,
            "latencyMs": latency_ms,
            "success": success,
            "occurredAt": now,
            "createdAt": now,
        }
    )

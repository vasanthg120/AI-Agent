"""Safety limits for the dynamic recursive multi-agent system — the
platform ceiling; see app.agent.dynamic.org_limits for the per-organization
override layered on top (same clamp-down-only rule).

Read from app.config.settings (env-var backed, same pattern as
MAX_TOOL_ROUNDS in app.agent.graph) rather than hardcoded.

Enforced by master_agent.run_task before creating each new sub-agent or
recursing further: exceeding MAX_DEPTH or MAX_AGENTS_PER_REQUEST falls that
branch back to a single direct attempt (or a clearly-marked "budget
exhausted" result) rather than ever silently dropping part of the task.

MAX_EXECUTION_SECONDS bounds the whole request-wide call tree (checked at
every recursion/branch boundary in master_agent) — it does NOT wrap a
single leaf's app.agent.graph.get_graph().invoke() call in its own timeout,
since that would need a bigger change (running the synchronous LangGraph
loop under a cancellable timeout) out of scope for this phase. A single
very slow leaf can still run past the deadline; only documented here, not
silently claimed as fully enforced.

MAX_RETRIES bounds how many times master_agent._execute_leaf_with_retry may
retry ONE leaf's own transient failure (Phase 2.5, Sub-step B) — never a
re-decomposition, never applied to a structural "skipped" result.

MAX_MODEL_CALLS/MAX_TOOL_CALLS/MAX_TOKENS/MAX_COST_USD (Sub-step C) bound
the whole request-wide tree the same way MAX_EXECUTION_SECONDS does —
checked before starting the NEXT agent/branch, not a mid-call cutoff for
whichever leaf is already running.
"""

from app.config import settings

MAX_DEPTH = settings.dynamic_agents_max_depth
MAX_AGENTS_PER_REQUEST = settings.dynamic_agents_max_per_request
MAX_EXECUTION_SECONDS = settings.dynamic_agents_max_execution_seconds
MAX_RETRIES = settings.dynamic_agents_max_retries
MAX_MODEL_CALLS = settings.dynamic_agents_max_model_calls
MAX_TOOL_CALLS = settings.dynamic_agents_max_tool_calls
MAX_TOKENS = settings.dynamic_agents_max_tokens
MAX_COST_USD = settings.dynamic_agents_max_cost_usd

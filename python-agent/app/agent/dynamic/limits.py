"""Safety limits for the dynamic recursive multi-agent system — the
platform ceiling; see app.agent.dynamic.org_limits for the per-organization
override layered on top (same clamp-down-only rule).

Read from app.config.settings (env-var backed, same pattern as
MAX_TOOL_ROUNDS in app.agent.graph) rather than hardcoded.

Enforced by master_agent.run_task before creating each new sub-agent or
recursing further: exceeding MAX_DEPTH or MAX_AGENTS_PER_REQUEST falls that
branch back to a single direct attempt (or a clearly-marked "budget
exhausted" result) rather than ever silently dropping part of the task.

MAX_EXECUTION_SECONDS bounds the whole request-wide call tree: checked at
every recursion/branch boundary in master_agent, and by usage_limiter before
each model or tool call a running leaf makes. It does NOT wrap a leaf in its
own timeout, since that would need a bigger change (running the synchronous
LangGraph loop under a cancellable timeout). A single very slow call can
still run past the deadline; only documented here, not silently claimed as
fully enforced.

MAX_RETRIES bounds how many times master_agent._execute_leaf_with_retry may
retry ONE leaf's own transient failure (Phase 2.5, Sub-step B) — never a
re-decomposition, never applied to a structural "skipped" result.

How strictly each is enforced across parallel sub-agents:

HARD  MAX_DEPTH, MAX_AGENTS_PER_REQUEST (slot taken under a lock when an agent
      is created), MAX_MODEL_CALLS and MAX_TOOL_CALLS (each call reserved
      under a lock before it is made; see usage_limiter for exactly which
      calls are counted). MAX_RETRIES is a hard per-agent bound.
SOFT  MAX_TOKENS and MAX_COST_USD: a call's usage is only known after it
      finishes, so they are checked from recorded usage before an agent
      starts. Agents already running (at most MAX_AGENTS_PER_REQUEST, each up
      to MAX_TOOL_ROUNDS + 1 rounds, within MAX_MODEL_CALLS in total) can
      take the request past them, and there is no fixed bound in tokens or
      dollars. A failed usage lookup counts as zero usage.
SOFT  MAX_EXECUTION_SECONDS: checked before an agent starts, around each
      retry and before each sub-agent model or tool call. A call already in
      flight is not interrupted.
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

"""The dynamic agent instance the approved plan's Factory section asks for
— deliberately thin: it carries identity and scope, not its own execution
engine. Running one just means folding these fields into a normal
AgentState and calling app.agent.graph.get_graph().invoke() (see
master_agent._execute_leaf), so every existing protection — MAX_TOOL_ROUNDS,
the allowed_tools permission gate, rate limiting, tracing — applies
unchanged, inherited rather than reimplemented.
"""

import uuid
from dataclasses import dataclass, field


@dataclass
class DynamicAgent:
    name: str
    task_description: str
    allowed_tools: list[str]
    depth: int
    parent_id: str | None = None
    id: str = field(default_factory=lambda: f"dyn-{uuid.uuid4().hex[:12]}")
    status: str = "pending"  # pending | running | done | failed
    result: str | None = None
    error: str | None = None
    # Set with `error` when an attempt raises (see retry_policy.classify).
    error_category: str | None = None
    error_retryable: bool = False
    # Populated only for an agent that actually ran as a leaf (see
    # master_agent._execute_leaf) — the real tool names its own
    # get_graph().invoke() call used, needed by app.agent.orchestrator's
    # dynamic-delegation path to aggregate tools_used across the whole
    # tree exactly like the fixed-specialist path already does.
    tools_used: list[str] = field(default_factory=list)
    # Populated only when this agent itself recursed further (see
    # master_agent._run_agent) — the sub-agents it delegated to. See
    # master_agent._flatten for why a decomposed agent is otherwise
    # transparent in a run_task() call's returned agents list.
    children: list["DynamicAgent"] = field(default_factory=list)
    # Parent agent retry (Phase 2.5, Sub-step B) — see
    # master_agent._execute_leaf_with_retry. retry_count is how many retries
    # were actually attempted (0 means it either succeeded or failed on the
    # first try); retry_history preserves each earlier attempt's error
    # string ("preserve execution history" — the final agent.error/result
    # only ever reflects the LAST attempt).
    retry_count: int = 0
    retry_history: list[str] = field(default_factory=list)
    # Structured output (Phase 2.5, Sub-step E) — set by the PARENT's own
    # decomposition decision (anthropic_client.plan_dynamic_delegation's
    # optional per-sub-agent output_schema) only when the sub-task's result
    # needs to be machine-consumed in a specific shape. None (the vast
    # majority of agents) means a normal prose answer, validated against
    # nothing — see master_agent._execute_leaf's own handling.
    expected_output_schema: dict | None = None
    # Provider-compatibility prep (Phase 2.5, Sub-step F) — a REAL field
    # now (previously hardcoded inline in master_agent._execute_leaf's
    # state dict), but still always "anthropic": app.agent.llm_client.
    # call_llm's own docstring confirms the underlying tool-calling graph is
    # Anthropic-only today (Groq has no tool-calling support — see
    # app.agent.router.choose_provider). This is architecture preparation
    # for a future provider choice, not a working multi-provider path —
    # anthropic_client.plan_dynamic_delegation's own plan tool schema
    # restricts this to the single enum value "anthropic" for the same
    # reason, never fabricating support that doesn't exist.
    provider: str = "anthropic"
    # True for a sub-agent created by a parent's decomposition. Its slot in
    # the request-wide agent budget is taken at creation, so running it must
    # never take a second one. False only for the request's root agent, which
    # takes its slot only if it executes directly.
    created_by_parent: bool = False

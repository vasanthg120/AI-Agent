import json
import logging
from concurrent.futures import ThreadPoolExecutor

from langgraph.graph import END, START, StateGraph

from app.agent.llm_client import call_llm
from app.agent.router import choose_model, choose_provider
from app.agent.state import AgentState
from app.config import settings
from app.memory.working_memory import cached_execute_tool
from app.tools.registry import get_tool_definitions

logger = logging.getLogger(__name__)

# Was a hardcoded 5 — now settings.max_tool_rounds (default raised to 8, see
# config.py). Read once at import time like the old constant; if a
# deployment needs to change it, restarting the process (which reloads env
# vars) already picks up the new value, same as every other setting here.
MAX_TOOL_ROUNDS = settings.max_tool_rounds


def planner_node(state: AgentState) -> dict:
    provider = state.get("provider") or choose_provider(state)
    allowed_tools = state.get("allowed_tools")
    output_items, used_provider = call_llm(
        state["messages"],
        provider=provider,
        on_event=state.get("on_event"),
        system_prompt=state.get("system_prompt"),
        tools=get_tool_definitions(allowed_tools) if allowed_tools else None,
        cancel_event=state.get("cancel_event"),
        model=choose_model(state),
        organization_id=state.get("organization_id"),
        user_id=state["user_id"],
        conversation_id=state["conversation_id"],
        request_id=state.get("request_id", ""),
        agent_instance_id=state.get("agent_instance_id"),
        parent_agent_id=state.get("parent_agent_id"),
        delegation_depth=state.get("delegation_depth"),
    )
    pending_calls = [item for item in output_items if item.get("type") == "function_call"]
    return {"messages": output_items, "pending_calls": pending_calls, "provider": used_provider}


def tools_node(state: AgentState) -> dict:
    context = {
        "user_id": state["user_id"],
        "organization_id": state.get("organization_id"),
        "conversation_id": state["conversation_id"],
        # Delegation-tree identity (see AgentState's own field comments) —
        # execute_tool reads these straight off context, no signature change
        # needed there; None for every non-dynamic-agent caller.
        "agent_instance_id": state.get("agent_instance_id"),
        "parent_agent_id": state.get("parent_agent_id"),
        "delegation_depth": state.get("delegation_depth"),
    }
    pending_calls = state["pending_calls"]
    allowed_tools = state.get("allowed_tools")

    def run_call(call: dict) -> str:
        args = json.loads(call.get("arguments") or "{}")
        return cached_execute_tool(call["name"], args, context, allowed_tools=allowed_tools)

    # Claude often requests several independent lookups in one turn (e.g. one
    # crm_note call per contact) — those are I/O-bound HTTP calls with no
    # dependency on each other, so run them concurrently instead of one at a
    # time. executor.map preserves input order, so zip pairs each call with
    # its own result correctly.
    with ThreadPoolExecutor(max_workers=min(len(pending_calls), 8) or 1) as executor:
        results = list(executor.map(run_call, pending_calls))

    tools_used = [call["name"] for call in pending_calls]
    result_items = [
        {"type": "function_call_output", "call_id": call["call_id"], "output": result}
        for call, result in zip(pending_calls, results)
    ]

    return {
        "messages": result_items,
        "pending_calls": [],
        "tools_used": tools_used,
        "rounds": state.get("rounds", 0) + 1,
    }


def should_continue(state: AgentState) -> str:
    cancel_event = state.get("cancel_event")
    if cancel_event is not None and cancel_event.is_set():
        return END
    if state["pending_calls"] and state.get("rounds", 0) < MAX_TOOL_ROUNDS:
        return "tools"
    if state["pending_calls"]:
        # Hit the round cap with more tool calls still queued — the model
        # wanted to keep investigating (e.g. paging through more CRM
        # records) but was cut off here. Silent otherwise: the turn still
        # "succeeds" with whatever's been gathered so far, just possibly
        # incomplete — this is the one place that's visible in logs.
        logger.warning(
            "Hit MAX_TOOL_ROUNDS (%d) with %d tool call(s) still pending for conversation_id=%s — "
            "answering with partial data instead of continuing to investigate",
            MAX_TOOL_ROUNDS,
            len(state["pending_calls"]),
            state.get("conversation_id", ""),
        )
    return END


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("planner", planner_node)
    graph.add_node("tools", tools_node)
    graph.add_edge(START, "planner")
    graph.add_conditional_edges("planner", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "planner")
    return graph.compile()


_compiled_graph = None


def get_graph():
    global _compiled_graph
    if _compiled_graph is None:
        _compiled_graph = build_graph()
    return _compiled_graph


def final_text(state: dict) -> str:
    for item in reversed(state["messages"]):
        if item.get("type") == "message" and item.get("role") == "assistant":
            return "\n".join(
                c.get("text", "") for c in item.get("content", []) if c.get("type") == "output_text"
            )
    return ""

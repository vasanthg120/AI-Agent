"""Planner/multi-agent entry point — sits in front of app.agent.graph.

app.routes.chat calls run() here instead of get_graph().invoke() directly.
Every request is classified first (app.agent.anthropic_client.classify_request):
single-domain requests fall straight through to the existing planner<->tools
loop, completely unchanged (same function, same call, same streaming
events) — this is the majority path and carries zero behavior change.
Only requests that clearly span multiple domains get decomposed: scoped
specialist sub-agents (app.agent.specialists) run concurrently, each a
restricted instance of the same graph, and a final synthesis pass merges
their findings into one reply in the resolved persona's voice.

Every reply — from either path — then goes through one bounded reflection
pass (_reflect): a cheap critic call checks whether the reply actually
addresses the request, and if not, runs exactly one corrective round before
returning. Never loops more than once, so a bad critique can't run away.

Any failure in classification, delegation, or reflection falls back to the
unchanged single-loop path / draft reply, so a request never fails solely
because of this layer.
"""

from concurrent.futures import ThreadPoolExecutor

from app.agent import anthropic_client, cancellation, groq_client, trivial_router
from app.agent.graph import final_text, get_graph
from app.agent.llm_client import SYSTEM_PROMPT
from app.agent.specialists import SPECIALISTS

MAX_ASSIGNMENTS = len(SPECIALISTS)


def _last_user_text(messages: list[dict]) -> str:
    content = messages[-1].get("content", "") if messages else ""
    return content if isinstance(content, str) else str(content)


def _reflect(state_input: dict, output_items: list[dict], tools_used: list[str]) -> dict:
    """Bounded self-critique: judges the draft reply against the original
    request, and if it finds a concrete gap, runs exactly one corrective
    round (the plain single-loop graph, full tool access) before returning.
    Any failure — critique or the corrective round itself — returns the
    original draft unchanged rather than risk a broken/incomplete reply.

    Skips entirely once cancellation was requested (app.agent.cancellation):
    critiquing/correcting a turn the user already asked to stop is wasted
    work at best. At worst it's actively harmful — a cancelled corrective
    round returns empty text (cancel_event is already set, so its very
    first streamed-event check fires immediately), and that empty message
    gets appended *after* the real partial draft; final_text() always
    prefers the last assistant message, so the good partial answer would be
    silently overwritten with nothing. Caught via a live cancellation test,
    not by inspection — this exact case is what taught us it needed a check.
    """
    on_event = state_input.get("on_event")
    draft = final_text({"messages": output_items})

    cancel_event = state_input.get("cancel_event")
    if cancel_event is not None and cancel_event.is_set():
        return {"messages": output_items, "tools_used": tools_used}

    try:
        verdict = anthropic_client.critique_response(
            _last_user_text(state_input["messages"]),
            draft,
            organization_id=state_input.get("organization_id"),
            user_id=state_input.get("user_id", ""),
            conversation_id=state_input.get("conversation_id", ""),
            request_id=state_input.get("request_id", ""),
        )
    except Exception:
        return {"messages": output_items, "tools_used": tools_used}

    if verdict.get("complete", True) or not verdict.get("missing"):
        return {"messages": output_items, "tools_used": tools_used}

    if cancel_event is not None and cancel_event.is_set():
        return {"messages": output_items, "tools_used": tools_used}

    if on_event:
        on_event({"type": "reflecting", "reason": verdict["missing"]})

    try:
        corrected = get_graph().invoke(
            {
                **state_input,
                "messages": state_input["messages"]
                + output_items
                + [
                    {
                        "role": "user",
                        "content": (
                            f"[Self-review note, not from the user: your draft above is missing "
                            f"{verdict['missing']} — revise your answer to cover it. Don't mention "
                            f"this note or that a review happened; just give the improved answer.]"
                        ),
                    }
                ],
                "pending_calls": [],
                "tools_used": [],
                "rounds": 0,
                "provider": "",
                "allowed_tools": None,
            }
        )
    except Exception:
        return {"messages": output_items, "tools_used": tools_used}

    return {
        "messages": output_items + corrected["messages"],
        "tools_used": tools_used + corrected.get("tools_used", []),
    }


def _attach_suggestions(state_input: dict, result: dict) -> dict:
    """Contextual Chat Suggestions — best-effort, additive. Called only from
    the two call sites below that already call _reflect(), so this never
    runs on the Groq "general" fast lane (that path returns before either
    call site is reached) — preserving that lane's latency untouched. Any
    failure (bad model config, rate limit, timeout) or an in-flight
    cancellation degrades to an empty suggestions list, exactly like
    _reflect's own failure handling degrades to the unchanged draft — the
    real reply is never delayed beyond this one bounded call, never blocked,
    never altered."""
    cancel_event = state_input.get("cancel_event")
    if cancel_event is not None and cancel_event.is_set():
        return {**result, "suggestions": []}
    try:
        reply_text = final_text({"messages": result["messages"]})
        suggestions = anthropic_client.suggest_follow_ups(
            _last_user_text(state_input["messages"]),
            reply_text,
            organization_id=state_input.get("organization_id"),
            user_id=state_input.get("user_id", ""),
            conversation_id=state_input.get("conversation_id", ""),
            request_id=state_input.get("request_id", ""),
        )
    except Exception:
        suggestions = []
    return {**result, "suggestions": suggestions}


SYNTHESIS_PROMPT_SUFFIX = """

You are synthesizing findings gathered by specialized sub-agents into one final answer for \
the user. Combine their findings into a single coherent, concise response in your usual \
voice — don't mention the sub-agents or that work was delegated, just answer as if you \
gathered this yourself."""


def _run_specialist(
    agent_key: str,
    task: str,
    base_messages: list[dict],
    user_id: str,
    organization_id: str | None,
    conversation_id: str,
    cancel_event,
    request_id: str = "",
) -> dict:
    spec = SPECIALISTS[agent_key]
    result = get_graph().invoke(
        {
            "messages": base_messages + [{"role": "user", "content": task}],
            "pending_calls": [],
            "tools_used": [],
            "rounds": 0,
            "provider": "",
            "user_id": user_id,
            "organization_id": organization_id,
            "conversation_id": conversation_id,
            "on_event": None,  # concurrent specialists share one SSE stream; only coarse start/done markers go out, from run() below
            "system_prompt": spec["system_prompt"],
            "allowed_tools": spec["tools"],
            "cancel_event": cancel_event,
            "request_id": request_id,
        }
    )
    return {"agent": agent_key, "task": task, "output": final_text(result), "tools_used": result.get("tools_used", [])}


def run(state_input: dict) -> dict:
    """Registers a cancellation handle for this request's conversation_id
    (see app.agent.cancellation) for the duration of the call, so /chat/stream/cancel
    can reach it — cleaned up in `finally` regardless of how this returns.
    """
    on_event = state_input.get("on_event")
    conversation_id = state_input.get("conversation_id", "")
    cancel_event = cancellation.start(conversation_id) if conversation_id else None
    state_input = {**state_input, "cancel_event": cancel_event}

    try:
        # Deterministic, zero-cost pre-filter tried first — see
        # app.agent.trivial_router's own docstring for why its allow-list is
        # deliberately narrow. Falls through to the real classify_request
        # call (unchanged below) whenever it isn't confident.
        plan = trivial_router.trivial_plan(state_input["messages"])
        if plan is None:
            try:
                plan = anthropic_client.classify_request(
                    state_input["messages"],
                    organization_id=state_input.get("organization_id"),
                    user_id=state_input.get("user_id", ""),
                    conversation_id=state_input.get("conversation_id", ""),
                    request_id=state_input.get("request_id", ""),
                )
            except Exception:
                plan = {"mode": "simple", "assignments": [], "reasoning": ""}

        if on_event and plan.get("reasoning"):
            on_event({"type": "reasoning", "text": plan["reasoning"]})

        if plan.get("mode") == "general":
            # Fast, tool-free path (see app.agent.groq_client) for requests
            # classify_request judged answerable from general knowledge alone.
            # Skips _reflect deliberately — reflection's Claude critique call
            # would erase most of the latency win this path exists for, and
            # these requests carry no business-data risk a critique would
            # meaningfully catch. Any Groq failure (no key, outage, quota)
            # falls through to the unchanged Claude 'simple' path below
            # rather than surfacing an error.
            try:
                output_items = groq_client.call(
                    state_input["messages"],
                    on_event=on_event,
                    system_prompt=state_input.get("system_prompt"),
                    cancel_event=cancel_event,
                    organization_id=state_input.get("organization_id"),
                    user_id=state_input.get("user_id", ""),
                    conversation_id=state_input.get("conversation_id", ""),
                    request_id=state_input.get("request_id", ""),
                )
                return {"messages": output_items, "tools_used": []}
            except Exception:
                pass

        assignments = [a for a in plan.get("assignments", []) if a.get("agent") in SPECIALISTS][:MAX_ASSIGNMENTS]
        if plan.get("mode") != "delegate" or not assignments:
            result = get_graph().invoke(state_input)
            return _attach_suggestions(state_input, _reflect(state_input, result["messages"], result.get("tools_used", [])))

        if on_event:
            on_event({"type": "plan", "agents": [a["agent"] for a in assignments]})

        with ThreadPoolExecutor(max_workers=len(assignments)) as executor:
            futures = [
                executor.submit(
                    _run_specialist,
                    a["agent"],
                    a["task"],
                    state_input["messages"],
                    state_input["user_id"],
                    state_input.get("organization_id"),
                    state_input["conversation_id"],
                    cancel_event,
                    state_input.get("request_id", ""),
                )
                for a in assignments
            ]
            findings = [future.result() for future in futures]

        for finding in findings:
            if on_event:
                on_event({"type": "agent_done", "agent": finding["agent"]})

        findings_text = "\n\n".join(f"[{f['agent']} agent — task: {f['task']}]\n{f['output']}" for f in findings)
        synthesis_input = state_input["messages"] + [
            {
                "role": "user",
                "content": f"Sub-agent findings:\n\n{findings_text}\n\nSynthesize these into your final response.",
            }
        ]
        system_prompt = (state_input.get("system_prompt") or SYSTEM_PROMPT) + SYNTHESIS_PROMPT_SUFFIX
        output_items = anthropic_client.call(
            synthesis_input,
            on_event=on_event,
            system_prompt=system_prompt,
            tools=[],
            cancel_event=cancel_event,
            organization_id=state_input.get("organization_id"),
            user_id=state_input.get("user_id", ""),
            conversation_id=state_input.get("conversation_id", ""),
            request_id=state_input.get("request_id", ""),
        )
        tools_used = [tool for f in findings for tool in f["tools_used"]]

        return _attach_suggestions(state_input, _reflect(state_input, output_items, tools_used))
    finally:
        if conversation_id:
            cancellation.finish(conversation_id)

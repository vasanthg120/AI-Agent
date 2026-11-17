from app.prompts.registry import render

# Sourced from the centralized prompt registry (app.prompts.definitions) —
# same content as before, just no longer defined inline here. Kept as a
# module-level constant since app.agent.anthropic_client, app.agent.crew_reports,
# and others already import SYSTEM_PROMPT by name; only its definition moved.
SYSTEM_PROMPT = render("base_system")


def call_llm(
    input_items: list[dict],
    provider: str = "anthropic",
    on_event=None,
    system_prompt: str | None = None,
    tools: list[dict] | None = None,
    cancel_event=None,
    *,
    model: str | None = None,
    organization_id: str | None = None,
    user_id: str = "",
    conversation_id: str = "",
    request_id: str = "",
    agent_instance_id: str | None = None,
    parent_agent_id: str | None = None,
    delegation_depth: int | None = None,
) -> tuple[list[dict], str]:
    """Returns (output_items, provider_actually_used). This app's main
    planner/tool-calling graph is Anthropic-only regardless of `provider` —
    see app.agent.router.choose_provider's docstring for why: any turn
    reaching this function might need to call a tool, and
    app.agent.groq_client's integration has no tool-calling support at all.
    Groq is only ever used via app.agent.orchestrator's separate 'general'
    classification bypass, which never calls this function. `model` (an
    Anthropic model id) is the real per-turn lever here — see
    app.agent.router.choose_model.
    """
    from app.agent import anthropic_client  # lazy: avoids a circular import (anthropic_client imports SYSTEM_PROMPT from here)

    return anthropic_client.call(
        input_items,
        on_event=on_event,
        system_prompt=system_prompt,
        tools=tools,
        cancel_event=cancel_event,
        model=model,
        organization_id=organization_id,
        user_id=user_id,
        conversation_id=conversation_id,
        request_id=request_id,
        agent_instance_id=agent_instance_id,
        parent_agent_id=parent_agent_id,
        delegation_depth=delegation_depth,
    ), "anthropic"

"""Write-action lockdown for dynamically-created sub-agents (Phase 2.5,
Sub-step A of the approved plan).

Why this exists: several tools already have a "preview-then-confirm" gate
(call once without `confirmed` to preview, once more with `confirmed=true`
to actually commit — see app.tools.crm_write_tool/gorilladash_action_tool/
zapier_tool) that relies on a HUMAN seeing the preview in the chat turn and
replying next turn to confirm. A dynamically-delegated sub-agent has no such
turn — it runs one-shot inside master_agent._execute_leaf with nobody in
that loop — so the model alone deciding to pass confirmed=true is not a
real approval. Separately, a few tools (send_email, send_whatsapp_message,
calendar_tool's schedule_meeting, integration_execute) have NO confirmation
gate of any kind — a pre-existing, system-wide gap that also affects the
main single-agent chat path and is explicitly NOT fixed here (a bigger,
separate decision); for dynamic agents specifically, this module blocks
them outright instead.

Verified directly against every tool module in app/tools/ (not guessed) —
see the Phase 2.5 plan's Sub-step A for the inventory. Everything not
listed below (CRM/calendar/email/document lookups, search, memory, etc.)
is read-only and unrestricted.

Only ever consulted when context.get("agent_instance_id") is set (see
app.tools.registry.execute_tool) — the main single-agent chat path's
behavior is completely untouched.
"""

# Always refused outright for a dynamic agent — no confirmation flag exists
# to downgrade these to a safe preview (they commit unconditionally), and
# unlike the CRM write below, there's no separate read-only action to keep
# allowed. integration_execute can reach an arbitrary POST/PUT/PATCH on any
# connected integration depending on that org's own capability catalog, not
# knowable safely from this module alone — blocked entirely rather than
# guessed at.
_ALWAYS_BLOCKED_TOOLS = {"send_email", "send_whatsapp_message", "integration_execute"}

# A specific action within an otherwise read-only/allowed tool that itself
# commits unconditionally (no confirmed flag) — only that action is
# refused, the tool's other actions stay allowed.
_BLOCKED_ACTIONS = {
    "crm_contact": {"upsert"},
    "calendar_tool": {"schedule_meeting"},
}

# These tools already refuse to commit unless tool_input["confirmed"] is
# True (see each module's own SPEC) — forcing it to False here means a
# dynamic agent can still get the same preview text a normal chat turn
# would, it just can never actually complete the action, regardless of
# what the model itself decided to pass.
_FORCE_PREVIEW_TOOLS = {"crm_create_task", "gorilladash_action", "zapier"}


def check(name: str, tool_input: dict) -> tuple[dict | None, str | None]:
    """Returns (safe_tool_input, None) if the call may proceed (with
    `confirmed` forced to False for the preview-gated tools above), or
    (None, reason) if it must be refused outright, before the real tool
    handler is ever reached."""
    if name in _ALWAYS_BLOCKED_TOOLS:
        return None, "this action has no safe preview mode for an autonomous sub-agent — a human must perform it directly"

    blocked_actions = _BLOCKED_ACTIONS.get(name)
    if blocked_actions and tool_input.get("action") in blocked_actions:
        return None, f"the '{tool_input.get('action')}' action has no safe preview mode for an autonomous sub-agent"

    if name in _FORCE_PREVIEW_TOOLS and tool_input.get("confirmed"):
        return {**tool_input, "confirmed": False}, None

    return tool_input, None

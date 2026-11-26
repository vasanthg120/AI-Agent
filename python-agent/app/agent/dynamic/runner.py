"""Entry point for the dynamic recursive multi-agent system — the ONLY way
anything outside app.agent.dynamic may reach it.

Two independent gates, both required (production rollout, built on top of
Phase 2/3):

1. ENABLED — a deployment-wide kill switch from DYNAMIC_AGENTS_ENABLED
   (default off), checked directly here rather than added to the shared
   app.config.Settings class, to keep this feature's blast radius to this
   one module — mirrors app.observability.tracing's own
   OTEL_EXPORTER_OTLP_ENDPOINT presence-check shape (finding #7 of the
   approved plan): absent/falsy means zero behavioral change anywhere, for
   every organization, regardless of their own setting below.
2. org_limits.is_org_enabled(organization_id) — the per-organization
   rollout gate (Organization.dynamicAgentsSettings.enabled, set via PUT
   /organizations/dynamic-agents-settings, owner/admin only). Opt-in, not
   opt-out: a real production rollout can enable ENABLED platform-wide and
   still have every organization stay off until each one is individually
   turned on — a genuine staged/pilot rollout, not an all-or-nothing flag.

Reached from live chat traffic via
app.agent.orchestrator._run_dynamic_delegation (Phase 3) for
'delegate'-classified requests, as well as from this module's own tests.
"""

import os

from app.agent.dynamic import master_agent, org_limits

ENABLED = os.environ.get("DYNAMIC_AGENTS_ENABLED", "").strip().lower() in ("1", "true", "yes")


class DynamicAgentsDisabledError(RuntimeError):
    pass


def run(
    task_description: str,
    *,
    organization_id: str | None = None,
    user_id: str = "",
    conversation_id: str = "",
    request_id: str = "",
    base_messages: list[dict] | None = None,
    cancel_event=None,
    on_event=None,
    parent_allowed_tools: list[str] | None = None,
    system_prompt: str | None = None,
    model_tier: str | None = None,
) -> dict:
    if not ENABLED:
        raise DynamicAgentsDisabledError(
            "Dynamic agents are disabled platform-wide (set DYNAMIC_AGENTS_ENABLED=true to enable this capability at all)."
        )
    if not org_limits.is_org_enabled(organization_id):
        raise DynamicAgentsDisabledError(
            "Dynamic agents are not enabled for this organization "
            "(PUT /organizations/dynamic-agents-settings with {enabled: true}, owner/admin only)."
        )
    return master_agent.run_task(
        task_description,
        organization_id=organization_id,
        user_id=user_id,
        conversation_id=conversation_id,
        request_id=request_id,
        base_messages=base_messages,
        cancel_event=cancel_event,
        on_event=on_event,
        parent_allowed_tools=parent_allowed_tools,
        system_prompt=system_prompt,
        model_tier=model_tier,
    )

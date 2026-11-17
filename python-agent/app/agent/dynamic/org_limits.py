"""Per-organization overrides of the Phase 2 safety limits (limits.py's own
global, env-only defaults) — Phase 4 of the approved plan.

Reads Organization.dynamicAgentsSettings
(backend/src/organizations/schemas/organization.schema.ts), written via
PUT /organizations/dynamic-agents-settings (owner/admin only, see
backend/src/organizations/organizations.controller.ts), with the SAME
per-key dict + time.monotonic() TTL-freshness-check caching shape
app.core.langfuse_config already established for its own Mongo-backed
config — just keyed by organization_id instead of a single global slot,
since there are many organizations to cache independently.

Every resolved value is clamped to limits.py's own platform ceiling (an
organization can only ever TIGHTEN these, never loosen past what the
platform allows) — enforced here as the real authority. The DTO-level
bounds on the NestJS side (update-dynamic-agents-settings.dto.ts) are only
sanity bounds on the input form; this module must never trust a stale or
directly-written-to-Mongo value to actually be within the platform's
intended ceiling.
"""

import logging
import re
import threading
import time
from typing import NamedTuple

from bson import ObjectId

from app.agent.dynamic import limits
from app.memory.mongo_client import get_db

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 60
_OBJECT_ID_RE = re.compile(r"^[0-9a-fA-F]{24}$")
_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}


def _load(organization_id: str) -> dict:
    # A non-ObjectId-shaped id (a test fixture, an internal/system caller
    # that doesn't correspond to a real tenant) always means "no override" —
    # checked up front rather than relying on the except below, so this
    # never even attempts a Mongo round-trip for those callers.
    if not _OBJECT_ID_RE.match(organization_id):
        return {}
    try:
        doc = get_db().organizations.find_one({"_id": ObjectId(organization_id)}, {"dynamicAgentsSettings": 1})
    except Exception:
        logger.exception(
            "Failed to resolve per-organization dynamic-agent limits for %s; using platform defaults", organization_id
        )
        return {}
    return (doc or {}).get("dynamicAgentsSettings") or {}


def _resolve_overrides(organization_id: str | None) -> dict:
    if not organization_id:
        return {}
    with _lock:
        cached = _cache.get(organization_id)
    if cached is not None and time.monotonic() - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]

    overrides = _load(organization_id)
    with _lock:
        _cache[organization_id] = (time.monotonic(), overrides)
    return overrides


def _clamp(value, ceiling, min_value):
    """An override may only tighten the platform ceiling, never loosen past
    it — an invalid, missing, or out-of-range value silently falls back to
    the ceiling itself rather than being treated as an error. Preserves
    whatever numeric type the ceiling itself is (int for counts, float for
    max_cost_usd) — never forces an int cast, which would silently truncate
    a legitimate fractional cost ceiling."""
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < min_value:
        return ceiling
    return min(value, ceiling)


def is_org_enabled(organization_id: str | None) -> bool:
    """The per-organization rollout gate (production rollout) — required
    ALONGSIDE app.agent.dynamic.runner.ENABLED (the deployment-wide kill
    switch), not instead of it; see runner.run()'s own docstring. Opt-in,
    not opt-out: absent/false/missing organization_id all mean disabled, so
    every existing organization stays off until explicitly turned on via
    PUT /organizations/dynamic-agents-settings. Reuses resolve()'s own
    per-organization cache — no second Mongo round-trip for this."""
    overrides = _resolve_overrides(organization_id)
    return overrides.get("enabled") is True


class OrgDynamicAgentLimits(NamedTuple):
    """One organization's fully-resolved limits — the platform default from
    limits.py, each independently clamped down (never up) by whatever
    override that organization saved. A NamedTuple rather than a bare tuple
    specifically so a growing field list (Phase 2.5, Sub-step C added 5
    more) stays self-documenting at every call site via attribute access,
    not positional order."""

    max_depth: int
    max_agents_per_request: int
    max_execution_seconds: int
    max_retries: int
    max_model_calls: int
    max_tool_calls: int
    max_tokens: int
    max_cost_usd: float


def resolve(organization_id: str | None) -> OrgDynamicAgentLimits:
    """This organization's fully-resolved dynamic-agent limits. A missing
    organization_id (an internal/system caller, or one built before
    multi-tenancy) always gets the unmodified platform default for every
    field."""
    overrides = _resolve_overrides(organization_id)
    return OrgDynamicAgentLimits(
        # 0 is a legitimate, documented value for depth specifically — "this
        # agent only, never decomposes" (see app.config's own
        # dynamic_agents_max_depth comment) — unlike every other field here,
        # where 0 would mean "nothing may ever run at all" and is really
        # just an invalid input.
        max_depth=_clamp(overrides.get("maxDepth"), limits.MAX_DEPTH, min_value=0),
        max_agents_per_request=_clamp(overrides.get("maxAgentsPerRequest"), limits.MAX_AGENTS_PER_REQUEST, min_value=1),
        max_execution_seconds=_clamp(overrides.get("maxExecutionSeconds"), limits.MAX_EXECUTION_SECONDS, min_value=1),
        max_retries=_clamp(overrides.get("maxRetries"), limits.MAX_RETRIES, min_value=0),
        max_model_calls=_clamp(overrides.get("maxModelCalls"), limits.MAX_MODEL_CALLS, min_value=1),
        max_tool_calls=_clamp(overrides.get("maxToolCalls"), limits.MAX_TOOL_CALLS, min_value=1),
        max_tokens=_clamp(overrides.get("maxTokens"), limits.MAX_TOKENS, min_value=1),
        max_cost_usd=_clamp(overrides.get("maxCostUsd"), limits.MAX_COST_USD, min_value=0.01),
    )

"""Running token/cost usage for one request's whole dynamic-agent tree
(Phase 2.5, Sub-step C).

Reuses Phase 4's own persisted agent_executions rows (every call this
request's tree has made already carries the SAME requestId — see
master_agent._execute_leaf's state dict and
anthropic_client.plan_dynamic_delegation's own traced_llm_call) rather than
adding new plumbing into the LLM call chain to track a running total in
memory. Mirrors backend/src/billing/reservation.service.ts's own
summarizeUsage() grouping shape — read-only and python-side here, since
this is a soft safety ceiling, not the real settlement (that's still
exactly-once in NestJS, untouched by this).
"""

from app.memory.mongo_client import get_db


def current_usage(request_id: str) -> tuple[int, float]:
    """(total_tokens, total_cost_usd) summed across every agent_executions
    row this request's tree has produced so far. Never raises — a Mongo
    hiccup here must not block the dynamic-agent tree itself; (0, 0.0)
    means "nothing measurable yet," the same honest default every other
    optional field in this feature uses, never fabricated."""
    if not request_id:
        return 0, 0.0
    try:
        rows = list(
            get_db().agent_executions.aggregate(
                [
                    {"$match": {"requestId": request_id, "kind": "llm"}},
                    {
                        "$group": {
                            "_id": None,
                            "tokens": {
                                "$sum": {
                                    "$add": [
                                        {"$ifNull": ["$inputTokens", 0]},
                                        {"$ifNull": ["$outputTokens", 0]},
                                    ]
                                }
                            },
                            "cost": {"$sum": {"$ifNull": ["$costUsd", 0]}},
                        }
                    },
                ]
            )
        )
    except Exception:
        return 0, 0.0
    if not rows:
        return 0, 0.0
    return int(rows[0].get("tokens") or 0), float(rows[0].get("cost") or 0.0)

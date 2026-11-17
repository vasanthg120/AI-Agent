"""A dynamic, recursive multi-agent system built natively on the Anthropic
SDK (see the plan's "Pivot" section — the `openai-agents` package was
rejected after it broke `app.mcp_server` via hard, zero-overlap dependency
conflicts with `instructor`/`fastapi`).

Reachable only via `runner.run()`, which itself is gated behind the
`DYNAMIC_AGENTS_ENABLED` env flag (default off). `app.agent.orchestrator`'s
`delegate`-mode classification calls into it (Phase 3) via
`_run_dynamic_delegation`, falling straight back to the fixed-specialist
path on any failure, including the flag being off.
"""

import { IsBoolean, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

// Sanity bounds on the INPUT only — not the real safety ceiling, which is
// python-agent's own DYNAMIC_AGENTS_MAX_* env config (see
// python-agent/app/agent/dynamic/org_limits.py's own comment: an org can
// only ever tighten the platform default, never loosen past it, enforced
// there as the real authority). These just keep a nonsensical value
// (negative, zero, absurdly large) out of the database at all.
export class UpdateDynamicAgentsSettingsDto {
  // The per-organization rollout gate (python-agent's app/agent/dynamic/
  // runner.py requires BOTH this AND the deployment-wide
  // DYNAMIC_AGENTS_ENABLED env flag — a per-org opt-in layered on top of an
  // ops-level kill switch, so a platform-wide rollout can start with one
  // real organization before going global). Absent/false means off —
  // deliberately opt-in, not opt-out, for a capability this new.
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  // 0 is a legitimate, documented value here specifically — "this agent
  // only, never decomposes" (see python-agent's app/config.py's own
  // dynamic_agents_max_depth comment) — unlike the two fields below, where
  // 0 would mean "nothing may ever run at all" and is really just invalid.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  maxDepth?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxAgentsPerRequest?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(600)
  maxExecutionSeconds?: number;

  // 0 is legitimate here too — "never retry a transient failure" (see
  // python-agent's master_agent._execute_leaf_with_retry) — unlike the
  // three fields below, where 0 would mean "nothing may ever run at all."
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  maxRetries?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  maxModelCalls?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  maxToolCalls?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(5_000_000)
  maxTokens?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100)
  maxCostUsd?: number;
}

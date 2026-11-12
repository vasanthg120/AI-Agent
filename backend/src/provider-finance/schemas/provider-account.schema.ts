import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProviderAccountDocument = ProviderAccount & Document;

// Platform-wide, one document per LLM provider (Anthropic, Groq today) —
// same "no organizationId, this is Haive's own spend, not a customer's"
// shape as IntegrationCredential's platform rows.
//
// Verified live (official docs + the installed anthropic/groq SDK source,
// not assumed): neither Anthropic nor Groq expose ANY API for balance,
// invoice history, or auto-recharge — all three are Console-UI-only for
// both providers. A manual "confirmed balance" reconciliation used to live
// here as the only honest number available; per explicit product decision,
// that has been removed entirely rather than kept as a required manual
// workflow — balance is now surfaced as an honest capability status
// ('unsupported' for both real providers today), never a typed-in guess.
//
// What IS real and automatable: Anthropic's Usage and Cost Admin API
// (`/v1/organizations/usage_report/messages`, `/v1/organizations/cost_report`)
// and Rate Limits API (`/v1/organizations/rate_limits`) — both require a
// separate Admin API key (adminApiKeyEncrypted below), distinct from the
// normal platform apiKey IntegrationCredential already stores for making
// chat completions. Groq has no equivalent API at all. See
// provider-finance.service.ts / adapters/*.ts for how this drives the
// capability matrix the dashboard renders.
@Schema({ collection: 'provider_accounts', timestamps: true })
export class ProviderAccount {
  @Prop({ required: true, unique: true })
  provider: string;

  // Admin-entered, informational only (e.g. the org id shown in the
  // provider's own console) — never used to call an API with.
  @Prop()
  accountIdentifier?: string;

  // 'unknown' until an admin sets it up; 'exhausted' is set either by an
  // admin directly or automatically from a confirmed billing/quota-exceeded
  // error the provider actually returned (python-agent's
  // provider_account_status.mark_exhausted(), driven by tracing.py's
  // confirmed-signal detection) — never from a stale/guessed balance number.
  @Prop({ enum: ['active', 'degraded', 'exhausted', 'unknown'], default: 'unknown' })
  status: 'active' | 'degraded' | 'exhausted' | 'unknown';

  // Admin-selected, purely descriptive (Groq really is postpaid; Anthropic's
  // prepaid credit has no balance API, hence 'balance-unavailable') — never
  // drives any computation.
  @Prop({ enum: ['prepaid', 'postpaid', 'usage-limited', 'balance-unavailable'], default: 'balance-unavailable' })
  accountType: 'prepaid' | 'postpaid' | 'usage-limited' | 'balance-unavailable';

  @Prop({ default: 'USD' })
  currency: string;

  // Admin-set spending target — compared against Haive's own real,
  // automatically-tracked consumption-to-date (agent_executions) for
  // budget-pace alerts. Never a provider-confirmed figure, but never
  // fabricated either: both sides of the comparison are real numbers.
  @Prop()
  monthlyBudget?: number;

  // Anthropic's separate "Admin API key" (console.anthropic.com -> Settings
  // -> Admin keys) — required for the Usage/Cost Admin API and Rate Limits
  // API; a normal platform apiKey (IntegrationCredential) cannot call either.
  // Absent means those capabilities read as CONFIGURATION_REQUIRED, never
  // silently skipped. Unused by Groq (no equivalent API exists at all).
  @Prop()
  adminApiKeyEncrypted?: string;

  // Dedup state for the status-transition alert (fires only when `status`
  // actually changes to/from 'exhausted', never re-fires every cron tick).
  @Prop({ type: String, enum: ['active', 'degraded', 'exhausted', 'unknown'] })
  lastAlertedStatus?: 'active' | 'degraded' | 'exhausted' | 'unknown' | null;

  // Dedup state for the budget-pace alert tiers (50/80/100% of
  // monthlyBudget consumed this month) — same "only fire on a NEW, worse
  // crossing" rule the old balance-threshold alert used, just against a
  // real, admin-set budget instead of a derived balance.
  @Prop({ type: Number })
  lastAlertedBudgetPct?: number | null;

  // Usage-cost sync health (Anthropic only today — see
  // AnthropicFinanceAdapter.syncUsageCost) — surfaced on the dashboard and
  // drives the sync-failed/sync-recovered alert pair. lastUsageCostSyncAt is
  // the last SUCCESSFUL sync specifically; lastUsageCostSyncAttemptedAt is
  // updated on every attempt (success or failure) — kept as two separate
  // fields so "last successful" and "last attempted" are never conflated
  // (an admin needs to tell "it's working, just hasn't run recently" apart
  // from "it's been failing for hours").
  @Prop()
  lastUsageCostSyncAt?: Date;

  @Prop()
  lastUsageCostSyncAttemptedAt?: Date;

  @Prop({ type: String })
  lastUsageCostSyncError?: string | null;

  // The provider's OWN reported cost for the current month, once a real
  // usage-cost sync has run — compared against Haive's own agent_executions
  // cost tracking for the cost-variance alert. Null until a sync succeeds.
  @Prop({ type: Number })
  lastProviderReportedCostThisMonth?: number | null;

  // Dedup state for the usage-cost-sync-failed/recovered alert pair —
  // separate from lastAlertedStatus (that one tracks provider exhaustion,
  // a different condition entirely).
  @Prop({ default: false })
  lastAlertedSyncFailing: boolean;

  // Empty/absent means "every active platform_admins row" (resolved at
  // send time, never cached here) — set only to narrow to specific people.
  @Prop({ type: [String], default: [] })
  alertRecipients: string[];
}

export const ProviderAccountSchema = SchemaFactory.createForClass(ProviderAccount);

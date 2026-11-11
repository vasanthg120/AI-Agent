import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProviderAccountDocument = ProviderAccount & Document;

// Platform-wide, one document per LLM provider (Anthropic, Groq today) —
// same "no organizationId, this is Haive's own spend, not a customer's"
// shape as IntegrationCredential's platform rows. Deliberately a NEW,
// dedicated schema rather than growing IntegrationCredential.budgetUsd/
// budgetPeriod further: that schema exists for connection credentials, and
// a confirmed-vs-estimated balance, payment-derived starting point,
// reconciliation history, and alert thresholds don't belong bolted onto a
// credential-storage row (see that schema's own budgetUsd comment, which
// already carries exactly the honesty rule this schema generalizes:
// "NOT an authoritative balance from the provider... never claimed as
// provider truth").
//
// Neither Anthropic nor Groq expose a real balance-check API (verified live
// via web search, not assumed — Anthropic has no GET endpoint for remaining
// prepaid credit; Groq's own community asks for a billing API are still
// open) — so confirmedBalance is ONLY ever set by an admin's manual
// reconciliation (provider-finance.service.ts's recordReconciliation), never
// computed or auto-synced. "Estimated balance" (confirmedBalance minus
// tracked consumption since lastReconciledAt) is always derived at read
// time by provider-finance.service.ts, never stored here, so it can never
// drift out of sync with agent_executions.
@Schema({ collection: 'provider_accounts', timestamps: true })
export class ProviderAccount {
  @Prop({ required: true, unique: true })
  provider: string;

  // Admin-entered, informational only (e.g. the org id shown in the
  // provider's own console) — never used to call an API with.
  @Prop()
  accountIdentifier?: string;

  // 'unknown' until an admin sets it up; 'exhausted' is set either by an
  // admin directly or (Phase C) automatically from a confirmed
  // billing/quota-exceeded error the provider actually returned — never
  // from a stale/guessed balance number ("never treat an unknown or stale
  // balance as confirmed zero").
  @Prop({ enum: ['active', 'degraded', 'exhausted', 'unknown'], default: 'unknown' })
  status: 'active' | 'degraded' | 'exhausted' | 'unknown';

  // Admin-selected, honest about what kind of account this really is.
  // Anthropic/Groq both start as 'balance-unavailable' per this module's
  // own audit (see this file's leading comment) — an admin can change this
  // later if either provider ever ships a real balance API.
  @Prop({ enum: ['prepaid', 'postpaid', 'usage-limited', 'balance-unavailable'], default: 'balance-unavailable' })
  accountType: 'prepaid' | 'postpaid' | 'usage-limited' | 'balance-unavailable';

  @Prop({ default: 'USD' })
  currency: string;

  // Set only by recordReconciliation() — the one moment this module treats
  // a balance number as confirmed. Absent means "never reconciled," which
  // the dashboard shows honestly rather than defaulting to 0.
  @Prop()
  confirmedBalance?: number;

  @Prop()
  lastReconciledAt?: Date;

  @Prop()
  lastReconciledByAdminId?: string;

  @Prop()
  monthlyBudget?: number;

  // Spec defaults (50/25/10/0 informational->low->critical->exhausted) —
  // this schema stores the two admin-overridable boundaries; 50%/0% are
  // fixed semantic endpoints (healthy / exhausted), not configurable
  // thresholds of their own.
  @Prop({ default: 25 })
  lowThresholdPct: number;

  @Prop({ default: 10 })
  criticalThresholdPct: number;

  // Phase B uses this — what happens when estimatedBalance hits 0 (or a
  // confirmed exhausted status arrives): alert only, or also mark the
  // provider unavailable for routing (Phase C reads this).
  @Prop({ enum: ['alert-only', 'mark-unavailable'], default: 'alert-only' })
  zeroBalanceAction: 'alert-only' | 'mark-unavailable';

  // Empty/absent means "every active platform_admins row" (resolved at
  // send time, never cached here) — set only to narrow to specific people.
  @Prop({ type: [String], default: [] })
  alertRecipients: string[];

  // Phase B's dedup state — which threshold (if any) the last alert was
  // for, so a balance sitting at 8% doesn't re-fire "critical" every single
  // hourly tick. Reset to null by a reconciliation/payment that brings the
  // estimated balance back above it (see provider-alert.service.ts, Phase B).
  @Prop({ type: Number })
  lastAlertedThresholdPct?: number | null;
}

export const ProviderAccountSchema = SchemaFactory.createForClass(ProviderAccount);

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AgentExecutionDocument = AgentExecution & Document<Types.ObjectId>;

// Read-only from the NestJS side — python-agent is the sole writer (see
// python-agent/app/observability/execution_store.py), persisting what
// app/observability/tracing.py's traced_llm_call/traced_tool_call already
// compute. Field names are camelCase to match python-agent's writes, which
// deliberately mirror this database's existing convention (Conversation,
// DailyReport, TimelineEvent, ...) rather than Python's native snake_case.
// Nothing here is `required` at the Mongoose level — this schema exists for
// typed queries, not to validate documents this app never creates.
//
// Deliberately does NOT carry customerCharge/haiveCreditsUsed: this
// collection is python-agent's raw provider-cost trace (one row per LLM/
// tool call, priced before any margin is applied), not the customer-facing
// charge. That already lives, per settled chat turn, in WalletTransaction's
// AI_USAGE rows (amountCredits IS haiveCreditsUsed; metadata.providerCostUsd
// is the cost this row's costUsd rolls up from) — duplicating it here would
// denormalize billing detail backward into an internal accounting
// collection, which the original design explicitly avoids.
@Schema({ collection: 'agent_executions', timestamps: true })
export class AgentExecution {
  @Prop({ index: true })
  organizationId?: string;

  @Prop({ index: true })
  userId?: string;

  @Prop({ index: true })
  conversationId?: string;

  // Correlates every LLM call made during one chat turn back to the billing
  // reservation that pre-authorized it (see billing/reservation.service.ts)
  // — python-agent mints this once per turn (routes/chat.py) and threads it
  // through every traced_llm_call site touched. Settlement sums this
  // collection's rows by requestId; nothing billing-derived (credits
  // charged, margin) is ever written back onto this schema — this remains
  // python-agent's exclusive internal-accounting write, billing detail
  // lives in wallet_transactions instead.
  @Prop({ index: true })
  requestId?: string;

  @Prop({ enum: ['llm', 'tool'], index: true })
  kind: 'llm' | 'tool';

  @Prop()
  name: string;

  @Prop({ index: true })
  provider?: 'anthropic' | 'groq';

  @Prop()
  model?: string;

  @Prop()
  inputTokens?: number;

  @Prop()
  outputTokens?: number;

  // Anthropic prompt-cache write/read tokens — reported separately by the
  // provider and NOT already included in inputTokens/totalTokens (see
  // python-agent/app/observability/cost.py's docstring). Undefined on rows
  // written before this field existed, and always 0 (not undefined) for
  // providers/calls that don't use prompt caching.
  @Prop()
  cacheCreationInputTokens?: number;

  @Prop()
  cacheReadInputTokens?: number;

  // Always inputTokens + outputTokens when both are present — stored
  // directly (not a virtual) so it's queryable/aggregatable without a
  // pipeline stage recomputing it on every read.
  @Prop()
  totalTokens?: number;

  @Prop({ type: Number })
  costUsd?: number | null;

  // This collection's cost is always USD (python-agent's provider-cost
  // accounting never converts currency) — stored explicitly rather than
  // left implicit, so a reader never has to assume it.
  @Prop({ default: 'USD' })
  currency: string;

  @Prop()
  latencyMs: number;

  @Prop()
  success: boolean;

  @Prop()
  error?: string;

  @Prop({ index: true })
  occurredAt: Date;
}

export const AgentExecutionSchema = SchemaFactory.createForClass(AgentExecution);
AgentExecutionSchema.index({ organizationId: 1, occurredAt: -1 });

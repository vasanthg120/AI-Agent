import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { AgentExecution, AgentExecutionDocument } from '../command-center/schemas/agent-execution.schema';
import { UsageAggregationCursor, UsageAggregationCursorDocument } from './schemas/usage-aggregation-cursor.schema';
import { UsageRecord, UsageRecordDocument } from './schemas/usage-record.schema';

// The single feature bucket every aggregated row lands under today — see
// usage-record.schema.ts's scoping note for why.
export const AI_USAGE_FEATURE_KEY = 'ai_usage';

/**
 * Rolls the existing agent_executions collection (python-agent's raw
 * per-LLM-call trace — see command-center/schemas/agent-execution.schema.ts)
 * up into per-org/per-day UsageRecord buckets. Read-only against
 * agent_executions; zero python-agent changes needed. Entirely independent
 * of the wallet/reservation billing gate — this is Phase 0's new read-side
 * foundation only (see entitlements.service.ts), not wired into any
 * enforcement path.
 */
@Injectable()
export class EntitlementsUsageAggregationService {
  private readonly logger = new Logger(EntitlementsUsageAggregationService.name);

  constructor(
    @InjectModel(AgentExecution.name) private executionModel: Model<AgentExecutionDocument>,
    @InjectModel(UsageRecord.name) private usageModel: Model<UsageRecordDocument>,
    @InjectModel(UsageAggregationCursor.name) private cursorModel: Model<UsageAggregationCursorDocument>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async aggregatePending(): Promise<void> {
    try {
      const processed = await this.run();
      if (processed > 0) this.logger.log(`Aggregated ${processed} agent_executions row(s) into usage_records.`);
    } catch (err) {
      this.logger.error(`Usage aggregation run failed: ${(err as Error).message}`);
    }
  }

  /** Exposed separately from the cron handler so tests (and a future manual
   * trigger) can run one batch synchronously without depending on schedule
   * timing. Idempotent: each agent_executions row is $inc'd into its
   * UsageRecord bucket exactly once, then the cursor advances past it — a
   * re-run after a partial failure just resumes from the last-committed id. */
  async run(batchSize = 2000): Promise<number> {
    const cursor = await this.cursorModel
      .findOneAndUpdate({ key: 'default' }, { $setOnInsert: { key: 'default' } }, { upsert: true, new: true })
      .exec();

    const query: FilterQuery<AgentExecutionDocument> = cursor.lastProcessedExecutionId
      ? { _id: { $gt: new Types.ObjectId(cursor.lastProcessedExecutionId) } }
      : {};
    const executions = await this.executionModel.find(query).sort({ _id: 1 }).limit(batchSize).exec();
    if (executions.length === 0) return 0;

    for (const execution of executions) {
      if (!execution.organizationId) continue; // nothing to bill against

      const occurredAt = execution.occurredAt ?? execution.get('createdAt') ?? new Date();
      const periodStart = new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate()));
      const periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000);
      const inputUnits = execution.inputTokens ?? 0;
      const outputUnits = execution.outputTokens ?? 0;
      const totalUnits = execution.totalTokens ?? inputUnits + outputUnits;
      const model = execution.model ?? null;

      await this.usageModel
        .updateOne(
          { organizationId: execution.organizationId, feature: AI_USAGE_FEATURE_KEY, model, periodStart },
          {
            $inc: { inputUnits, outputUnits, totalUnits },
            $setOnInsert: { organizationId: execution.organizationId, feature: AI_USAGE_FEATURE_KEY, model, periodStart, periodEnd },
          },
          { upsert: true },
        )
        .exec();
    }

    cursor.lastProcessedExecutionId = executions[executions.length - 1]._id.toString();
    await cursor.save();
    return executions.length;
  }
}

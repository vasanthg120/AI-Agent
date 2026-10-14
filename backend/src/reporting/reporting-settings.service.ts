import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

export const REPORTING_SETTINGS_COLLECTION = 'reporting_settings';

export interface ReportingSettings {
  /** The share of sales (excluding tax) the organization keeps as gross margin — its own estimate. Null until set. */
  grossMarginPct: number | null;
  updatedAt?: Date;
  updatedByName?: string;
}

// What an organization tells the reports once: today, the gross margin it
// works to. The CRM holds no cost for what is sold and nobody enters one, so
// the Gross Margin report applies this percentage to sales — and says it is
// an estimate. One document per organization.
@Injectable()
export class ReportingSettingsService {
  constructor(@InjectConnection() private connection: Connection) {}

  async get(organizationId: string): Promise<ReportingSettings> {
    const doc = await this.connection.collection(REPORTING_SETTINGS_COLLECTION).findOne({ organizationId });
    const pct = doc?.grossMarginPct;
    return {
      grossMarginPct: typeof pct === 'number' && Number.isFinite(pct) ? pct : null,
      updatedAt: doc?.updatedAt instanceof Date ? doc.updatedAt : undefined,
      updatedByName: typeof doc?.updatedByName === 'string' ? doc.updatedByName : undefined,
    };
  }

  /** `null` clears the percentage: the report goes back to saying none is set. */
  async setGrossMarginPct(organizationId: string, grossMarginPct: number | null, by: { id: string; name: string }): Promise<ReportingSettings> {
    const at = new Date();
    await this.connection.collection(REPORTING_SETTINGS_COLLECTION).updateOne(
      { organizationId },
      {
        $set: {
          grossMarginPct: grossMarginPct === null ? null : Math.round(grossMarginPct * 100) / 100,
          updatedAt: at,
          updatedBy: by.id,
          updatedByName: by.name,
        },
        $setOnInsert: { organizationId, createdAt: at },
      },
      { upsert: true },
    );
    return this.get(organizationId);
  }
}

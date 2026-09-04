import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BusinessHoursPolicy } from './email-sla-calculator.service';
import { BusinessHoursConfig, BusinessHoursConfigDocument } from './schemas/business-hours-config.schema';
import { EmailSlaPolicy, EmailSlaPolicyDocument, DEFAULT_PRIORITY_SLA_MINUTES } from './schemas/email-sla-policy.schema';

export const DEFAULT_BUSINESS_HOURS: BusinessHoursPolicy = {
  timezone: 'UTC',
  workingDays: [1, 2, 3, 4, 5],
  workingStartTime: '09:00',
  workingEndTime: '18:00',
  holidays: [],
};

export interface ResolvedSlaPolicy {
  firstResponseTimeMinutes: number;
  businessHoursEnabled: boolean;
}

/**
 * Resolves an org's configured (or safely-defaulted) SLA policy and
 * business-hours calendar, and provides admin CRUD for both. An org never
 * has to configure anything before SLA tracking works — every read here
 * falls back to a documented, safe default (spec's own requirement).
 */
@Injectable()
export class EmailSlaPolicyService {
  constructor(
    @InjectModel(EmailSlaPolicy.name) private policyModel: Model<EmailSlaPolicyDocument>,
    @InjectModel(BusinessHoursConfig.name) private hoursModel: Model<BusinessHoursConfigDocument>,
  ) {}

  async resolvePolicy(organizationId: string, priority: string): Promise<ResolvedSlaPolicy> {
    const row = await this.policyModel.findOne({ organizationId, priority, enabled: true }).exec();
    if (row) return { firstResponseTimeMinutes: row.firstResponseTimeMinutes, businessHoursEnabled: row.businessHoursEnabled };
    return {
      firstResponseTimeMinutes: DEFAULT_PRIORITY_SLA_MINUTES[priority] ?? DEFAULT_PRIORITY_SLA_MINUTES.medium,
      businessHoursEnabled: true,
    };
  }

  async resolveBusinessHours(organizationId: string): Promise<BusinessHoursPolicy> {
    const row = await this.hoursModel.findOne({ organizationId }).exec();
    if (!row) return DEFAULT_BUSINESS_HOURS;
    return { timezone: row.timezone, workingDays: row.workingDays, workingStartTime: row.workingStartTime, workingEndTime: row.workingEndTime, holidays: row.holidays };
  }

  listPolicies(organizationId: string) {
    return this.policyModel.find({ organizationId }).sort({ priority: 1 }).exec();
  }

  upsertPolicy(organizationId: string, priority: string, dto: { firstResponseTimeMinutes: number; businessHoursEnabled?: boolean; enabled?: boolean }) {
    return this.policyModel
      .findOneAndUpdate({ organizationId, priority }, { $set: { ...dto } }, { upsert: true, new: true })
      .exec();
  }

  async updatePolicy(organizationId: string, id: string, dto: Partial<{ firstResponseTimeMinutes: number; businessHoursEnabled: boolean; enabled: boolean }>) {
    const row = await this.policyModel.findOneAndUpdate({ _id: id, organizationId }, { $set: dto }, { new: true }).exec();
    if (!row) throw new NotFoundException('SLA policy not found.');
    return row;
  }

  getBusinessHoursConfig(organizationId: string) {
    return this.hoursModel.findOne({ organizationId }).exec();
  }

  upsertBusinessHoursConfig(organizationId: string, dto: Partial<BusinessHoursPolicy>) {
    return this.hoursModel
      .findOneAndUpdate({ organizationId }, { $set: dto }, { upsert: true, new: true })
      .exec();
  }
}

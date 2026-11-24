import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { validTimeZone } from '../common/business-day';
import { Organization, OrganizationDocument } from '../organizations/schemas/organization.schema';
import { AutomationConfig, AutomationConfigDocument } from './schemas/automation-config.schema';
import { AutomationConfigValues, DEFAULT_AUTOMATION_CONFIG } from './task-types';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const CHANNELS = ['gmail', 'outlook', 'smtp'];

/** Validates a partial update; throws BadRequestException naming the field. Pure so it is unit-tested directly. */
export function validateConfigPatch(patch: Partial<AutomationConfigValues>): Partial<AutomationConfigValues> {
  const out: Partial<AutomationConfigValues> = {};
  const int = (k: keyof AutomationConfigValues, min: number, max: number) => {
    const v = patch[k];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new BadRequestException(`${k} must be a whole number from ${min} to ${max}.`);
    (out as Record<string, unknown>)[k] = v;
  };
  if (patch.enabled !== undefined) out.enabled = !!patch.enabled;
  if (patch.sendToManager !== undefined) out.sendToManager = !!patch.sendToManager;
  if (patch.eodTime !== undefined) {
    if (!HHMM.test(patch.eodTime)) throw new BadRequestException('eodTime must be a 24-hour time like 18:00.');
    out.eodTime = patch.eodTime;
  }
  if (patch.timezone !== undefined) {
    if (patch.timezone && validTimeZone(patch.timezone) !== patch.timezone) throw new BadRequestException('timezone must be a valid IANA time zone, e.g. Asia/Kolkata.');
    out.timezone = patch.timezone;
  }
  for (const key of ['enabledSources', 'crmProviders'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim()) || v.length > 30) throw new BadRequestException(`${key} must be a list of names.`);
    out[key] = [...new Set(v.map((x) => x.trim().toLowerCase()))];
  }
  if (patch.deliveryChannels !== undefined) {
    const v = patch.deliveryChannels;
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => !CHANNELS.includes(x))) throw new BadRequestException('deliveryChannels must list gmail, outlook and/or smtp.');
    out.deliveryChannels = [...new Set(v)];
  }
  int('staleDealDays', 1, 365);
  int('dealCloseWindowDays', 0, 90);
  int('quoteDueWindowDays', 0, 90);
  int('emailLookbackDays', 1, 60);
  int('syncOnLoginMinIntervalMin', 0, 1440);
  int('maxDeliveryAttempts', 1, 10);
  return out;
}

export function mergeConfig(row: Partial<AutomationConfigValues> | null): AutomationConfigValues {
  const merged: Record<string, unknown> = { ...DEFAULT_AUTOMATION_CONFIG };
  if (row) {
    for (const key of Object.keys(DEFAULT_AUTOMATION_CONFIG)) {
      const v = (row as Record<string, unknown>)[key];
      if (v !== undefined && v !== null) merged[key] = v;
    }
  }
  return merged as unknown as AutomationConfigValues;
}

@Injectable()
export class AutomationConfigService {
  constructor(
    @InjectModel(AutomationConfig.name) private model: Model<AutomationConfigDocument>,
    @InjectModel(Organization.name) private orgs: Model<OrganizationDocument>,
  ) {}

  /** The zone the organization's business day and EOD time are read in: its automation setting, else the organization's own timezone, else the product default. */
  async effectiveTimezone(organizationId: string, cfg?: AutomationConfigValues): Promise<string> {
    const values = cfg ?? (await this.get(organizationId));
    if (values.timezone) return validTimeZone(values.timezone);
    const org = await this.orgs.findById(organizationId).select('timezone').lean().exec().catch(() => null);
    return validTimeZone((org as { timezone?: string } | null)?.timezone);
  }

  /** The organization's settings with defaults filled in. */
  async get(organizationId: string): Promise<AutomationConfigValues> {
    const row = await this.model.findOne({ organizationId }).lean().exec();
    return mergeConfig(row as Partial<AutomationConfigValues> | null);
  }

  async update(organizationId: string, patch: Partial<AutomationConfigValues>, actorId: string): Promise<AutomationConfigValues> {
    const clean = validateConfigPatch(patch);
    await this.model.findOneAndUpdate({ organizationId }, { $set: { ...clean, updatedBy: actorId } }, { upsert: true }).exec();
    return this.get(organizationId);
  }
}

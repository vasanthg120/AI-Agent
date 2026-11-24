import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { businessDayOf, nextDay, startOfBusinessDay } from '../../common/business-day';
import { AutomationConfigValues, SourceTask } from '../task-types';

export interface CollectContext {
  organizationId: string;
  /** Only this employee's work (login sync), or every employee of the organization when absent (scheduled sync). */
  userId?: string;
  now: Date;
  config: AutomationConfigValues;
  /** The organization's business timezone (IANA). Date-only deadlines and "today" are read in it. */
  timezone: string;
}

export interface CollectResult {
  /** Open work, plus recently closed work (so the sync can record completion with its evidence). */
  tasks: SourceTask[];
  /**
   * True when `tasks` is the complete set of open work in the requested scope.
   * Only then may the sync deactivate previously collected tasks that are absent.
   * An adapter that hit a limit or a partial read must say false.
   */
  complete: boolean;
  /** Assignments seen in the source that could not be tied to an employee (also recorded for admin resolution). */
  unresolved: number;
}

/**
 * A source of assigned work. Add GorillaDash or Calendar by implementing this
 * and registering it in WorkAutomationModule (see SOURCE_ADAPTERS) — nothing
 * else changes. An adapter must only return work whose assignee it has
 * verified, never one matched on a display name.
 */
export interface TaskSourceAdapter {
  /** Stable id used in the organization's enabledSources setting. */
  readonly id: string;
  readonly label: string;
  /** What this adapter reads and how ownership is verified (shown on the admin page). */
  readonly description: string;
  /** The sourceType values this adapter produces. A sync may only deactivate tasks of these types. */
  readonly sourceTypes: readonly string[];
  collect(ctx: CollectContext): Promise<CollectResult>;
}

export const SOURCE_ADAPTERS = 'WORK_AUTOMATION_SOURCE_ADAPTERS';

/** Read-only access to other modules' collections, so adapters never import (or risk cycles with) those modules. Replaceable in tests. */
export abstract class RecordReader {
  abstract find(collection: string, filter: Record<string, unknown>, opts?: { limit?: number; sort?: Record<string, 1 | -1> }): Promise<Record<string, any>[]>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

@Injectable()
export class MongoRecordReader extends RecordReader {
  constructor(@InjectConnection() private connection: Connection) {
    super();
  }

  async find(collection: string, filter: Record<string, unknown>, opts: { limit?: number; sort?: Record<string, 1 | -1> } = {}) {
    let cursor = this.connection.collection(collection).find(filter);
    if (opts.sort) cursor = cursor.sort(opts.sort);
    return (await cursor.limit(opts.limit ?? 1000).toArray()) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

export const MAX_SOURCE_ROWS = 1000;

/** Maps a CRM data-source provider id to the platform name shown to people. */
export function platformLabel(provider: string | undefined): string {
  if (!provider || provider === 'haive_native') return 'haive';
  if (provider === 'prospectconnect') return 'pantheras';
  return provider;
}

/** The last millisecond of the business day that `instant` falls on, in `timezone`. */
export function endOfBusinessDay(timezone: string, instant: Date): Date {
  return new Date(startOfBusinessDay(timezone, nextDay(businessDayOf(timezone, instant))).getTime() - 1);
}

/**
 * A date-only deadline ("2026-11-24", the CRMs' own format) as the last
 * millisecond of THAT calendar day in the organization's timezone — so it is
 * overdue only once that day has fully ended where the business is, not at
 * midnight UTC. Unparseable input gives undefined.
 */
export function dateOnlyDeadline(value: unknown, timezone: string): Date | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  const ymd = value.slice(0, 10);
  const d = new Date(startOfBusinessDay(timezone, nextDay(ymd)).getTime() - 1);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

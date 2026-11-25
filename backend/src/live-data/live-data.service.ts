import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CustomerDirectoryService } from '../customer-intelligence/customer-directory.service';
import { DataSourcesService } from '../data-sources/data-sources.service';
import { CRM_PROVIDERS, CrmProviderId } from '../data-sources/provider-catalog';
import { nextWindowOpening, SyncWindow } from '../data-sources/sync-window';
import { EmailIntelligenceSyncService } from '../email-intelligence/email-intelligence-sync.service';
import { TeamScopeService } from '../team-activity/team-scope.service';

// A source marked 'running' longer than this is a crashed read, not one in progress (python's
// _LIVE_RUNNING_STALE is the same 15 minutes).
const RUNNING_STALE_MS = 15 * 60_000;
// Asking python to start the reads is quick (it answers before reading); never hold a page on it.
const REFRESH_TIMEOUT_MS = 8_000;

/** One connected CRM, as a page's "live" line shows it. */
export interface LiveSource {
  id: string;
  label: string;
  provider: string;
  businessId: string;
  businessName: string;
  /** live: read whenever a page needs it. nightly: the CRM allows one read a night (Hoops). */
  mode: 'live' | 'nightly';
  /** When HaiVE last read it (null: never). */
  lastSyncAt: string | null;
  /** Being read right now. */
  refreshing: boolean;
  /** The last read failed: why, in words. */
  error?: string;
  /** Nightly only: when the next night's read starts. */
  nextNightlyAt?: string | null;
}

export interface LiveMailbox {
  connected: boolean;
  /** When new mail was last fetched from Outlook (null: never). */
  lastFetchedAt: string | null;
  fetching: boolean;
  /** Emails stored but not read by the AI yet. */
  awaitingAi: number;
  /** The AI is reading newly fetched mail right now. */
  aiReading: boolean;
}

export interface LiveStatus {
  checkedAt: string;
  sources: LiveSource[];
  mailbox?: LiveMailbox;
}

export type LiveScope = 'business' | 'all';

interface SourceRow {
  _id: { toString(): string };
  organizationId: string;
  provider: CrmProviderId;
  label: string;
  status?: string;
  sync?: { lastSyncAt?: Date; lastStatus?: string; lastError?: string; runningSince?: Date; window?: SyncWindow };
}

/**
 * Live source data (2026-11-25): pages show what the connected sources hold now, not what a
 * timer last copied. When a page opens it asks here; each live CRM is asked only for what
 * changed since HaiVE last looked (python crm_mongo_sync.refresh_org_live — in the background,
 * at most once a minute for a CRM that reports changes, every few minutes for one that must be
 * read whole), and the mailbox for new mail and replies (no AI). The page then watches
 * status() and reloads its figures the moment a read lands. Hoops is never read here: it
 * allows one read a night, so its lists say "updated nightly".
 */
@Injectable()
export class LiveDataService {
  private readonly logger = new Logger(LiveDataService.name);
  private readonly pythonAgentUrl: string;
  // Per business: the newest CRM read this process has seen. A newer one means new records
  // landed, so the in-memory copies built from the old ones are dropped.
  private readonly seen = new Map<string, number>();

  constructor(
    @InjectConnection() private connection: Connection,
    private http: HttpService,
    private jwt: JwtService,
    private scopes: TeamScopeService,
    private dataSources: DataSourcesService,
    private directory: CustomerDirectoryService,
    private mailSync: EmailIntelligenceSyncService,
    config: ConfigService,
  ) {
    this.pythonAgentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  /** The businesses a page covers: the one signed in to, or — for the Main Account owner's all-businesses views — every one. */
  private async businesses(caller: JwtPayload, scope: LiveScope): Promise<{ id: string; name: string }[]> {
    const resolved = await this.scopes.resolve(caller);
    const all = resolved.businesses.map((b) => ({ id: b.id, name: b.name }));
    if (scope === 'all' && resolved.acrossBusinesses) return all;
    return [all.find((b) => b.id === caller.organizationId) ?? { id: caller.organizationId, name: '' }];
  }

  /** A page opened: read what is stale, now, in the background — then say where each source stands. */
  async refresh(caller: JwtPayload, options: { scope?: LiveScope; email?: boolean; crm?: boolean } = {}): Promise<LiveStatus> {
    const businesses = await this.businesses(caller, options.scope ?? 'business');
    if (options.crm !== false) await Promise.all(businesses.map((b) => this.askPython(b.id)));
    // The mailbox is read in the background too; status() shows it as fetching meanwhile.
    if (options.email) {
      void this.mailSync.fetchLive(caller.sub).catch((err) => this.logger.warn(`Live mailbox fetch failed for user ${caller.sub}: ${(err as Error).message}`));
    }
    return this.statusOf(caller, businesses, !!options.email);
  }

  async status(caller: JwtPayload, options: { scope?: LiveScope; email?: boolean } = {}): Promise<LiveStatus> {
    return this.statusOf(caller, await this.businesses(caller, options.scope ?? 'business'), !!options.email);
  }

  private async askPython(organizationId: string): Promise<void> {
    const token = this.jwt.sign({ sub: 'system', organizationId }, { expiresIn: '2m' });
    try {
      await firstValueFrom(
        this.http.post(`${this.pythonAgentUrl}/sync/crm/refresh-live`, {}, { headers: { Authorization: `Bearer ${token}` }, timeout: REFRESH_TIMEOUT_MS }),
      );
    } catch (err) {
      // The page still shows the last read, with its time: never an error for the person.
      this.logger.warn(`Live CRM refresh for org ${organizationId} could not start: ${(err as Error).message}`);
    }
  }

  private async statusOf(caller: JwtPayload, businesses: { id: string; name: string }[], withMailbox: boolean, now = new Date()): Promise<LiveStatus> {
    const names = new Map(businesses.map((b) => [b.id, b.name]));
    const rows = await this.connection
      .collection<SourceRow>('crm_data_sources')
      .find({ organizationId: { $in: businesses.map((b) => b.id) }, status: 'active' }, { projection: { organizationId: 1, provider: 1, label: 1, status: 1, sync: 1 } })
      .sort({ createdAt: 1 })
      .toArray();
    const sources = rows.filter((r) => CRM_PROVIDERS[r.provider]?.syncSupported).map((r) => this.sourceOf(r, names.get(r.organizationId) ?? '', now));
    this.dropStaleCopies(rows);
    return {
      checkedAt: now.toISOString(),
      sources,
      ...(withMailbox ? { mailbox: await this.mailboxOf(caller.sub) } : {}),
    };
  }

  private sourceOf(row: SourceRow, businessName: string, now: Date): LiveSource {
    const sync = row.sync ?? {};
    const window = sync.window;
    const running = sync.lastStatus === 'running' && (!sync.runningSince || now.getTime() - new Date(sync.runningSince).getTime() < RUNNING_STALE_MS);
    return {
      id: row._id.toString(),
      label: row.label,
      provider: row.provider,
      businessId: row.organizationId,
      businessName,
      mode: window ? 'nightly' : 'live',
      lastSyncAt: sync.lastSyncAt ? new Date(sync.lastSyncAt).toISOString() : null,
      refreshing: running,
      ...(sync.lastStatus === 'error' && sync.lastError ? { error: sync.lastError } : {}),
      ...(window ? { nextNightlyAt: nextWindowOpening(window, now).toISOString() } : {}),
    };
  }

  // New records landed since this process last looked: what the Customers page and the
  // source list keep in memory was built from the old ones.
  private dropStaleCopies(rows: SourceRow[]): void {
    const newest = new Map<string, number>();
    for (const row of rows) {
      const at = row.sync?.lastSyncAt ? new Date(row.sync.lastSyncAt).getTime() : 0;
      newest.set(row.organizationId, Math.max(newest.get(row.organizationId) ?? 0, at));
    }
    for (const [organizationId, at] of newest) {
      const before = this.seen.get(organizationId);
      if (before !== undefined && at <= before) continue;
      // Also on the first look since this process started: a copy may predate it.
      this.seen.set(organizationId, at);
      this.directory.invalidate(organizationId);
      this.dataSources.forget(organizationId);
    }
  }

  private async mailboxOf(userId: string): Promise<LiveMailbox> {
    const [state, connection] = await Promise.all([
      this.mailSync.syncState(userId),
      this.connection.collection('outlook_connections').findOne({ userId, isActive: true }, { projection: { _id: 1 } }),
    ]);
    return {
      connected: !!connection,
      lastFetchedAt: state.lastSyncedAt ? new Date(state.lastSyncedAt).toISOString() : null,
      fetching: state.running,
      awaitingAi: state.awaitingAnalysis,
      aiReading: state.aiReading,
    };
  }
}

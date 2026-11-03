import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, isValidObjectId, Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { EncryptionService } from '../common/encryption/encryption.service';
import { CloudError } from './cloud-http';
import { CLOUD_PROVIDER_LABEL, CLOUD_PROVIDERS, CloudOwnership, CloudProvider, CloudProviderId } from './cloud-files.types';
import { GoogleDriveProvider } from './providers/google-drive.provider';
import { OneDriveProvider } from './providers/onedrive.provider';
import { CloudConnection, CloudConnectionDocument } from './schemas/cloud-connection.schema';
import { CloudFolderGrant, CloudFolderGrantDocument } from './schemas/cloud-folder-grant.schema';

// A token is refreshed this long before it runs out, so a call never starts with one about to expire.
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const STATE_PURPOSE = 'cloud_files';

/** What a signed OAuth `state` of this flow carries through the provider's sign-in. */
export interface CloudState {
  sub: string;
  organizationId: string;
  purpose: typeof STATE_PURPOSE;
  provider: CloudProviderId;
  ownership: CloudOwnership;
}

export interface CloudConnectionView {
  id: string;
  provider: CloudProviderId;
  ownership: CloudOwnership;
  accountEmail: string;
  accountName?: string;
  status: 'connected' | 'needs_reauth';
  connectedAt?: Date;
  /** Who connected the company account. */
  connectedBy?: string;
  /** What the account allowed HaiVE to do, in words. */
  permissions: string[];
  lastSyncAt?: Date;
  lastSyncStatus?: 'ok' | 'error';
  lastSyncError?: string;
  /** May the person asking disconnect it (and, for the company account, share its folders)? */
  canManage: boolean;
  /** Company account: how many of its folders the person asking can open (null: all of it). */
  sharedFolders?: number | null;
}

export interface CloudProviderOverview {
  id: CloudProviderId;
  label: string;
  /** Whether the platform has this provider's app keys; without them nobody can connect. */
  configured: boolean;
  mine: CloudConnectionView[];
  company: CloudConnectionView | null;
  /** Owners and admins connect (and replace) the company account. */
  canConnectCompany: boolean;
}

export const isOrgAdmin = (caller: Pick<JwtPayload, 'roles'>) => caller.roles.some((role) => role === 'owner' || role === 'admin');

// Connecting, keeping and disconnecting Google Drive / OneDrive accounts — the
// same OAuth shape as OutlookService and GmailService (signed-JWT state, code
// exchange, encrypted token upsert, needs_reauth), for both providers.
@Injectable()
export class CloudConnectionsService {
  private readonly logger = new Logger(CloudConnectionsService.name);
  private readonly providers: Record<CloudProviderId, CloudProvider>;
  // One refresh at a time per connection: concurrent calls wait for the same new token.
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    google: GoogleDriveProvider,
    onedrive: OneDriveProvider,
    @InjectModel(CloudConnection.name) private model: Model<CloudConnectionDocument>,
    @InjectModel(CloudFolderGrant.name) private grants: Model<CloudFolderGrantDocument>,
    @InjectConnection() private db: Connection,
    private encryption: EncryptionService,
    private jwt: JwtService,
    private config: ConfigService,
    private audit: AuditService,
  ) {
    this.providers = { google_drive: google, onedrive };
  }

  provider(id: string): CloudProvider {
    if (!(CLOUD_PROVIDERS as readonly string[]).includes(id)) throw new NotFoundException('HaiVE doesn’t connect to that file service.');
    return this.providers[id as CloudProviderId];
  }

  // ---- connecting --------------------------------------------------------------

  connectUrl(caller: JwtPayload, providerId: string, ownership: CloudOwnership): string {
    const provider = this.provider(providerId);
    if (!provider.configured())
      throw new CloudError('not_configured', `${CLOUD_PROVIDER_LABEL[provider.id]} isn’t set up for HaiVE yet. Ask your HaiVE administrator to add its app keys.`);
    if (ownership === 'company' && !isOrgAdmin(caller)) throw new ForbiddenException('Only an owner or admin can connect the company account.');
    const state: CloudState = { sub: caller.sub, organizationId: caller.organizationId, purpose: STATE_PURPOSE, provider: provider.id, ownership };
    // `purpose` makes the state useless as a bearer token (JwtStrategy refuses any token that has one).
    return provider.authorizeUrl(this.jwt.sign(state, { expiresIn: '10m' }));
  }

  /** The signed state of this flow, or null when `state` belongs to another one (Outlook shares its return address with OneDrive). */
  readState(state: string | undefined): CloudState | null {
    if (!state) return null;
    try {
      const payload = this.jwt.verify<CloudState>(state);
      return payload.purpose === STATE_PURPOSE && (CLOUD_PROVIDERS as readonly string[]).includes(payload.provider) ? payload : null;
    } catch {
      return null;
    }
  }

  /** The Integrations page, told how a sign-in went. */
  backTo(provider: CloudProviderId, result: string): string {
    return `${this.config.get<string>('corsOrigin')}/integrations?cloud=${provider}&result=${result}`;
  }

  /** Finishes a sign-in and says where to send the browser: back to the Integrations page with the outcome. */
  async finish(state: CloudState, code?: string, error?: string, errorDescription?: string): Promise<string> {
    const back = (result: string) => this.backTo(state.provider, result);
    if (error || !code) {
      this.logger.warn(`${state.provider} sign-in ended without a code (error=${error}, description=${errorDescription})`);
      if (/AADSTS90094|admin approval|admin consent/i.test(errorDescription ?? '')) return back('admin_consent_required');
      return back(error === 'access_denied' ? 'cancelled' : 'error');
    }
    try {
      await this.complete(state, code);
      return back('connected');
    } catch (err) {
      this.logger.error(`${state.provider} connection failed: ${(err as CloudError).detail ?? (err as Error).message}`);
      return back(err instanceof ForbiddenException ? 'forbidden' : 'error');
    }
  }

  private async complete(state: CloudState, code: string): Promise<void> {
    const provider = this.provider(state.provider);
    // Who they are now, not when they clicked: still in the organization, still allowed.
    const user = isValidObjectId(state.sub)
      ? await this.db.collection('users').findOne({ _id: new Types.ObjectId(state.sub), organizationId: state.organizationId, active: { $ne: false } })
      : null;
    if (!user) throw new ForbiddenException('That account is no longer part of the organization.');
    if (state.ownership === 'company' && !isOrgAdmin({ roles: (user.roles as string[]) ?? [] }))
      throw new ForbiddenException('Only an owner or admin can connect the company account.');

    const tokens = await provider.exchangeCode(code);
    if (!tokens.refreshToken) throw new CloudError('auth', 'The provider didn’t allow HaiVE to stay connected.', 'no refresh token returned');
    const account = await provider.account(tokens.accessToken);
    const filter =
      state.ownership === 'company'
        ? { organizationId: state.organizationId, provider: provider.id, ownership: 'company' as const }
        : { organizationId: state.organizationId, provider: provider.id, ownership: 'personal' as const, userId: state.sub, accountId: account.accountId };

    const previous = await this.model.findOne(filter).exec();
    // The company account replaced by a different one: folders shared from the old account mean nothing now.
    if (previous && previous.accountId !== account.accountId) await this.grants.deleteMany({ connectionId: previous._id.toString() }).exec();

    await this.model
      .updateOne(
        filter,
        {
          $set: {
            ...filter,
            userId: state.sub,
            accountId: account.accountId,
            accountEmail: account.email,
            accountName: account.name,
            tenantId: account.tenantId,
            driveId: account.driveId,
            accessToken: this.encryption.encrypt(tokens.accessToken),
            refreshToken: this.encryption.encrypt(tokens.refreshToken),
            expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
            scope: tokens.scope,
            status: 'connected',
          },
          ...(previous && previous.accountId !== account.accountId ? { $unset: { changeCursor: '' } } : {}),
        },
        { upsert: true },
      )
      .exec();
    void this.audit.log({
      userId: state.sub,
      organizationId: state.organizationId,
      method: 'GET',
      route: `/cloud-files/${provider.id}/callback`,
      statusCode: 200,
      durationMs: 0,
      action: 'cloud.connect',
      metadata: { provider: provider.id, ownership: state.ownership, account: account.email, replaced: previous ? previous.accountEmail : undefined },
    });
  }

  // ---- tokens ----------------------------------------------------------------------

  /** A working access token for the connection, refreshed when it is (nearly) out. */
  async accessToken(connection: CloudConnectionDocument, force = false): Promise<string> {
    const label = CLOUD_PROVIDER_LABEL[connection.provider];
    if (connection.status === 'needs_reauth')
      throw new CloudError('auth', `The connection to ${label} (${connection.accountEmail}) has expired. Reconnect it on the Integrations page.`);
    if (!force && connection.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return this.encryption.decrypt(connection.accessToken);

    const key = connection._id.toString();
    const pending = this.refreshing.get(key);
    if (pending) return pending;
    const refresh = this.refresh(connection).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, refresh);
    return refresh;
  }

  private async refresh(connection: CloudConnectionDocument): Promise<string> {
    const provider = this.provider(connection.provider);
    if (!connection.refreshToken) {
      await this.markNeedsReauth(connection);
      throw new CloudError('auth', `Reconnect ${CLOUD_PROVIDER_LABEL[connection.provider]} on the Integrations page.`, 'no refresh token stored');
    }
    try {
      const tokens = await provider.refresh(this.encryption.decrypt(connection.refreshToken));
      const set: Record<string, unknown> = {
        accessToken: this.encryption.encrypt(tokens.accessToken),
        expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        // Microsoft hands out a new refresh token with each refresh; Google keeps the first one.
        ...(tokens.refreshToken ? { refreshToken: this.encryption.encrypt(tokens.refreshToken) } : {}),
      };
      await this.model.updateOne({ _id: connection._id }, { $set: set }).exec();
      Object.assign(connection, set);
      return tokens.accessToken;
    } catch (err) {
      if (err instanceof CloudError && err.kind === 'auth') await this.markNeedsReauth(connection);
      throw err;
    }
  }

  private async markNeedsReauth(connection: CloudConnectionDocument) {
    connection.status = 'needs_reauth';
    await this.model.updateOne({ _id: connection._id }, { $set: { status: 'needs_reauth' } }).exec();
  }

  /**
   * Runs one provider call with the connection's token. If the provider turns the token down (revoked,
   * expired early), it is refreshed once and the call tried again; failing that, the connection asks to be reconnected.
   */
  async withToken<T>(connection: CloudConnectionDocument, run: (token: string) => Promise<T>): Promise<T> {
    try {
      return await run(await this.accessToken(connection));
    } catch (err) {
      if (!(err instanceof CloudError) || err.kind !== 'auth' || connection.status === 'needs_reauth') throw err;
      return run(await this.accessToken(connection, true));
    }
  }

  // ---- what the Integrations page shows -------------------------------------------

  private async names(organizationId: string, ids: string[]): Promise<Map<string, string>> {
    const valid = [...new Set(ids)].filter((id) => isValidObjectId(id)).map((id) => new Types.ObjectId(id));
    if (valid.length === 0) return new Map();
    const users = await this.db
      .collection('users')
      .find({ _id: { $in: valid }, organizationId }, { projection: { name: 1, email: 1 } })
      .toArray();
    return new Map(users.map((u) => [u._id.toString(), String(u.name || u.email || 'Team member')]));
  }

  private view(connection: CloudConnectionDocument, caller: JwtPayload, names: Map<string, string>, sharedFolders?: number | null): CloudConnectionView {
    const provider = this.provider(connection.provider);
    return {
      id: connection._id.toString(),
      provider: connection.provider,
      ownership: connection.ownership,
      accountEmail: connection.accountEmail,
      accountName: connection.accountName,
      status: connection.status ?? 'connected',
      connectedAt: (connection as unknown as { createdAt?: Date }).createdAt,
      ...(connection.ownership === 'company' ? { connectedBy: names.get(connection.userId) ?? 'Team member' } : {}),
      permissions: provider.permissions(connection.scope ?? ''),
      lastSyncAt: connection.lastSyncAt,
      lastSyncStatus: connection.lastSyncStatus,
      lastSyncError: connection.lastSyncError,
      canManage: connection.ownership === 'company' ? isOrgAdmin(caller) : connection.userId === caller.sub,
      ...(sharedFolders !== undefined ? { sharedFolders } : {}),
    };
  }

  async overview(caller: JwtPayload): Promise<CloudProviderOverview[]> {
    const connections = await this.model
      .find({ organizationId: caller.organizationId, $or: [{ ownership: 'company' }, { ownership: 'personal', userId: caller.sub }] })
      .sort({ createdAt: 1 })
      .exec();
    const companies = connections.filter((c) => c.ownership === 'company');
    const names = await this.names(caller.organizationId, companies.map((c) => c.userId));
    const grantCounts = new Map<string, number>();
    if (companies.length > 0 && !isOrgAdmin(caller)) {
      const visible = await this.grants
        .find({ organizationId: caller.organizationId, connectionId: { $in: companies.map((c) => c._id.toString()) }, roles: { $in: caller.roles } })
        .select({ connectionId: 1 })
        .exec();
      for (const grant of visible) grantCounts.set(grant.connectionId, (grantCounts.get(grant.connectionId) ?? 0) + 1);
    }
    return CLOUD_PROVIDERS.map((id) => {
      const company = companies.find((c) => c.provider === id);
      const shared = company ? (isOrgAdmin(caller) ? null : (grantCounts.get(company._id.toString()) ?? 0)) : undefined;
      return {
        id,
        label: CLOUD_PROVIDER_LABEL[id],
        configured: this.providers[id].configured(),
        mine: connections.filter((c) => c.ownership === 'personal' && c.provider === id).map((c) => this.view(c, caller, names)),
        // Someone with no folder shared with their role has nothing to open in it.
        company: company && (shared === null || (shared ?? 0) > 0) ? this.view(company, caller, names, shared) : null,
        canConnectCompany: isOrgAdmin(caller),
      };
    });
  }

  /** Every connection the person asking may open: their own, and the company accounts. */
  async usable(caller: JwtPayload): Promise<CloudConnectionDocument[]> {
    return this.model
      .find({ organizationId: caller.organizationId, $or: [{ ownership: 'company' }, { ownership: 'personal', userId: caller.sub }] })
      .sort({ createdAt: 1 })
      .exec();
  }

  /** A connection of the caller's organization by id, or not found. Who may use it is cloud-access.service.ts's call. */
  async find(organizationId: string, id: string): Promise<CloudConnectionDocument> {
    const connection = isValidObjectId(id) ? await this.model.findOne({ _id: id, organizationId }).exec() : null;
    if (!connection) throw new NotFoundException('That account isn’t connected.');
    return connection;
  }

  // ---- disconnecting -------------------------------------------------------------------

  async disconnect(caller: JwtPayload, id: string): Promise<void> {
    const connection = await this.find(caller.organizationId, id);
    if (connection.ownership === 'personal' && connection.userId !== caller.sub) throw new NotFoundException('That account isn’t connected.');
    if (connection.ownership === 'company' && !isOrgAdmin(caller)) throw new ForbiddenException('Only an owner or admin can disconnect the company account.');
    const provider = this.provider(connection.provider);
    try {
      // Withdraws HaiVE's access at the provider too, where the provider allows it (Google does).
      await provider.revoke({
        refreshToken: connection.refreshToken ? this.encryption.decrypt(connection.refreshToken) : undefined,
        accessToken: this.encryption.decrypt(connection.accessToken),
      });
    } catch (err) {
      // Already revoked, or the provider is down: HaiVE forgets the tokens either way.
      this.logger.warn(`Revoking ${connection.provider} for ${connection.accountEmail} failed: ${(err as CloudError).detail ?? (err as Error).message}`);
    }
    await this.grants.deleteMany({ connectionId: connection._id.toString() }).exec();
    await this.model.deleteOne({ _id: connection._id }).exec();
    void this.audit.log({
      userId: caller.sub,
      organizationId: caller.organizationId,
      method: 'DELETE',
      route: `/cloud-files/connections/${id}`,
      statusCode: 200,
      durationMs: 0,
      action: 'cloud.disconnect',
      metadata: { provider: connection.provider, ownership: connection.ownership, account: connection.accountEmail },
    });
  }

  /** Records the outcome of a sync on the connection (shown on the Integrations page). */
  async recordSync(connection: CloudConnectionDocument, outcome: { ok: boolean; error?: string; cursor?: string }) {
    await this.model
      .updateOne(
        { _id: connection._id },
        {
          $set: {
            lastSyncAt: new Date(),
            lastSyncStatus: outcome.ok ? 'ok' : 'error',
            ...(outcome.cursor ? { changeCursor: outcome.cursor } : {}),
            ...(outcome.ok ? {} : { lastSyncError: outcome.error ?? 'The last sync failed.' }),
          },
          ...(outcome.ok ? { $unset: { lastSyncError: '' } } : {}),
        },
      )
      .exec();
  }

  assertProvider(id: string): asserts id is CloudProviderId {
    if (!(CLOUD_PROVIDERS as readonly string[]).includes(id)) throw new BadRequestException('Choose Google Drive or OneDrive.');
  }
}

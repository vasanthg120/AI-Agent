import { createHash, randomBytes } from 'crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UsersService } from '../users/users.service';
import { ApiToken, ApiTokenDocument } from './schemas/api-token.schema';

const TOKEN_PREFIX = 'pat_';
const PREFIX_DISPLAY_LENGTH = 12;
const LAST_USED_DEBOUNCE_MS = 60_000;

export interface ApiTokenSummary {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
}

// Every method here is scoped to `userId` supplied by the caller (always
// the authenticated caller's own @CurrentUser().sub) except
// authenticateToken, which by necessity looks up by hash first (a request
// bearing a token doesn't know its own owner yet) — no method accepts an
// arbitrary target userId for CRUD, so cross-user access is impossible by
// construction.
@Injectable()
export class ApiTokensService {
  constructor(
    @InjectModel(ApiToken.name) private apiTokenModel: Model<ApiTokenDocument>,
    private usersService: UsersService,
  ) {}

  async create(
    userId: string,
    organizationId: string,
    name: string,
    expiresInDays?: number,
  ): Promise<{ id: string; name: string; token: string; prefix: string; expiresAt?: Date; createdAt: Date }> {
    const token = TOKEN_PREFIX + randomBytes(24).toString('base64url');
    const prefix = token.slice(0, PREFIX_DISPLAY_LENGTH);
    const tokenHash = hashToken(token);
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : undefined;

    const doc = await this.apiTokenModel.create({ userId, organizationId, name, prefix, tokenHash, expiresAt });
    // token itself is returned exactly once, here — never again (not even
    // to its own owner); only tokenHash is ever persisted.
    return {
      id: doc._id.toString(),
      name: doc.name,
      token,
      prefix,
      expiresAt,
      createdAt: (doc as unknown as { createdAt: Date }).createdAt,
    };
  }

  async list(userId: string): Promise<ApiTokenSummary[]> {
    const docs = await this.apiTokenModel
      .find({ userId, revokedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .exec();
    return docs.map((d) => ({
      id: d._id.toString(),
      name: d.name,
      prefix: d.prefix,
      lastUsedAt: d.lastUsedAt,
      expiresAt: d.expiresAt,
      createdAt: (d as unknown as { createdAt: Date }).createdAt,
    }));
  }

  async revoke(userId: string, id: string): Promise<void> {
    const result = await this.apiTokenModel
      .updateOne({ _id: id, userId, revokedAt: { $exists: false } }, { revokedAt: new Date() })
      .exec();
    if (result.matchedCount === 0) throw new NotFoundException('API token not found');
  }

  /** Called from JwtAuthGuard's PAT branch — hashes the presented token,
   * looks it up, and re-fetches the owning user fresh (never trusts
   * anything cached), mirroring JwtStrategy's own "never trust stale
   * claims" philosophy. Returns null (never throws) on any failure so the
   * guard can uniformly respond with a generic 401 regardless of which
   * check failed — a token lookup miss and an inactive owning account
   * should look identical to the caller. */
  async authenticateToken(rawToken: string): Promise<JwtPayload | null> {
    const tokenHash = hashToken(rawToken);
    const doc = await this.apiTokenModel.findOne({ tokenHash, revokedAt: { $exists: false } }).exec();
    if (!doc) return null;
    if (doc.expiresAt && doc.expiresAt < new Date()) return null;

    const user = await this.usersService.findById(doc.userId);
    if (!user || user.active === false) return null;

    void this.touchLastUsedIfStale(doc._id.toString(), doc.lastUsedAt);

    return {
      sub: user._id.toString(),
      email: user.email,
      roles: user.roles,
      organizationId: user.organizationId,
      storeId: user.storeId,
      assignedAgentId: user.assignedAgentId,
      department: user.department,
      voiceAccessEnabled: user.voiceAccessEnabled,
      // No jti — API tokens aren't sessions, there's nothing to look up in
      // User.sessions for them. authMethod is what RequireSessionAuthGuard
      // reads to block this credential from security-management routes.
      authMethod: 'api_token',
    };
  }

  private async touchLastUsedIfStale(tokenId: string, lastUsedAt?: Date): Promise<void> {
    if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_DEBOUNCE_MS) return;
    await this.apiTokenModel.updateOne({ _id: tokenId }, { lastUsedAt: new Date() }).exec();
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

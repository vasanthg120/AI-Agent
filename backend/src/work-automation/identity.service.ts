import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { User, UserDocument } from '../users/schemas/user.schema';
import { ExternalIdentity, ExternalIdentityDocument, IdentityStatus } from './schemas/external-identity.schema';

export interface ExternalUserRef {
  externalUserId?: string;
  email?: string;
  /** Shown to the admin only. Never used to match. */
  displayName?: string;
}

export interface IdentityRow {
  id: string;
  platform: string;
  externalUserId: string;
  externalEmail?: string;
  externalName?: string;
  status: IdentityStatus;
  userId?: string;
  userName?: string;
  matchMethod?: string;
  seenCount: number;
  lastSeenAt?: Date;
}

const norm = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** The key an external person is stored under, or undefined when the platform gave us nothing durable (a bare name is never enough). */
export function identityKey(ref: ExternalUserRef): string | undefined {
  return norm(ref.externalUserId) ?? norm(ref.email)?.toLowerCase();
}

@Injectable()
export class IdentityService {
  constructor(
    @InjectModel(ExternalIdentity.name) private identityModel: Model<ExternalIdentityDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  /**
   * The HaiVE user id an external platform person is, or null. Null means "not
   * resolved": the person is recorded as unresolved for an admin to settle, and
   * nothing is ever assigned to a guess.
   */
  async resolve(organizationId: string, platform: string, ref: ExternalUserRef): Promise<string | null> {
    const key = identityKey(ref);
    if (!key) return null;
    const plat = platform.trim().toLowerCase();
    const email = norm(ref.email)?.toLowerCase();

    const existing = await this.identityModel.findOne({ organizationId, platform: plat, externalUserId: key }).exec();
    if (existing?.status === 'ignored') {
      await this.touch(existing.id);
      return null;
    }
    if (existing?.status === 'linked' && existing.userId) {
      await this.touch(existing.id);
      // A deactivated or deleted employee no longer receives work.
      return (await this.activeUser(organizationId, existing.userId)) ? existing.userId : null;
    }

    const matched = email ? await this.uniqueActiveUserByEmail(organizationId, email) : null;
    const now = new Date();
    const base = {
      ...(email ? { externalEmail: email } : {}),
      ...(norm(ref.displayName) ? { externalName: norm(ref.displayName) } : {}),
    };
    try {
      await this.identityModel
        .findOneAndUpdate(
          { organizationId, platform: plat, externalUserId: key },
          matched
            ? {
                $set: { ...base, status: 'linked', userId: matched, matchMethod: 'email', resolvedAt: now, lastSeenAt: now },
                $setOnInsert: { firstSeenAt: now },
                $inc: { seenCount: 1 },
              }
            : { $set: { ...base, lastSeenAt: now }, $setOnInsert: { status: 'unresolved', firstSeenAt: now }, $inc: { seenCount: 1 } },
          { upsert: true },
        )
        .exec();
    } catch (err) {
      // Two syncs recording the same new person at once: the unique index decides, the loser just retries as a read.
      if ((err as { code?: number }).code !== 11000) throw err;
      return this.resolve(organizationId, platform, ref);
    }
    return matched;
  }

  private async touch(id: string) {
    await this.identityModel.updateOne({ _id: id }, { $set: { lastSeenAt: new Date() }, $inc: { seenCount: 1 } }).exec();
  }

  private async activeUser(organizationId: string, userId: string): Promise<boolean> {
    if (!isValidObjectId(userId)) return false;
    return !!(await this.userModel.exists({ _id: userId, organizationId, active: true }));
  }

  /** Only a single active account in this business with exactly this email counts. Two matches (e.g. a login and a member record) are ambiguous and stay unresolved. */
  private async uniqueActiveUserByEmail(organizationId: string, email: string): Promise<string | null> {
    const users = await this.userModel.find({ organizationId, email, active: true }).select('_id').limit(2).lean().exec();
    return users.length === 1 ? users[0]._id.toString() : null;
  }

  async list(organizationId: string, status?: IdentityStatus, platform?: string): Promise<IdentityRow[]> {
    const filter: Record<string, unknown> = { organizationId };
    if (status) filter.status = status;
    if (platform) filter.platform = platform.trim().toLowerCase();
    const rows = await this.identityModel.find(filter).sort({ status: 1, lastSeenAt: -1 }).limit(500).lean().exec();
    const ids = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v && isValidObjectId(v)))];
    const users = ids.length ? await this.userModel.find({ _id: { $in: ids }, organizationId }).select('name').lean().exec() : [];
    const names = new Map(users.map((u) => [u._id.toString(), u.name]));
    return rows.map((r) => ({
      id: r._id.toString(),
      platform: r.platform,
      externalUserId: r.externalUserId,
      externalEmail: r.externalEmail,
      externalName: r.externalName,
      status: r.status,
      userId: r.userId,
      userName: r.userId ? names.get(r.userId) : undefined,
      matchMethod: r.matchMethod,
      seenCount: r.seenCount,
      lastSeenAt: r.lastSeenAt,
    }));
  }

  async unresolvedCount(organizationId: string): Promise<number> {
    return this.identityModel.countDocuments({ organizationId, status: 'unresolved' }).exec();
  }

  /** Admin decision: this external person is that employee. The employee must be an active person of the same business. */
  async link(organizationId: string, identityId: string, userId: string, actorId: string): Promise<void> {
    if (!isValidObjectId(identityId)) throw new NotFoundException('Identity not found.');
    if (!(await this.activeUser(organizationId, userId))) throw new BadRequestException('Choose an active person of this business.');
    const updated = await this.identityModel
      .findOneAndUpdate(
        { _id: identityId, organizationId },
        { $set: { status: 'linked', userId, matchMethod: 'admin', resolvedBy: actorId, resolvedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('Identity not found.');
  }

  /** Back to unresolved (the link was wrong). */
  async unlink(organizationId: string, identityId: string, actorId: string): Promise<void> {
    if (!isValidObjectId(identityId)) throw new NotFoundException('Identity not found.');
    const updated = await this.identityModel
      .findOneAndUpdate(
        { _id: identityId, organizationId },
        { $set: { status: 'unresolved', resolvedBy: actorId, resolvedAt: new Date() }, $unset: { userId: '', matchMethod: '' } },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('Identity not found.');
  }

  /** Admin decision: this external person is not an employee (a shared login, a contractor) — stop asking. */
  async ignore(organizationId: string, identityId: string, actorId: string): Promise<void> {
    if (!isValidObjectId(identityId)) throw new NotFoundException('Identity not found.');
    const updated = await this.identityModel
      .findOneAndUpdate(
        { _id: identityId, organizationId },
        { $set: { status: 'ignored', resolvedBy: actorId, resolvedAt: new Date() }, $unset: { userId: '', matchMethod: '' } },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('Identity not found.');
  }

  /** Every external id an employee has, per platform (for adapters that query a platform by the employee's own id). */
  async identitiesOfUser(organizationId: string, userId: string): Promise<{ platform: string; externalUserId: string; externalEmail?: string }[]> {
    const rows = await this.identityModel.find({ organizationId, userId, status: 'linked' }).select('platform externalUserId externalEmail').lean().exec();
    return rows.map((r) => ({ platform: r.platform, externalUserId: r.externalUserId, externalEmail: r.externalEmail }));
  }
}

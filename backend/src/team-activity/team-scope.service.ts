import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types, isValidObjectId } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { validTimeZone } from '../common/business-day';
import { holdsPermission, isPermissionManaged } from '../common/permissions/permission.decorator';
import { currencyOf } from '../data-sources/scope-currency';

/** A business whose people the caller may look at. */
export interface ScopedBusiness {
  id: string;
  name: string;
  timeZone: string;
  isMain: boolean;
  isCurrent: boolean;
  // What its deal amounts are in: its default CRM's currency (Hoops: AUD), else INR.
  currency: string;
}

/** Someone of one business, as the team views list them. */
export interface TeamPerson {
  id: string;
  name: string;
  email?: string;
  roles: string[];
  active: boolean;
  storeId?: string;
  // The Main Account owner's own record in a sub-account (see sub-accounts):
  // not one of that business's staff, listed only when they did something there.
  mainAccountMember: boolean;
}

export interface TeamScope {
  businesses: ScopedBusiness[];
  // Sees colleagues, not only themselves.
  team: boolean;
  // A manager sees only the people of their own store.
  storeId?: string;
  selfId: string;
  // The Main Account owner, looking at every business at once.
  acrossBusinesses: boolean;
}

type Doc = Record<string, any>;

function toBusiness(org: Doc, currentId: string): ScopedBusiness {
  return {
    currency: 'INR',
    id: org._id.toString(),
    name: org.name ?? 'Business',
    timeZone: validTimeZone(org.timezone),
    isMain: !org.parentOrganizationId,
    isCurrent: org._id.toString() === currentId,
  };
}

function toPerson(user: Doc): TeamPerson {
  return {
    id: user._id.toString(),
    name: user.name || user.email || 'Unnamed user',
    email: user.email,
    roles: user.roles ?? [],
    active: user.active !== false,
    storeId: user.storeId,
    mainAccountMember: !!user.linkedLoginUserId,
  };
}

// Who may look at whose calls, emails and deals (decided 2026-11-12):
//  - the Main Account owner, in the Main Account: every business — the Main
//    Account and each of its sub-accounts — with a business filter;
//  - in any business, its owner and admins (and anyone given Revenue &
//    Analytics) see the whole team; a manager, the people of their store;
//  - everyone else, only themselves.
// Read straight from the collections: this is shared by Call Copilot and the
// team views and must not pull either module into the other.
@Injectable()
export class TeamScopeService {
  constructor(@InjectConnection() private connection: Connection) {}

  private get organizations() {
    return this.connection.collection('organizations');
  }

  private get users() {
    return this.connection.collection('users');
  }

  async resolve(caller: JwtPayload): Promise<TeamScope> {
    const projection = { name: 1, timezone: 1, parentOrganizationId: 1 };
    const current = isValidObjectId(caller.organizationId)
      ? await this.organizations.findOne({ _id: new Types.ObjectId(caller.organizationId) }, { projection })
      : null;
    if (!current) throw new NotFoundException('Business not found.');

    // The real owner, signed in to the Main Account itself — not someone who has switched in.
    const mainOwner = !caller.loginUserId && caller.roles.includes('owner') && !current.parentOrganizationId;
    const businesses = [toBusiness(current, caller.organizationId)];
    if (mainOwner) {
      const subs = await this.organizations
        .find({ parentOrganizationId: caller.organizationId, status: { $ne: 'archived' } }, { projection })
        .sort({ name: 1 })
        .toArray();
      businesses.push(...subs.map((org) => toBusiness(org, caller.organizationId)));
    }
    // Each business's currency: its default CRM's (one query for all of them).
    const sources = await this.connection
      .collection('crm_data_sources')
      .find({ organizationId: { $in: businesses.map((b) => b.id) }, provider: { $ne: 'haive_native' } }, { projection: { organizationId: 1, provider: 1, metadata: 1, isDefault: 1 } })
      .sort({ isDefault: -1 })
      .toArray();
    for (const business of businesses) {
      const source = sources.find((src) => src.organizationId === business.id);
      if (source) business.currency = currencyOf(source as { provider?: string; metadata?: Record<string, unknown> });
    }

    const admin =
      caller.roles.includes('owner') || caller.roles.includes('admin') || (isPermissionManaged(caller) && holdsPermission(caller, 'analytics', 'view'));
    const manager = !admin && caller.roles.includes('manager') && !!caller.storeId;
    return {
      businesses,
      team: admin || manager,
      storeId: manager ? caller.storeId : undefined,
      selfId: caller.sub,
      acrossBusinesses: businesses.length > 1,
    };
  }

  /** The businesses a request covers: the one asked for, or every one the caller may see. */
  pick(scope: TeamScope, organizationId?: string): ScopedBusiness[] {
    if (!organizationId || organizationId === 'all') return scope.businesses;
    const one = scope.businesses.find((b) => b.id === organizationId);
    if (!one) throw new ForbiddenException('You can’t look at that business.');
    return [one];
  }

  /** The people of one business the caller may see (deactivated ones included: their past work still counts). */
  async people(scope: TeamScope, business: ScopedBusiness): Promise<TeamPerson[]> {
    const projection = { name: 1, email: 1, roles: 1, active: 1, storeId: 1, linkedLoginUserId: 1 };
    if (!scope.team) {
      if (!isValidObjectId(scope.selfId)) return [];
      const me = await this.users.findOne({ _id: new Types.ObjectId(scope.selfId), organizationId: business.id }, { projection });
      return me ? [toPerson(me)] : [];
    }
    const filter: Doc = { organizationId: business.id };
    if (scope.storeId) filter.storeId = scope.storeId;
    const docs = await this.users.find(filter, { projection }).toArray();
    return docs.map(toPerson);
  }

  /** The names to show next to someone else's record: whose it is, and which business. */
  async describeOwner(organizationId: string, userId: string): Promise<{ ownerName: string; businessName: string }> {
    const [user, org] = await Promise.all([
      isValidObjectId(userId) ? this.users.findOne({ _id: new Types.ObjectId(userId) }, { projection: { name: 1, email: 1 } }) : null,
      isValidObjectId(organizationId) ? this.organizations.findOne({ _id: new Types.ObjectId(organizationId) }, { projection: { name: 1 } }) : null,
    ]);
    return { ownerName: user?.name || user?.email || 'Former user', businessName: org?.name ?? 'Business' };
  }

  /** Whether the caller may open something (a call, its recording) that belongs to this person of this business. */
  async canSee(caller: JwtPayload, organizationId: string, userId: string): Promise<boolean> {
    if (organizationId === caller.organizationId && userId === caller.sub) return true;
    const scope = await this.resolve(caller);
    if (!scope.team || !scope.businesses.some((b) => b.id === organizationId)) return false;
    if (!scope.storeId) return true;
    if (!isValidObjectId(userId)) return false;
    const owner = await this.users.findOne({ _id: new Types.ObjectId(userId), organizationId }, { projection: { storeId: 1 } });
    return owner?.storeId === scope.storeId;
  }
}

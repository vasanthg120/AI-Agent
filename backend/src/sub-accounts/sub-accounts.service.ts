import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types, isValidObjectId } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { JwtPayload, loginIdOf } from '../auth/jwt-payload.interface';
import { OrganizationsService } from '../organizations/organizations.service';
import { Organization, OrganizationDocument, OrganizationProfile, accountTypeOf } from '../organizations/schemas/organization.schema';
import { InvitationsService } from '../users/invitations.service';
import { UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { CreateSubAccountDto, GrantAccessDto, UpdateSubAccountDto } from './dto/sub-account.dto';
import { LIVE_SUBSCRIPTION_STATUSES, hasLiveSubscription } from './subscription-access';

type Doc = Record<string, any>;

export interface BillingSnapshot {
  status: string; // a subscription status, or 'none' when it has never had one
  planName: string | null;
  amount: number | null;
  currency: string | null;
  cycle: string | null;
  renewsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  failedRenewals: number;
}

const NO_BILLING: BillingSnapshot = { status: 'none', planName: null, amount: null, currency: null, cycle: null, renewsAt: null, cancelAtPeriodEnd: false, failedRenewals: 0 };

/** A price as a per-month figure, for the dashboard's monthly total. */
function monthlyAmount(amount: number, cycle: string): number {
  switch (cycle) {
    case 'weekly':
      return (amount * 52) / 12;
    case 'quarterly':
      return amount / 3;
    case 'yearly':
      return amount / 12;
    case 'monthly':
      return amount;
    default:
      return 0;
  }
}

function assertValidCurrency(currency: string): void {
  // supportedValuesOf is in every Node version we run but not yet in this project's TS lib.
  const known = (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('currency');
  if (!known.includes(currency)) throw new BadRequestException('Choose a valid currency.');
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new BadRequestException('Choose a valid time zone.');
  }
}

// The Main Account's view of its sub-accounts. Everything goes through
// ownedSubAccount, so a sub-account that isn't this Main Account's own simply
// doesn't exist from here. Business records are never read: these screens show
// status, counts and billing, and working inside a sub-account means switching
// into it (with its own permissions) through the ordinary pages.
@Injectable()
export class SubAccountsService {
  constructor(
    @InjectModel(Organization.name) private orgModel: Model<OrganizationDocument>,
    @InjectConnection() private connection: Connection,
    private organizations: OrganizationsService,
    private users: UsersService,
    private invitations: InvitationsService,
    private audit: AuditService,
  ) {}

  private collection(name: string) {
    return this.connection.collection(name);
  }

  /** Only a Main Account's real owner manages sub-accounts, and only from their
   * Main Account itself: a sub-account's owner, or someone who has switched into a
   * sub-account, can't, so there is only ever one level. */
  private async assertMainOwner(caller: JwtPayload): Promise<void> {
    if (caller.loginUserId || !caller.roles.includes('owner')) throw new ForbiddenException('Only the Main Account owner can manage sub-accounts.');
    const org = await this.organizations.findOrgStatus(caller.organizationId);
    if (!org || org.parentOrganizationId) throw new ForbiddenException('Only the Main Account owner can manage sub-accounts.');
  }

  private async ownedSubAccount(caller: JwtPayload, id: string): Promise<OrganizationDocument> {
    await this.assertMainOwner(caller);
    const org = isValidObjectId(id) ? await this.orgModel.findOne({ _id: id, parentOrganizationId: caller.organizationId }).exec() : null;
    if (!org) throw new NotFoundException('Sub-account not found.');
    return org;
  }

  private logAction(caller: JwtPayload, organizationId: string, action: string, metadata?: Record<string, unknown>): void {
    void this.audit.log({
      userId: loginIdOf(caller),
      organizationId,
      method: 'POST',
      route: '/sub-accounts',
      statusCode: 200,
      durationMs: 0,
      action,
      metadata: { byOrganizationId: caller.organizationId, ...metadata },
    });
  }

  // ---- billing, read only ---------------------------------------------------

  /** The current subscription of each business, or its most recent one. */
  private async billingSnapshots(organizationIds: string[]): Promise<Map<string, BillingSnapshot>> {
    const result = new Map<string, BillingSnapshot>();
    if (organizationIds.length === 0) return result;
    const subscriptions = await this.collection('billing_subscriptions')
      .find({ organizationId: { $in: organizationIds } }, { projection: { organizationId: 1, planId: 1, planPriceId: 1, status: 1, currentPeriodEnd: 1, cancelAtPeriodEnd: 1, renewalFailureCount: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .toArray();
    const chosen = new Map<string, Doc>();
    for (const subscription of subscriptions) {
      const current = chosen.get(subscription.organizationId);
      if (!current || (LIVE_SUBSCRIPTION_STATUSES.includes(subscription.status) && !LIVE_SUBSCRIPTION_STATUSES.includes(current.status))) {
        chosen.set(subscription.organizationId, subscription);
      }
    }
    const objectIds = (ids: unknown[]) => [...new Set(ids.map(String))].filter(isValidObjectId).map((id) => new Types.ObjectId(id));
    const [plans, prices] = await Promise.all([
      this.collection('billing_plans').find({ _id: { $in: objectIds([...chosen.values()].map((s) => s.planId)) } }, { projection: { name: 1 } }).toArray(),
      this.collection('billing_plan_prices')
        .find({ _id: { $in: objectIds([...chosen.values()].map((s) => s.planPriceId)) } }, { projection: { amount: 1, currencyCode: 1, billingCycle: 1 } })
        .toArray(),
    ]);
    const planById = new Map(plans.map((p) => [p._id.toString(), p]));
    const priceById = new Map(prices.map((p) => [p._id.toString(), p]));
    for (const [organizationId, subscription] of chosen) {
      const price = priceById.get(String(subscription.planPriceId));
      result.set(organizationId, {
        status: subscription.status,
        planName: planById.get(String(subscription.planId))?.name ?? null,
        amount: price?.amount ?? null,
        currency: price?.currencyCode ?? null,
        cycle: price?.billingCycle ?? null,
        renewsAt: subscription.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: !!subscription.cancelAtPeriodEnd,
        failedRenewals: subscription.renewalFailureCount ?? 0,
      });
    }
    return result;
  }

  // ---- accounts this login can enter (the header's switcher) -------------------

  async listAccounts(caller: JwtPayload) {
    const loginId = loginIdOf(caller);
    const login = await this.users.findById(loginId);
    if (!login) throw new NotFoundException('Account not found.');
    const members = await this.users.findLinkedMembersOfLogin(loginId);
    const organizationIds = [login.organizationId, ...members.filter((m) => m.active !== false).map((m) => m.organizationId)];
    const orgs = await this.orgModel
      .find({ _id: { $in: organizationIds.filter(isValidObjectId) }, status: { $ne: 'archived' } })
      .select({ name: 1, status: 1, parentOrganizationId: 1, 'profile.logo': 1 })
      .exec();
    const billing = await this.billingSnapshots(orgs.map((o) => o._id.toString()));

    const accounts = orgs.map((org) => {
      const id = org._id.toString();
      const snapshot = billing.get(id) ?? NO_BILLING;
      return {
        id,
        name: org.name,
        logo: org.profile?.logo,
        accountType: accountTypeOf(org),
        status: org.status,
        subscriptionStatus: snapshot.status,
        planName: snapshot.planName,
        isHome: id === login.organizationId,
        isCurrent: id === caller.organizationId,
      };
    });
    // Home first, then by name, so the list reads the same every time.
    accounts.sort((a, b) => Number(b.isHome) - Number(a.isHome) || a.name.localeCompare(b.name));

    const current = accounts.find((a) => a.isCurrent);
    return {
      accounts,
      currentOrganizationId: caller.organizationId,
      homeOrganizationId: login.organizationId,
      canManageSubAccounts: !caller.loginUserId && caller.roles.includes('owner') && current?.accountType === 'main',
      // The current account is a sub-account with nothing to work under.
      locked: current?.accountType === 'sub' && !(await hasLiveSubscription(this.connection, caller.organizationId)),
    };
  }

  // ---- the dashboard -----------------------------------------------------------

  async list(caller: JwtPayload) {
    await this.assertMainOwner(caller);
    const orgs = await this.orgModel.find({ parentOrganizationId: caller.organizationId }).sort({ createdAt: -1 }).exec();
    const ids = orgs.map((o) => o._id.toString());
    const [billing, people] = await Promise.all([
      this.billingSnapshots(ids),
      this.collection('users')
        .find(
          { organizationId: { $in: ids }, linkedLoginUserId: { $exists: false } },
          { projection: { organizationId: 1, name: 1, email: 1, roles: 1, active: 1, passwordHash: 1, oauthProviders: 1, 'sessions.lastSeenAt': 1 } },
        )
        .toArray(),
    ]);

    const peopleByOrg = new Map<string, Doc[]>();
    for (const person of people) peopleByOrg.set(person.organizationId, [...(peopleByOrg.get(person.organizationId) ?? []), person]);

    const rows = orgs.map((org) => {
      const id = org._id.toString();
      const members = peopleByOrg.get(id) ?? [];
      const owner = members.find((m) => (m.roles ?? []).includes('owner'));
      const snapshot = billing.get(id) ?? NO_BILLING;
      return {
        id,
        name: org.name,
        logo: org.profile?.logo,
        ownerName: owner?.name ?? null,
        email: owner?.email ?? org.profile?.businessEmail ?? null,
        phoneCountryCode: org.profile?.phoneCountryCode ?? null,
        phone: org.profile?.phone ?? null,
        status: org.status,
        suspendedByParent: !!org.suspendedByParent,
        ownerActivated: this.hasActivated(owner),
        billing: snapshot,
        userCount: members.length,
        createdAt: (org as unknown as { createdAt?: Date }).createdAt,
        lastActiveAt: this.lastActive(members),
      };
    });

    const open = rows.filter((r) => r.status !== 'archived');
    const revenue = new Map<string, number>();
    for (const row of open) {
      const { status, amount, currency, cycle } = row.billing;
      if (!LIVE_SUBSCRIPTION_STATUSES.includes(status) || amount == null || !currency || !cycle) continue;
      revenue.set(currency, (revenue.get(currency) ?? 0) + monthlyAmount(amount, cycle));
    }
    return {
      overview: {
        total: open.length,
        active: open.filter((r) => r.status === 'active').length,
        inactive: rows.filter((r) => r.status !== 'active').length,
        pendingSubscriptions: open.filter((r) => !LIVE_SUBSCRIPTION_STATUSES.includes(r.billing.status)).length,
        monthlyRevenue: [...revenue].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })),
      },
      subAccounts: rows,
      plansAvailable: await this.plansAvailable(),
    };
  }

  private hasActivated(person?: Doc): boolean {
    if (!person) return false;
    return !!person.passwordHash || Object.keys(person.oauthProviders ?? {}).length > 0;
  }

  private lastActive(people: Doc[]): Date | null {
    let latest: Date | null = null;
    for (const person of people) {
      for (const session of person.sessions ?? []) {
        if (session.lastSeenAt && (!latest || session.lastSeenAt > latest)) latest = session.lastSeenAt;
      }
    }
    return latest;
  }

  /** Whether there is any plan a new sub-account could buy. Without one it would
   * stay locked with nothing to choose, so the dashboard says so. A business's own
   * currency doesn't limit this: the pricing page shows every plan, and the gateway
   * converts where needed (a USD plan charged in INR through Razorpay, say). */
  private async plansAvailable(): Promise<boolean> {
    const plans = await this.collection('billing_plans').find({ active: true, isPublic: true }, { projection: { _id: 1 } }).toArray();
    if (plans.length === 0) return false;
    const price = await this.collection('billing_plan_prices').findOne({ planId: { $in: plans.map((p) => p._id.toString()) }, active: true, effectiveTo: null, billingCycle: { $ne: 'one_time' } }, { projection: { _id: 1 } });
    return !!price;
  }

  // ---- create -------------------------------------------------------------------

  async create(caller: JwtPayload, dto: CreateSubAccountDto) {
    await this.assertMainOwner(caller);
    assertValidTimezone(dto.timezone);
    const currency = dto.currency.toUpperCase();
    assertValidCurrency(currency);

    const email = dto.businessEmail.trim().toLowerCase();
    if (await this.users.emailInUse(email)) throw new ConflictException('An account with this email address already exists. Use a different one.');

    const login = await this.users.findById(caller.sub);
    if (!login) throw new NotFoundException('Account not found.');

    const profile: OrganizationProfile = {
      businessEmail: email,
      phoneCountryCode: dto.phoneCountryCode,
      phone: dto.phone,
      website: dto.website || undefined,
      address: dto.address || undefined,
      city: dto.city || undefined,
      state: dto.state || undefined,
      postalCode: dto.postalCode || undefined,
      logo: dto.logo || undefined,
    };
    const { organization, store } = await this.organizations.createSubOrganization(caller.organizationId, { name: dto.name, timezone: dto.timezone, currency, profile });
    const organizationId = organization._id.toString();

    let owner: UserDocument;
    try {
      // No password: the owner sets one through the invitation link.
      owner = await this.users.create({ email, name: dto.ownerName?.trim() || dto.name, organizationId, storeId: store._id.toString(), roles: ['owner', 'admin'] });
    } catch (err) {
      await this.organizations.removeEmptyOrganization(organizationId);
      if ((err as { code?: number }).code === 11000) throw new ConflictException('An account with this email address already exists. Use a different one.');
      throw err;
    }
    organization.ownerUserId = owner._id.toString();
    await organization.save();

    // The Main owner's own way in: an admin here, listed as coming from the Main
    // Account. No other Main Account employee gets access unless granted it.
    await this.users.createLinkedMember(login, organizationId, 'admin');

    const invitation = dto.sendInvite === false ? null : await this.invitations.invite(owner);
    this.logAction(caller, organizationId, 'sub_account.create', { name: dto.name });
    return { id: organizationId, name: organization.name, ownerEmail: email, invited: !!invitation, activationLink: invitation?.activationLink };
  }

  // ---- details ------------------------------------------------------------------

  async details(caller: JwtPayload, id: string) {
    const org = await this.ownedSubAccount(caller, id);
    const [people, billing] = await Promise.all([
      this.collection('users')
        .find({ organizationId: id }, { projection: { name: 1, email: 1, roles: 1, active: 1, passwordHash: 1, oauthProviders: 1, linkedLoginUserId: 1, 'sessions.lastSeenAt': 1 } })
        .toArray(),
      this.billingSnapshots([id]),
    ]);
    const own = people.filter((p) => !p.linkedLoginUserId);
    const owner = own.find((p) => (p.roles ?? []).includes('owner'));
    return {
      id,
      name: org.name,
      status: org.status,
      suspendedByParent: !!org.suspendedByParent,
      timezone: org.timezone ?? null,
      currency: org.currency ?? null,
      profile: org.profile ?? {},
      owner: owner ? { name: owner.name, email: owner.email, activated: this.hasActivated(owner) } : null,
      createdAt: (org as unknown as { createdAt?: Date }).createdAt,
      archivedAt: org.archivedAt ?? null,
      lastActiveAt: this.lastActive(own),
      userCount: own.length,
      billing: billing.get(id) ?? NO_BILLING,
    };
  }

  async usersSummary(caller: JwtPayload, id: string) {
    await this.ownedSubAccount(caller, id);
    const people = await this.collection('users')
      .find({ organizationId: id }, { projection: { name: 1, email: 1, roles: 1, active: 1, passwordHash: 1, oauthProviders: 1, inviteTokenHash: 1, inviteExpiresAt: 1, linkedLoginUserId: 1, 'sessions.lastSeenAt': 1 } })
      .sort({ createdAt: 1 })
      .toArray();
    const own = people.filter((p) => !p.linkedLoginUserId);
    const pending = own.filter((p) => !this.hasActivated(p));
    const byRole = new Map<string, number>();
    for (const person of own) for (const role of person.roles ?? []) byRole.set(role, (byRole.get(role) ?? 0) + 1);

    // Who from the Main Account can enter, with the login each record belongs to.
    const linked = people.filter((p) => p.linkedLoginUserId);
    const mainOwner = await this.users.findById(caller.sub);
    return {
      total: own.length,
      active: own.filter((p) => p.active !== false && this.hasActivated(p)).length,
      pendingInvitations: pending.length,
      roles: [...byRole].map(([role, count]) => ({ role, count })),
      people: own.map((p) => ({
        id: p._id.toString(),
        name: p.name,
        email: p.email,
        roles: p.roles ?? [],
        active: p.active !== false,
        pendingInvitation: !this.hasActivated(p),
        lastActiveAt: this.lastActive([p]),
      })),
      mainAccountAccess: linked.map((p) => ({
        loginUserId: p.linkedLoginUserId,
        name: p.name,
        email: p.email,
        roles: p.roles ?? [],
        isMainOwner: p.linkedLoginUserId === mainOwner?._id.toString(),
      })),
    };
  }

  /** Main Account employees who could be given access to this sub-account. */
  async grantableEmployees(caller: JwtPayload, id: string) {
    await this.ownedSubAccount(caller, id);
    const [employees, linked] = await Promise.all([
      this.users.findAll(caller.organizationId),
      this.collection('users').find({ organizationId: id, linkedLoginUserId: { $exists: true } }, { projection: { linkedLoginUserId: 1 } }).toArray(),
    ]);
    const already = new Set(linked.map((l) => String(l.linkedLoginUserId)));
    return employees
      .filter((e) => e.active !== false && e._id.toString() !== caller.sub && !already.has(e._id.toString()))
      .map((e) => ({ id: e._id.toString(), name: e.name, email: e.email }));
  }

  async grantAccess(caller: JwtPayload, id: string, dto: GrantAccessDto) {
    await this.ownedSubAccount(caller, id);
    const employee = await this.users.findById(dto.userId);
    if (!employee || employee.organizationId !== caller.organizationId || employee.active === false || employee.linkedLoginUserId) {
      throw new BadRequestException('That person isn’t in your Main Account.');
    }
    const stores = dto.role === 'manager' ? await this.organizations.listStores(id) : [];
    await this.users.createLinkedMember(employee, id, dto.role, stores[0]?._id.toString());
    this.logAction(caller, id, 'sub_account.access_grant', { userId: dto.userId, role: dto.role });
    return this.usersSummary(caller, id);
  }

  async removeAccess(caller: JwtPayload, id: string, loginUserId: string) {
    await this.ownedSubAccount(caller, id);
    if (loginUserId === caller.sub) throw new BadRequestException('The Main Account owner’s access can’t be removed.');
    if (!(await this.users.removeLinkedMember(loginUserId, id))) throw new NotFoundException('That person doesn’t have access to this sub-account.');
    this.logAction(caller, id, 'sub_account.access_remove', { userId: loginUserId });
    return this.usersSummary(caller, id);
  }

  async billingDetails(caller: JwtPayload, id: string) {
    await this.ownedSubAccount(caller, id);
    const [snapshots, payments, invoices, methods] = await Promise.all([
      this.billingSnapshots([id]),
      this.collection('payment_records')
        .find({ organizationId: id }, { projection: { type: 1, amount: 1, currency: 1, status: 1, createdAt: 1 } })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray(),
      this.collection('billing_invoices')
        .find({ organizationId: id }, { projection: { invoiceNumber: 1, total: 1, currencyCode: 1, status: 1, issuedAt: 1 } })
        .sort({ issuedAt: -1 })
        .limit(20)
        .toArray(),
      // Never the card token: only what identifies the card to a person.
      this.collection('payment_methods')
        .find({ organizationId: id }, { projection: { cardNetwork: 1, cardLast4: 1, isDefault: 1 } })
        .toArray(),
    ]);
    return {
      subscription: snapshots.get(id) ?? NO_BILLING,
      payments: payments.map((p) => ({ id: p._id.toString(), type: p.type, amount: p.amount, currency: p.currency, status: p.status, createdAt: p.createdAt })),
      invoices: invoices.map((i) => ({ id: i._id.toString(), number: i.invoiceNumber, total: i.total, currency: i.currencyCode, status: i.status, issuedAt: i.issuedAt })),
      paymentMethods: methods.map((m) => ({ id: m._id.toString(), cardNetwork: m.cardNetwork, last4: m.cardLast4, isDefault: !!m.isDefault })),
    };
  }

  /** What's connected, never the credentials: only names and states are read. */
  async integrations(caller: JwtPayload, id: string) {
    await this.ownedSubAccount(caller, id);
    const [crms, mailboxes, cloud, connected] = await Promise.all([
      this.collection('crm_data_sources').find({ organizationId: id }, { projection: { provider: 1, label: 1, status: 1 } }).toArray(),
      this.collection('outlook_connections').find({ organizationId: id }, { projection: { status: 1, isActive: 1 } }).toArray(),
      this.collection('cloud_connections').find({ organizationId: id }, { projection: { provider: 1, status: 1 } }).toArray(),
      this.collection('integration_credentials').find({ organizationId: id }, { projection: { provider: 1, updatedAt: 1 } }).toArray(),
    ]);
    return {
      crms: crms.map((c) => ({ provider: c.provider, label: c.label, status: c.status })),
      outlook: { connected: mailboxes.length, needingReconnection: mailboxes.filter((m) => m.status === 'needs_reauth').length },
      cloud: cloud.map((c) => ({ provider: c.provider, status: c.status })),
      connections: connected.map((c) => ({ provider: c.provider, updatedAt: c.updatedAt })),
    };
  }

  async activity(caller: JwtPayload, id: string) {
    await this.ownedSubAccount(caller, id);
    const [logs, subscriptionEvents, people] = await Promise.all([
      this.collection('audit_logs')
        .find({ organizationId: id }, { projection: { userId: 1, method: 1, route: 1, statusCode: 1, action: 1, createdAt: 1 } })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray(),
      this.collection('billing_subscription_events').find({ organizationId: id }, { projection: { type: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(50).toArray(),
      this.collection('users').find({ organizationId: id }, { projection: { name: 1, linkedLoginUserId: 1, 'sessions.device': 1, 'sessions.lastSeenAt': 1 } }).toArray(),
    ]);

    const actorIds = logs.map((l) => String(l.userId)).filter(isValidObjectId);
    const actors = await this.collection('users')
      .find({ _id: { $in: [...new Set(actorIds)].map((a) => new Types.ObjectId(a)) } }, { projection: { name: 1 } })
      .toArray();
    const nameById = new Map(actors.map((a) => [a._id.toString(), a.name as string]));

    const logins: { name: string; device: string; lastSeenAt: Date }[] = [];
    for (const person of people) {
      for (const session of person.sessions ?? []) logins.push({ name: person.name, device: session.device, lastSeenAt: session.lastSeenAt });
    }
    logins.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());

    return {
      logins: logins.slice(0, 50),
      changes: logs.map((l) => ({
        id: l._id.toString(),
        who: nameById.get(String(l.userId)) ?? 'Someone',
        // A query string can hold anything, so only the path is shown.
        what: l.action ?? `${l.method} ${String(l.route).split('?')[0]}`,
        statusCode: l.statusCode,
        at: l.createdAt,
      })),
      subscriptionEvents: subscriptionEvents.map((e) => ({ id: e._id.toString(), type: e.type, at: e.createdAt })),
    };
  }

  // ---- change -------------------------------------------------------------------

  async update(caller: JwtPayload, id: string, dto: UpdateSubAccountDto) {
    const org = await this.ownedSubAccount(caller, id);
    if (dto.timezone) assertValidTimezone(dto.timezone);
    if (dto.name) org.name = dto.name;
    if (dto.timezone) org.timezone = dto.timezone;
    if (dto.currency) {
      assertValidCurrency(dto.currency.toUpperCase());
      org.currency = dto.currency.toUpperCase();
    }
    const fields = ['phoneCountryCode', 'phone', 'website', 'address', 'city', 'state', 'postalCode', 'logo'] as const;
    const profile: OrganizationProfile = { ...(org.profile ?? {}) };
    for (const field of fields) {
      const value = dto[field];
      if (value !== undefined) profile[field] = value || undefined;
    }
    org.profile = profile;
    await org.save();
    this.logAction(caller, id, 'sub_account.update');
    return this.details(caller, id);
  }

  async setStatus(caller: JwtPayload, id: string, status: 'active' | 'suspended') {
    const org = await this.ownedSubAccount(caller, id);
    if (org.status === 'archived') throw new BadRequestException('Restore this sub-account first.');
    if (org.status === 'suspended' && !org.suspendedByParent) {
      // The HaiVE platform admin's decision, not the Main Account's to change.
      throw new ForbiddenException('HaiVE support has suspended this account. Contact them to restore it.');
    }
    org.status = status;
    org.suspendedByParent = status === 'suspended';
    await org.save();
    this.logAction(caller, id, status === 'suspended' ? 'sub_account.suspend' : 'sub_account.reactivate');
    return this.details(caller, id);
  }

  /** How "delete" works: sign-in stops and it won't renew, but nothing is erased and
   * it can be restored. The exact name has to be typed, so it can't happen by accident. */
  async archive(caller: JwtPayload, id: string, confirmName: string) {
    const org = await this.ownedSubAccount(caller, id);
    if (confirmName.trim() !== org.name) throw new BadRequestException('Type the sub-account’s exact name to confirm.');
    if (org.status === 'suspended' && !org.suspendedByParent) throw new ForbiddenException('HaiVE support has suspended this account. Contact them to restore it.');
    org.status = 'archived';
    org.suspendedByParent = false;
    org.archivedAt = new Date();
    await org.save();
    // Stops at the end of the period already paid for; the renewal job does the rest.
    await this.collection('billing_subscriptions').updateMany({ organizationId: id, status: { $in: LIVE_SUBSCRIPTION_STATUSES } }, { $set: { cancelAtPeriodEnd: true } });
    this.logAction(caller, id, 'sub_account.archive');
    return this.details(caller, id);
  }

  async restore(caller: JwtPayload, id: string) {
    const org = await this.ownedSubAccount(caller, id);
    if (org.status !== 'archived') throw new BadRequestException('This sub-account isn’t archived.');
    org.status = 'active';
    org.archivedAt = undefined;
    await org.save();
    this.logAction(caller, id, 'sub_account.restore');
    return this.details(caller, id);
  }

  async resendInvitation(caller: JwtPayload, id: string) {
    const org = await this.ownedSubAccount(caller, id);
    const owner = org.ownerUserId ? await this.users.findById(org.ownerUserId) : null;
    if (!owner) throw new NotFoundException('This sub-account has no owner to invite.');
    if (owner.passwordHash) throw new BadRequestException('The owner has already activated their account.');
    const { activationLink } = await this.invitations.invite(owner);
    this.logAction(caller, id, 'sub_account.invite_resend');
    return { email: owner.email, activationLink };
  }
}

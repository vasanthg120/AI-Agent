import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GmailConnection, GmailConnectionDocument } from '../gmail/schemas/gmail-connection.schema';
import { OutlookConnection, OutlookConnectionDocument } from '../outlook/schemas/outlook-connection.schema';
import { Organization, OrganizationDocument } from '../organizations/schemas/organization.schema';
import { User, UserDocument } from '../users/schemas/user.schema';

export type MailProvider = 'gmail' | 'outlook';

export type AdminRecipientSkip = 'employee_not_in_organization' | 'organization_not_found' | 'no_admin_found' | 'employee_is_admin' | 'admin_has_no_email';

export type AdminRecipient =
  | {
      ok: true;
      admin: { id: string; name: string; accountEmail: string };
      /** The address the report goes to: the admin's connected mailbox address when there is one. */
      recipientEmail: string;
      /** The connected mailbox that carries it; null when the admin has none connected (SMTP fallback only). */
      provider: MailProvider | null;
      /** How the admin was found, for the delivery log. */
      via: 'reporting_chain' | 'organization_owner_field' | 'organization_owner_role';
      /** Set when the admin needs to act, e.g. connect a mailbox. Shown on the delivery row. */
      warning?: string;
    }
  | { ok: false; reason: AdminRecipientSkip };

const MAX_CHAIN = 10;
export const ADMIN_MAILBOX_NOT_CONNECTED = 'admin_mailbox_not_connected: the organization admin has no connected Gmail or Outlook mailbox, so the report can only go out through the configured SMTP fallback. Connect a mailbox in Integrations.';

/**
 * Who receives an employee's EOD report: the responsible admin of the EMPLOYEE'S OWN organization,
 * found from existing records only — nothing is configured or guessed.
 *
 *  1. The employee's reporting chain (User.reportingManagerId, same organization, active): the first
 *     person up the chain holding the 'owner' role.
 *  2. Organization.ownerUserId, the authoritative owner of a sub-account.
 *  3. The organization's active user with the 'owner' role (a Main Account's owner); if several, the
 *     earliest-created login account, so the choice is stable rather than "whoever the query returned first".
 *
 * Exactly one admin is returned, so a report is never fanned out to every admin. Every lookup is scoped
 * by the employee's organizationId, which is what keeps one organization's reports away from another's admin.
 */
@Injectable()
export class EodRecipientResolver {
  constructor(
    @InjectModel(User.name) private users: Model<UserDocument>,
    @InjectModel(Organization.name) private organizations: Model<OrganizationDocument>,
    @InjectModel(GmailConnection.name) private gmail: Model<GmailConnectionDocument>,
    @InjectModel(OutlookConnection.name) private outlook: Model<OutlookConnectionDocument>,
  ) {}

  /** `channels` is the organization's delivery order (e.g. gmail, outlook, smtp); it decides which connected mailbox is preferred. */
  async resolveAdmin(organizationId: string, employeeId: string, channels: string[] = ['gmail', 'outlook']): Promise<AdminRecipient> {
    const employee = await this.users.findOne({ _id: employeeId, organizationId }).select('reportingManagerId').lean().exec();
    if (!employee) return { ok: false, reason: 'employee_not_in_organization' };
    const org = await this.organizations.findOne({ _id: organizationId }).select('ownerUserId').lean().exec();
    if (!org) return { ok: false, reason: 'organization_not_found' };

    const found = await this.findAdmin(organizationId, employeeId, employee.reportingManagerId, org.ownerUserId);
    if (!found) return { ok: false, reason: 'no_admin_found' };
    if (found.user._id.toString() === employeeId) return { ok: false, reason: 'employee_is_admin' };

    const adminId = found.user._id.toString();
    const mailbox = await this.connectedMailbox(organizationId, adminId, channels);
    const accountEmail = (found.user.email ?? '').trim();
    const recipientEmail = mailbox?.email ?? accountEmail;
    if (!recipientEmail) return { ok: false, reason: 'admin_has_no_email' };
    return {
      ok: true,
      admin: { id: adminId, name: found.user.name, accountEmail },
      recipientEmail,
      provider: mailbox?.provider ?? null,
      via: found.via,
      ...(mailbox ? {} : { warning: ADMIN_MAILBOX_NOT_CONNECTED }),
    };
  }

  private async findAdmin(organizationId: string, employeeId: string, managerId: string | undefined, ownerUserId: string | undefined) {
    // 1. up the reporting chain, to the first owner
    const seen = new Set<string>([employeeId]);
    let next = managerId;
    for (let i = 0; next && i < MAX_CHAIN && !seen.has(next); i += 1) {
      seen.add(next);
      const person = await this.users.findOne({ _id: next, organizationId, active: true }).select('email name roles reportingManagerId').lean().exec();
      if (!person) break;
      if ((person.roles ?? []).includes('owner')) return { user: person, via: 'reporting_chain' as const };
      next = person.reportingManagerId;
    }
    // 2. the organization's explicit owner field
    if (ownerUserId) {
      const owner = await this.users.findOne({ _id: ownerUserId, organizationId, active: true }).select('email name roles').lean().exec();
      if (owner) return { user: owner, via: 'organization_owner_field' as const };
    }
    // 3. the owner-role account(s): oldest login account first
    const owners = await this.users.find({ organizationId, active: true, roles: 'owner' }).select('email name roles isLogin createdAt').sort({ createdAt: 1 }).exec();
    const pick = owners.find((u) => u.isLogin !== false) ?? owners[0];
    return pick ? { user: pick, via: 'organization_owner_role' as const } : null;
  }

  /** The admin's active, not-needs-reauth mailbox, trying providers in the organization's channel order. */
  private async connectedMailbox(organizationId: string, adminId: string, channels: string[]): Promise<{ provider: MailProvider; email: string } | null> {
    const order = channels.filter((c): c is MailProvider => c === 'gmail' || c === 'outlook');
    for (const provider of order) {
      const conn =
        provider === 'gmail'
          ? await this.gmail.findOne({ userId: adminId, isActive: true, status: { $ne: 'needs_reauth' } }).select('email').lean().exec()
          : await this.outlook.findOne({ userId: adminId, isActive: true, status: { $ne: 'needs_reauth' } }).select('email organizationId').lean().exec();
      // A mailbox recorded against another organization is never used for this one.
      const connOrg = (conn as { organizationId?: string } | null)?.organizationId;
      if (conn?.email && (!connOrg || connOrg === organizationId)) return { provider, email: conn.email.trim().toLowerCase() };
    }
    return null;
  }
}

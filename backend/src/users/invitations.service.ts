import { createHash, randomBytes } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { MailService } from '../mail/mail.service';
import { UserDocument } from './schemas/user.schema';
import { UsersService } from './users.service';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitationResult {
  activationLink?: string;
  expiresAt: Date;
  /** The mail server accepted the invitation email. */
  emailSent: boolean;
  /** Why it wasn't sent (when emailSent is false), for the person who invited. */
  emailProblem?: string;
}
const SALT_ROUNDS = 12;
const INVALID_LINK = 'This invitation link has expired or was already used. Ask for a new one.';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Accounts activated through an emailed link: sub-account owners, and employees
// invited instead of being given a temporary password. The link's random token is
// stored only as a hash, lasts 7 days and works once; sending a new invitation
// replaces the previous link.
@Injectable()
export class InvitationsService {
  constructor(
    private users: UsersService,
    private mail: MailService,
  ) {}

  /** Creates the link and emails it — waiting for the mail server's answer, so
   * whoever invited is told whether the email actually went (`emailSent`, and
   * if not `emailProblem`) instead of "sent" for an email that never left. The
   * link is returned either way: it can be passed on by hand. */
  async invite(user: UserDocument): Promise<InvitationResult> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await this.users.setInvitation(user._id.toString(), hashToken(token), expiresAt);
    const businessName = await this.users.organizationName(user.organizationId);
    const delivery = await this.mail.sendInvitationEmail(user.email, user.name, businessName, token);
    return {
      activationLink: this.mail.invitationLink(token),
      expiresAt,
      emailSent: delivery.sent,
      ...(delivery.sent ? {} : { emailProblem: delivery.problem }),
    };
  }

  async inviteById(userId: string, organizationId: string) {
    const user = await this.users.findById(userId);
    if (!user || user.organizationId !== organizationId) throw new NotFoundException('User not found');
    return this.invite(user);
  }

  /** What the activation page shows before the person chooses a password. */
  async describe(token: string): Promise<{ email: string; name: string; businessName: string }> {
    const user = await this.users.findByInvitation(hashToken(token));
    if (!user) throw new BadRequestException(INVALID_LINK);
    return { email: user.email, name: user.name, businessName: await this.users.organizationName(user.organizationId) };
  }

  async accept(token: string, password: string): Promise<UserDocument> {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await this.users.consumeInvitation(hashToken(token), passwordHash);
    if (!user) throw new BadRequestException(INVALID_LINK);
    return user;
  }
}

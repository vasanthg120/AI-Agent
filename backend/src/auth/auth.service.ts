import { randomInt, randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { isOrganizationBlocked } from '../organizations/schemas/organization.schema';
import { InvitationsService } from '../users/invitations.service';
import { UsersService } from '../users/users.service';
import { UserDocument } from '../users/schemas/user.schema';
import { JwtPayload, loginIdOf } from './jwt-payload.interface';
import { OAuthProfile, OAuthProviderName } from './oauth.service';
import { lookupLocation, parseDeviceLabel } from './session-meta.util';

const SALT_ROUNDS = 12;
const VERIFY_OTP_TTL_MS = 10 * 60 * 1000;
const RESET_OTP_TTL_MS = 15 * 60 * 1000;
const GENERIC_OTP_ERROR = 'Invalid or expired code';

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export type LoginResult = { status: 'ok'; accessToken: string } | { status: '2fa_required'; challengeToken: string };

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private organizationsService: OrganizationsService,
    private jwtService: JwtService,
    private mailService: MailService,
    private auditService: AuditService,
    private invitations: InvitationsService,
  ) {}

  /** Registration always creates a brand-new organization (+ its default
   * store) with this user as its owner — there's no "join an existing org"
   * flow yet; adding teammates afterward goes through POST /users (admin
   * panel), which scopes the new account to the caller's own org. */
  async register(email: string, password: string, name: string, organizationName: string, meta: SessionMeta = {}) {
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }
    const { organization, store } = await this.organizationsService.createOrganizationWithOwner(organizationName);
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await this.usersService.create({
      email,
      passwordHash,
      name,
      organizationId: organization._id.toString(),
      storeId: store._id.toString(),
      // 'admin' kept alongside 'owner' so every existing @Roles('admin')
      // gate (store-settings, integrations, agent-roles, user management)
      // keeps working for the org's creator without touching those decorators.
      roles: ['owner', 'admin'],
    });

    // Not awaited: an SMTP hiccup or slow provider must never add latency to
    // (or fail) the register response — MailService itself never throws, it
    // just logs, but this also decouples send time from request time.
    void this.sendVerificationOtp(user);
    void this.mailService.sendWelcomeEmail(user.email, user.name);

    // A brand-new account never has 2FA enabled yet — go straight to a real
    // session rather than through issueTokenOrChallenge's branch.
    return this.issueSessionToken(user, meta);
  }

  /** Generates a fresh OTP, stores its hash, and emails it — shared by
   * registration (auto-sent) and the explicit resend endpoint. */
  private async sendVerificationOtp(user: UserDocument): Promise<void> {
    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
    await this.usersService.setVerifyOtp(user._id.toString(), otpHash, new Date(Date.now() + VERIFY_OTP_TTL_MS));
    await this.mailService.sendVerificationOtp(user.email, otp);
  }

  /** Re-sends the email-verification OTP. Always resolves the same way
   * whether or not the account exists / is already verified — same
   * anti-enumeration reasoning as login's generic "Invalid credentials". */
  async resendVerificationOtp(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user || user.emailVerified) return;
    await this.sendVerificationOtp(user);
  }

  async verifyEmail(email: string, otp: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.verifyOtpHash || !user.verifyOtpExpiresAt || user.verifyOtpExpiresAt < new Date()) {
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }
    if (!(await bcrypt.compare(otp, user.verifyOtpHash))) {
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }
    await this.usersService.markEmailVerified(user._id.toString());
  }

  /** Always returns a masked-email shape, even for unknown addresses — the
   * mask is derived from the input itself, not a DB lookup, so a caller
   * learns nothing about whether the account exists. The reset OTP is only
   * actually generated/sent when the account is real. */
  async forgotPassword(email: string): Promise<{ maskedEmail: string }> {
    const user = await this.usersService.findByEmail(email);
    if (user) {
      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
      await this.usersService.setResetOtp(user._id.toString(), otpHash, new Date(Date.now() + RESET_OTP_TTL_MS));
      void this.mailService.sendPasswordResetOtp(user.email, otp);
    }
    return { maskedEmail: maskEmail(email) };
  }

  async resetPassword(email: string, otp: string, newPassword: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.resetOtpHash || !user.resetOtpExpiresAt || user.resetOtpExpiresAt < new Date()) {
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }
    if (!(await bcrypt.compare(otp, user.resetOtpHash))) {
      throw new UnauthorizedException(GENERIC_OTP_ERROR);
    }
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await this.usersService.resetPassword(user._id.toString(), passwordHash);
  }

  /** Change-password for an already-authenticated user (Settings > Security)
   * — distinct from resetPassword() above, which is the unauthenticated
   * forgot-password/OTP flow. Requires the current password rather than an
   * OTP, since the caller already proved identity via their JWT session.
   * currentJti is the caller's own session — kept alive while every OTHER
   * session is revoked, so a stolen-and-since-changed password can't be
   * used to keep a hijacker's session alive, but the user isn't logged out
   * of their own current device by changing their own password. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentJti: string,
    ip?: string,
  ): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Invalid session');
    }
    if (!user.passwordHash) {
      throw new BadRequestException(
        'This account signs in via Google/Microsoft/GitHub and has no password to change — use "Forgot password" on the login page to set one.',
      );
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      // 400, not 401 — the JWT itself is valid (JwtAuthGuard already
      // accepted it); frontend's extractErrorMessage() special-cases 401 as
      // "session expired", which would otherwise mask this message.
      throw new BadRequestException('Current password is incorrect');
    }
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await this.usersService.resetPassword(userId, passwordHash);
    await this.usersService.revokeAllOtherSessions(userId, currentJti);
    // Explicit call, not the global AuditInterceptor — /auth/* is skipped
    // there by design (see audit.interceptor.ts's own comment on why: risk
    // of ever accidentally widening that skip to capture credentials).
    void this.auditService.log({
      userId,
      organizationId: user.organizationId,
      method: 'POST',
      route: '/auth/change-password',
      statusCode: 200,
      durationMs: 0,
      ip,
      action: 'password.change',
    });
  }

  async login(email: string, password: string, meta: SessionMeta = {}): Promise<LoginResult> {
    const user = await this.usersService.findByEmail(email);
    // !user.passwordHash covers OAuth-only accounts (see loginWithOAuth) —
    // bcrypt.compare throws on a non-string hash, and such an account can't
    // have a valid password anyway. Same generic failure for "no such
    // user"/"wrong password"/"no password set" — don't turn this into a
    // user-enumeration oracle.
    if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.active === false) {
      throw new UnauthorizedException('Account disabled');
    }
    return this.issueTokenOrChallenge(user, meta);
  }

  /** Finds-or-creates a user for a verified OAuth profile and issues the
   * same JWT shape as password login/register. Lookup order: linked
   * provider id first (stable across email changes), then email (so an
   * existing password-auth user who clicks "Sign in with Google" gets that
   * provider linked to their account instead of a duplicate one), then
   * finally creates a brand-new org+user exactly like register() does.
   * Goes through the same issueTokenOrChallenge branch as password login —
   * 2FA protects the account regardless of which sign-in path reached it,
   * and there's exactly one place that decision is made so the two paths
   * can never drift out of sync. */
  async loginWithOAuth(provider: OAuthProviderName, profile: OAuthProfile, meta: SessionMeta = {}) {
    let user: UserDocument | null = await this.usersService.findByOAuthId(provider, profile.providerId);

    if (!user) {
      const existing = await this.usersService.findByEmail(profile.email);
      if (existing) {
        await this.usersService.linkOAuthProvider(existing._id.toString(), provider, profile.providerId);
        user = existing;
      } else {
        user = await this.registerOAuthUser(provider, profile);
      }
    }

    if (user.active === false) {
      throw new UnauthorizedException('Account disabled');
    }
    return this.issueTokenOrChallenge(user, meta);
  }

  private async registerOAuthUser(provider: OAuthProviderName, profile: OAuthProfile): Promise<UserDocument> {
    const { organization, store } = await this.organizationsService.createOrganizationWithOwner(
      `${profile.name}'s Workspace`,
    );
    const user = await this.usersService.create({
      email: profile.email,
      name: profile.name,
      organizationId: organization._id.toString(),
      storeId: store._id.toString(),
      roles: ['owner', 'admin'],
    });
    await this.usersService.linkOAuthProvider(user._id.toString(), provider, profile.providerId);
    // The provider already verified this email (Google/Microsoft/GitHub all
    // require a verified address to complete their own login) — no OTP round
    // trip needed here, unlike password registration.
    await this.usersService.markEmailVerified(user._id.toString());
    void this.mailService.sendWelcomeEmail(user.email, user.name);
    return user;
  }

  /** Mints a real, session-backed access token — creates a SessionEntry
   * (device/location/timestamps) the user can see and revoke later under
   * Settings > Security > Active Sessions, and embeds that session's jti in
   * the token so JwtStrategy.validate() can reject it the instant it's
   * revoked, on the very next request. Not private: TwoFactorService calls
   * this directly to finish issuing a real session once a login-2fa
   * challenge is actually satisfied — same method either way, so a 2FA
   * login's session is created identically to a non-2FA one. */
  async issueSessionToken(user: UserDocument, meta: SessionMeta): Promise<{ accessToken: string }> {
    const jti = randomUUID();
    const now = new Date();
    await this.usersService.addSession(user._id.toString(), {
      jti,
      device: parseDeviceLabel(meta.userAgent),
      userAgent: meta.userAgent,
      ip: meta.ip,
      location: lookupLocation(meta.ip),
      createdAt: now,
      lastSeenAt: now,
    });
    const payload: JwtPayload = {
      sub: user._id.toString(),
      email: user.email,
      roles: user.roles,
      organizationId: user.organizationId,
      storeId: user.storeId,
      assignedAgentId: user.assignedAgentId,
      department: user.department,
      jti,
    };
    return { accessToken: this.jwtService.sign(payload) };
  }

  /**
   * Moves a signed-in person into another business they may enter, without signing
   * in again. Only a business they really belong to works: their own, or one with a
   * member record linked to their login — never an id taken on trust from the
   * browser. The new token keeps the same session (revoking it signs them out
   * everywhere) and the same expiry (switching can't extend a session).
   */
  async switchAccount(caller: JwtPayload, organizationId: string, ip?: string): Promise<{ accessToken: string }> {
    if (caller.authMethod !== 'session' || !caller.jti) {
      throw new ForbiddenException('Switching accounts requires a full login session.');
    }
    const loginId = loginIdOf(caller);
    const login = await this.usersService.findById(loginId);
    if (!login || login.active === false) throw new UnauthorizedException();
    const target = login.organizationId === organizationId ? login : await this.usersService.findLinkedMember(loginId, organizationId);
    if (!target || target.active === false) throw new ForbiddenException('You don’t have access to this account.');
    const org = await this.organizationsService.findOrgStatus(organizationId);
    if (!org || isOrganizationBlocked(org.status)) throw new ForbiddenException('This account is suspended or archived.');

    const payload: JwtPayload = {
      sub: target._id.toString(),
      email: target.email,
      roles: target.roles,
      organizationId: target.organizationId,
      storeId: target.storeId,
      assignedAgentId: target.assignedAgentId,
      department: target.department,
      jti: caller.jti,
      ...(target.linkedLoginUserId ? { loginUserId: loginId } : {}),
    };
    const secondsLeft = caller.exp ? caller.exp - Math.floor(Date.now() / 1000) : 0;
    const accessToken = secondsLeft > 0 ? this.jwtService.sign(payload, { expiresIn: secondsLeft }) : this.jwtService.sign(payload);
    void this.auditService.log({
      userId: loginId,
      organizationId,
      method: 'POST',
      route: '/organizations/switch',
      statusCode: 200,
      durationMs: 0,
      ip,
      action: 'account.switch',
      metadata: { fromOrganizationId: caller.organizationId, toOrganizationId: organizationId },
    });
    return { accessToken };
  }

  describeInvitation(token: string) {
    return this.invitations.describe(token);
  }

  /** Sets the password chosen on the activation page and signs the person in. */
  async acceptInvitation(token: string, password: string, meta: SessionMeta = {}): Promise<{ accessToken: string }> {
    const user = await this.invitations.accept(token, password);
    void this.auditService.log({
      userId: user._id.toString(),
      organizationId: user.organizationId,
      method: 'POST',
      route: '/auth/invitation/accept',
      statusCode: 200,
      durationMs: 0,
      ip: meta.ip,
      action: 'invitation.accept',
    });
    return this.issueSessionToken(user, meta);
  }

  /** A short-lived, minimal-claim token proving "this is who just supplied
   * valid credentials," nothing more — no roles/org/jti, so even if it
   * leaked it couldn't authenticate a real request (JwtStrategy.validate()
   * rejects any payload carrying `purpose` outright). Mirrors the existing
   * `state` token pattern OAuthController already signs for its own
   * CSRF-proofing round trip. */
  private buildChallengeToken(user: UserDocument): string {
    return this.jwtService.sign(
      { sub: user._id.toString(), purpose: 'login-2fa-challenge' },
      { expiresIn: '5m' },
    );
  }

  /** The single shared branch point password login, OAuth login, and (once
   * TwoFactorService exists) the login-2fa-challenge flow's own final step
   * all funnel through — a session is only ever created once 2FA is
   * actually satisfied (or was never required), never at credential-check
   * time. Today this always resolves 'ok' (TwoFactorService/the
   * twoFactorEnabled branch lands in a later step); the shape is already
   * final so callers don't change again when that lands. */
  async issueTokenOrChallenge(user: UserDocument, meta: SessionMeta = {}): Promise<LoginResult> {
    if (user.twoFactorEnabled) {
      return { status: '2fa_required', challengeToken: this.buildChallengeToken(user) };
    }
    const { accessToken } = await this.issueSessionToken(user, meta);
    return { status: 'ok', accessToken };
  }

  /** Revokes exactly the caller's own current session — POST /auth/logout
   * is the first time "logout" has been a real backend action rather than
   * the frontend's previous no-op (stateless JWTs had nothing to revoke
   * before sessions existed). */
  logout(userId: string, jti: string): Promise<unknown> {
    return this.usersService.revokeSession(userId, jti);
  }
}

function generateOtp(): string {
  return String(randomInt(100_000, 1_000_000));
}

// Same masking shape the frontend used to compute client-side for its mock
// flow (see authService.ts's now-removed forgotPassword) — kept identical so
// the UI looks the same now that a real backend produces it.
function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  const masked = name && name.length > 2 ? `${name.slice(0, 2)}${'*'.repeat(name.length - 2)}` : `${name?.[0] ?? ''}*`;
  return `${masked}@${domain ?? 'example.com'}`;
}

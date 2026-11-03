import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { InvitationsService } from '../users/invitations.service';
import { UsersService } from '../users/users.service';
import { UserDocument } from '../users/schemas/user.schema';
import { JwtPayload } from './jwt-payload.interface';
import { OAuthProfile, OAuthProviderName } from './oauth.service';
export interface SessionMeta {
    userAgent?: string;
    ip?: string;
}
export type LoginResult = {
    status: 'ok';
    accessToken: string;
} | {
    status: '2fa_required';
    challengeToken: string;
};
export declare class AuthService {
    private usersService;
    private organizationsService;
    private jwtService;
    private mailService;
    private auditService;
    private invitations;
    constructor(usersService: UsersService, organizationsService: OrganizationsService, jwtService: JwtService, mailService: MailService, auditService: AuditService, invitations: InvitationsService);
    register(email: string, password: string, name: string, organizationName: string, meta?: SessionMeta): Promise<{
        accessToken: string;
    }>;
    private sendVerificationOtp;
    resendVerificationOtp(email: string): Promise<void>;
    verifyEmail(email: string, otp: string): Promise<void>;
    forgotPassword(email: string): Promise<{
        maskedEmail: string;
    }>;
    resetPassword(email: string, otp: string, newPassword: string): Promise<void>;
    changePassword(userId: string, currentPassword: string, newPassword: string, currentJti: string, ip?: string): Promise<void>;
    login(email: string, password: string, meta?: SessionMeta): Promise<LoginResult>;
    loginWithOAuth(provider: OAuthProviderName, profile: OAuthProfile, meta?: SessionMeta): Promise<LoginResult>;
    private registerOAuthUser;
    issueSessionToken(user: UserDocument, meta: SessionMeta): Promise<{
        accessToken: string;
    }>;
    switchAccount(caller: JwtPayload, organizationId: string, ip?: string): Promise<{
        accessToken: string;
    }>;
    describeInvitation(token: string): Promise<{
        email: string;
        name: string;
        businessName: string;
    }>;
    acceptInvitation(token: string, password: string, meta?: SessionMeta): Promise<{
        accessToken: string;
    }>;
    private buildChallengeToken;
    issueTokenOrChallenge(user: UserDocument, meta?: SessionMeta): Promise<LoginResult>;
    logout(userId: string, jti: string): Promise<unknown>;
}

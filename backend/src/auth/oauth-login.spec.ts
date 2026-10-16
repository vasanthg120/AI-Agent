import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { Connection, Model } from 'mongoose';
import { UnauthorizedException } from '@nestjs/common';
import { AgentRole, AgentRoleDocument, AgentRoleSchema } from '../agent-roles/schemas/agent-role.schema';
import { Organization, OrganizationDocument, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { Store, StoreDocument, StoreSchema } from '../organizations/schemas/store.schema';
import { OrganizationsService } from '../organizations/organizations.service';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { OAuthProfile, OAuthService } from './oauth.service';

// Real Mongo + real UsersService/OrganizationsService (this is genuinely
// what creates/links accounts — faking it would test nothing), MailService/
// AuditService mocked (side effects unrelated to what's being verified here:
// account linking, session issuance, 2FA gating, cross-tenant isolation).
const PREFIX = `jest-oauthlogin-${Date.now()}`;

describe('Google/Microsoft/GitHub Sign-In (OAuthService + AuthService.loginWithOAuth)', () => {
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let authService: AuthService;
  let oauthService: OAuthService;
  let seq = 0;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: AgentRole.name, schema: AgentRoleSchema },
          { name: Organization.name, schema: OrganizationSchema },
          { name: Store.name, schema: StoreSchema },
        ]),
      ],
    }).compile();

    userModel = moduleRef.get(getModelToken(User.name));
    const agentRoleModel = moduleRef.get<Model<AgentRoleDocument>>(getModelToken(AgentRole.name));
    const orgModel = moduleRef.get<Model<OrganizationDocument>>(getModelToken(Organization.name));
    const storeModel = moduleRef.get<Model<StoreDocument>>(getModelToken(Store.name));
    connection = moduleRef.get(getConnectionToken());
    await userModel.init();

    const usersService = new UsersService(userModel, agentRoleModel);
    const organizationsService = new OrganizationsService(orgModel, storeModel);
    const jwt = new JwtService({ secret: `${PREFIX}-secret` });
    const mail = { sendWelcomeEmail: jest.fn().mockResolvedValue(undefined) };
    const audit = { log: jest.fn() };

    authService = new AuthService(usersService, organizationsService, jwt, mail as never, audit as never);
    const http = { post: jest.fn(), get: jest.fn() };
    const config = {
      // OAuthService.providerConfig() reads the whole `oauth.<provider>`
      // object as one key (real ConfigService does nested-path traversal
      // against the loaded config object) — not three separate dotted keys.
      get: (key: string) => {
        if (key === 'oauth.google') {
          return {
            clientId: 'google-login-client-id',
            clientSecret: 'google-login-client-secret',
            redirectUri: 'http://localhost:3000/auth/oauth/google/callback',
          };
        }
        return undefined;
      },
    } as never;
    oauthService = new OAuthService(config, http as never);
  });

  beforeEach(() => {
    seq += 1;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await userModel.deleteMany({ email: { $regex: `^${PREFIX}` } });
    await connection.collection('organizations').deleteMany({ name: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  const profile = (overrides: Partial<OAuthProfile> = {}): OAuthProfile => ({
    providerId: `google-sub-${seq}`,
    email: `${PREFIX}-${seq}@example.com`,
    name: `${PREFIX} Test User ${seq}`,
    ...overrides,
  });

  it('buildAuthorizeUrl (google) requests openid+email+profile and carries the given state, using the LOGIN-specific OAuth client — not the Gmail mailbox one', () => {
    const url = new URL(oauthService.buildAuthorizeUrl('google', 'state-xyz'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('google-login-client-id');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('state-xyz');
  });

  it('a brand-new Google identity creates a new organization + owner user, with the email pre-verified (Google already verified it)', async () => {
    const p = profile();
    const result = await authService.loginWithOAuth('google', p);
    expect(result.status).toBe('ok');

    const user = await userModel.findOne({ email: p.email });
    expect(user).toMatchObject({ emailVerified: true, roles: expect.arrayContaining(['owner', 'admin']) });
    expect(user?.oauthProviders).toMatchObject({ google: p.providerId });
  });

  it('signing in again with the same Google identity reuses the same account (found by linked provider id) instead of creating a duplicate', async () => {
    const p = profile();
    await authService.loginWithOAuth('google', p);
    await authService.loginWithOAuth('google', p);

    const matches = await userModel.find({ email: p.email });
    expect(matches).toHaveLength(1);
  });

  it('an existing password-auth account with a matching email gets Google linked to it, rather than a duplicate account being created', async () => {
    const existingEmail = `${PREFIX}-existing-${seq}@example.com`;
    const existing = await userModel.create({
      email: existingEmail,
      name: 'Existing Password User',
      passwordHash: 'irrelevant-bcrypt-hash',
      organizationId: `${PREFIX}-org-${seq}`,
      roles: ['owner', 'admin'],
      emailVerified: true,
    });

    const p = profile({ email: existingEmail });
    await authService.loginWithOAuth('google', p);

    const matches = await userModel.find({ email: existingEmail });
    expect(matches).toHaveLength(1);
    expect(matches[0]._id.toString()).toBe(existing._id.toString());
    expect(matches[0].oauthProviders).toMatchObject({ google: p.providerId });
  });

  it('a disabled account is rejected even with a valid Google identity', async () => {
    const p = profile();
    await authService.loginWithOAuth('google', p); // creates it
    await userModel.updateOne({ email: p.email }, { $set: { active: false } });

    await expect(authService.loginWithOAuth('google', p)).rejects.toThrow(UnauthorizedException);
  });

  it('an account with 2FA enabled gets a challenge token, not a real session — same gate password login goes through', async () => {
    const p = profile();
    await authService.loginWithOAuth('google', p);
    await userModel.updateOne({ email: p.email }, { $set: { twoFactorEnabled: true } });

    const result = await authService.loginWithOAuth('google', p);
    expect(result.status).toBe('2fa_required');
    expect((result as { challengeToken: string }).challengeToken).toEqual(expect.any(String));
    expect((result as { accessToken?: string }).accessToken).toBeUndefined();
  });

  it('two different Google identities with different emails never collide into the same account', async () => {
    const p1 = profile({ providerId: `google-sub-a-${seq}`, email: `${PREFIX}-a-${seq}@example.com` });
    const p2 = profile({ providerId: `google-sub-b-${seq}`, email: `${PREFIX}-b-${seq}@example.com` });
    await authService.loginWithOAuth('google', p1);
    await authService.loginWithOAuth('google', p2);

    const userA = await userModel.findOne({ email: p1.email });
    const userB = await userModel.findOne({ email: p2.email });
    expect(userA?._id.toString()).not.toBe(userB?._id.toString());
    expect(userA?.organizationId).not.toBe(userB?.organizationId);
  });
});

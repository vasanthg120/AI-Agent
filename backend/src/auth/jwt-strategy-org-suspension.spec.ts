import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { AgentRole, AgentRoleDocument, AgentRoleSchema } from '../agent-roles/schemas/agent-role.schema';
import { Organization, OrganizationDocument, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { OrganizationsService } from '../organizations/organizations.service';
import { Store, StoreSchema } from '../organizations/schemas/store.schema';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { JwtStrategy } from './strategies/jwt.strategy';

// Real-Mongo integration test for the one thing Organization.status
// previously had modeled but never enforced anywhere (confirmed by a full
// backend search: nothing wrote 'suspended' and nothing checked it).
// JwtStrategy.validate() is the one choke point every normal customer
// request already passes through, so this is where the block lives —
// platform admins are on a completely separate AdminJwtStrategy that never
// reaches this class, so they're never affected by an organization's own
// suspension.

const TEST_PREFIX = `jest-jwt-org-suspension-${Date.now()}`;

describe('JwtStrategy — organization suspension enforcement (real Mongo)', () => {
  let connection: Connection;
  let strategy: JwtStrategy;
  let orgModel: Model<OrganizationDocument>;
  let userModel: Model<UserDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Organization.name, schema: OrganizationSchema },
          { name: Store.name, schema: StoreSchema },
          { name: User.name, schema: UserSchema },
          { name: AgentRole.name, schema: AgentRoleSchema },
        ]),
      ],
      providers: [
        JwtStrategy,
        UsersService,
        OrganizationsService,
        { provide: ConfigService, useValue: { get: (key: string) => (key === 'jwt.secret' ? 'jest-test-secret' : undefined) } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(Organization.name)).db;
    strategy = moduleRef.get(JwtStrategy);
    orgModel = moduleRef.get(getModelToken(Organization.name));
    userModel = moduleRef.get(getModelToken(User.name));
  });

  afterAll(async () => {
    await orgModel.deleteMany({ slug: { $regex: `^${TEST_PREFIX}` } });
    await userModel.deleteMany({ email: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('validates a session in an active organization, rejects it once suspended, and restores it on reactivation', async () => {
    const org = await orgModel.create({ name: 'Suspension Test Org', slug: `${TEST_PREFIX}-org` });
    const jti = `${TEST_PREFIX}-jti`;
    const user = await userModel.create({
      email: `${TEST_PREFIX}-user@example.com`,
      name: 'Suspension Test User',
      organizationId: org._id.toString(),
      roles: ['owner', 'admin'],
      sessions: [{ jti, device: 'test', createdAt: new Date(), lastSeenAt: new Date() }],
    });
    const payload = { sub: user._id.toString(), email: user.email, roles: user.roles, organizationId: org._id.toString(), jti };

    // Active org: validates fine.
    await expect(strategy.validate(payload)).resolves.toMatchObject({ sub: user._id.toString() });

    // Suspend the org: the SAME session must now be rejected.
    await orgModel.updateOne({ _id: org._id }, { status: 'suspended' });
    await expect(strategy.validate(payload)).rejects.toThrow();

    // Reactivate: access is restored, no re-login/new session needed.
    await orgModel.updateOne({ _id: org._id }, { status: 'active' });
    await expect(strategy.validate(payload)).resolves.toMatchObject({ sub: user._id.toString() });
  });

  it('never blocks a user whose organization has no status set (schema default is active)', async () => {
    const org = await orgModel.create({ name: 'Default Status Org', slug: `${TEST_PREFIX}-default-org` });
    const jti = `${TEST_PREFIX}-default-jti`;
    const user = await userModel.create({
      email: `${TEST_PREFIX}-default-user@example.com`,
      name: 'Default Status User',
      organizationId: org._id.toString(),
      roles: ['owner', 'admin'],
      sessions: [{ jti, device: 'test', createdAt: new Date(), lastSeenAt: new Date() }],
    });
    const payload = { sub: user._id.toString(), email: user.email, roles: user.roles, organizationId: org._id.toString(), jti };

    await expect(strategy.validate(payload)).resolves.toMatchObject({ sub: user._id.toString() });
  });
});

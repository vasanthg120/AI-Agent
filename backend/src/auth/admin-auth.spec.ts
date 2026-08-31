import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { AdminAuthService } from './admin-auth.service';
import { AdminAccount, AdminAccountDocument, AdminAccountSchema } from './schemas/admin-account.schema';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';

// Real-Mongo integration tests for the separate admin login system — a
// fully independent credential from the customer User collection (see
// admin-auth.service.ts's own comments). Covers login success/failure,
// account creation, and immediate revocation via the `active` flag, which
// AdminJwtStrategy re-checks on every request.

const TEST_PREFIX = `jest-admin-auth-${Date.now()}`;

describe('AdminAuthService (real Mongo)', () => {
  let connection: Connection;
  let service: AdminAuthService;
  let strategy: AdminJwtStrategy;
  let adminAccountModel: Model<AdminAccountDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([{ name: AdminAccount.name, schema: AdminAccountSchema }]),
        JwtModule.register({ secret: 'jest-test-secret', signOptions: { expiresIn: '1d' } }),
      ],
      providers: [
        AdminAuthService,
        AdminJwtStrategy,
        { provide: ConfigService, useValue: { get: () => 'jest-test-secret' } as unknown as ConfigService },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(AdminAccount.name)).db;
    service = moduleRef.get(AdminAuthService);
    adminAccountModel = moduleRef.get(getModelToken(AdminAccount.name));
    strategy = moduleRef.get(AdminJwtStrategy);
  });

  afterAll(async () => {
    await adminAccountModel.deleteMany({ email: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('creates an admin account and rejects a duplicate email', async () => {
    const email = `${TEST_PREFIX}-a@example.com`;
    const created = await service.create({ email, password: 'password123', name: 'Test Admin' });
    expect(created.email).toBe(email);
    expect(created.active).toBe(true);

    await expect(service.create({ email, password: 'password123', name: 'Dup' })).rejects.toThrow();
  });

  it('logs in with correct credentials and rejects wrong ones', async () => {
    const email = `${TEST_PREFIX}-b@example.com`;
    await service.create({ email, password: 'correct-password', name: 'Login Test' });

    const result = await service.login(email, 'correct-password');
    expect(result.accessToken).toBeTruthy();
    expect(result.admin.email).toBe(email);

    await expect(service.login(email, 'wrong-password')).rejects.toThrow();
    await expect(service.login('nobody@example.com', 'whatever')).rejects.toThrow();
  });

  it('rejects login for a deactivated account, and a previously-issued token stops validating immediately', async () => {
    const email = `${TEST_PREFIX}-c@example.com`;
    const created = await service.create({ email, password: 'password123', name: 'Deactivate Test' });
    const { accessToken } = await service.login(email, 'password123');

    // The token is valid right after login.
    await expect(strategy.validate({ sub: created.id, email, isAdminAccount: true })).resolves.toMatchObject({ sub: created.id });
    void accessToken; // shape-check only — verifying the JWT itself isn't the point of this test

    await service.setActive(created.id, false, 'someone-else');
    await expect(service.login(email, 'password123')).rejects.toThrow();
    await expect(strategy.validate({ sub: created.id, email, isAdminAccount: true })).rejects.toThrow();
  });

  it('blocks an admin from deactivating their own account', async () => {
    const created = await service.create({ email: `${TEST_PREFIX}-d@example.com`, password: 'password123', name: 'Self Test' });
    await expect(service.setActive(created.id, false, created.id)).rejects.toThrow();
  });

  it('lists created accounts', async () => {
    const all = await service.list();
    const testCreated = all.filter((a) => a.email.startsWith(TEST_PREFIX));
    expect(testCreated.length).toBeGreaterThan(0);
  });
});

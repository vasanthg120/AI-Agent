import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Connection, Model } from 'mongoose';
import { UnauthorizedException } from '@nestjs/common';
import { AdminAccount, AdminAccountDocument, AdminAccountSchema } from './schemas/admin-account.schema';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';

// This is the actual security boundary behind "an ordinary Haive user
// cannot configure platform-wide OAuth credentials (Gmail's Google app,
// Anthropic/Sarvam/ElevenLabs/Groq's API keys)" — AdminJwtAuthGuard on
// admin-integrations.controller.ts delegates straight to this strategy. A
// regular customer JWT (even one signed with a real, valid platform admin's
// _id as `sub`, which never happens in practice but is the precise thing to
// rule out) must never pass, because it lacks isAdminAccount — proven here
// directly against a real Mongo AdminAccount, not mocked.
const PREFIX = `jest-adminjwt-${Date.now()}`;

describe('AdminJwtStrategy — platform-admin-only boundary', () => {
  let connection: Connection;
  let adminAccountModel: Model<AdminAccountDocument>;
  let strategy: AdminJwtStrategy;
  let adminId: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: AdminAccount.name, schema: AdminAccountSchema }])],
    }).compile();
    adminAccountModel = moduleRef.get(getModelToken(AdminAccount.name));
    connection = moduleRef.get(getConnectionToken());
    await adminAccountModel.init();

    const config = { get: (key: string) => (key === 'jwt.secret' ? `${PREFIX}-secret` : undefined) } as ConfigService;
    strategy = new AdminJwtStrategy(config, adminAccountModel);

    const created = await adminAccountModel.create({ email: `${PREFIX}@example.com`, name: 'Test Admin', passwordHash: 'irrelevant', active: true });
    adminId = created._id.toString();
  });

  afterAll(async () => {
    await adminAccountModel.deleteMany({ email: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  it('accepts a real admin token (isAdminAccount: true, matching an active account)', async () => {
    const result = await strategy.validate({ sub: adminId, isAdminAccount: true, email: `${PREFIX}@example.com` });
    expect(result).toMatchObject({ sub: adminId, isAdminAccount: true });
  });

  it('rejects a customer-shaped JWT payload (no isAdminAccount) even when `sub` happens to equal a real admin account id', async () => {
    // Exactly what an ordinary Haive user's token looks like — proves the
    // guard checks the payload shape, not just whether `sub` resolves to
    // something in a collection.
    await expect(strategy.validate({ sub: adminId } as never)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects isAdminAccount: true for an id that does not exist in platform_admins', async () => {
    await expect(strategy.validate({ sub: '000000000000000000000000', isAdminAccount: true, email: 'nope@example.com' })).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a deactivated admin account immediately, even with a correctly-shaped token', async () => {
    const deactivated = await adminAccountModel.create({ email: `${PREFIX}-off@example.com`, name: 'Deactivated', passwordHash: 'x', active: false });
    await expect(strategy.validate({ sub: deactivated._id.toString(), isAdminAccount: true, email: `${PREFIX}-off@example.com` })).rejects.toThrow(UnauthorizedException);
  });
});

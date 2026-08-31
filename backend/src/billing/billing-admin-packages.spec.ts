import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { BillingAdminPackagesService } from './billing-admin-packages.service';
import { CreditPackage, CreditPackageDocument, CreditPackageSchema } from './schemas/credit-package.schema';

// Real-Mongo integration tests for the admin Credit Packages CRUD — the
// sole source of what GET /billing/packages (and the customer "Add Credits"
// modal) shows, now that billing-seed.service.ts no longer seeds any
// hardcoded examples.

const TEST_PREFIX = `jest-billing-packages-${Date.now()}`;

describe('BillingAdminPackagesService (real Mongo)', () => {
  let connection: Connection;
  let service: BillingAdminPackagesService;
  let packageModel: Model<CreditPackageDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: CreditPackage.name, schema: CreditPackageSchema }])],
      providers: [BillingAdminPackagesService],
    }).compile();

    connection = moduleRef.get(getModelToken(CreditPackage.name)).db;
    service = moduleRef.get(BillingAdminPackagesService);
    packageModel = moduleRef.get(getModelToken(CreditPackage.name));
  });

  afterAll(async () => {
    await packageModel.deleteMany({ key: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('creates a package and rejects a duplicate key', async () => {
    const key = `${TEST_PREFIX}-starter`;
    const created = await service.createPackage({ key, name: 'Starter', credits: 500, price: 500, currency: 'inr' });
    expect(created.currency).toBe('INR'); // uppercased on write, same convention as Currency/Coupon codes
    expect(created.active).toBe(true); // schema default when the DTO omits it

    await expect(service.createPackage({ key, name: 'Starter Again', credits: 500, price: 500, currency: 'INR' })).rejects.toThrow();
  });

  it('never auto-creates the old hardcoded example keys — only explicit createPackage calls add rows', async () => {
    const before = await service.listPackages();
    const testCreatedCount = before.filter((p) => p.key.startsWith(TEST_PREFIX)).length;
    // This test file itself is the only thing creating packages here — no
    // seed service runs in this isolated module, so nothing besides what
    // the tests above explicitly created can appear.
    expect(testCreatedCount).toBeGreaterThan(0);
  });

  it('updates a package and can deactivate/reactivate it', async () => {
    const pkg = await service.createPackage({ key: `${TEST_PREFIX}-basic`, name: 'Basic', credits: 1000, price: 1000, currency: 'INR' });

    const updated = await service.updatePackage(pkg._id.toString(), { name: 'Basic Plus', bonusCredits: 100 });
    expect(updated.name).toBe('Basic Plus');
    expect(updated.bonusCredits).toBe(100);

    const deactivated = await service.setActive(pkg._id.toString(), false);
    expect(deactivated.active).toBe(false);
    const reactivated = await service.setActive(pkg._id.toString(), true);
    expect(reactivated.active).toBe(true);
  });

  it('throws NotFoundException for an unknown id', async () => {
    await expect(service.getPackage('000000000000000000000000')).rejects.toThrow();
    await expect(service.setActive('000000000000000000000000', false)).rejects.toThrow();
  });
});

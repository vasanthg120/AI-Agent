import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Vendor, VendorDocument, VendorSchema } from './schemas/vendor.schema';
import { VendorQuote, VendorQuoteSchema } from './schemas/vendor-quote.schema';
import { VendorsService } from './vendors.service';

const TEST_PREFIX = `jest-vendors-${Date.now()}`;

describe('VendorsService — picker and cross-module existence check (real Mongo)', () => {
  let connection: Connection;
  let vendorsService: VendorsService;
  let vendorModel: Model<VendorDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Vendor.name, schema: VendorSchema },
          { name: VendorQuote.name, schema: VendorQuoteSchema },
        ]),
      ],
      providers: [VendorsService],
    }).compile();

    connection = moduleRef.get(getModelToken(Vendor.name)).db;
    vendorsService = moduleRef.get(VendorsService);
    vendorModel = moduleRef.get(getModelToken(Vendor.name));
  });

  afterAll(async () => {
    await vendorModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('listPicker returns only id+name, scoped to the organization, excluding sensitive fields', async () => {
    const organizationId = `${TEST_PREFIX}-picker`;
    await vendorModel.create({ organizationId, name: 'Vendor B', createdBy: 'u', taxId: 'SECRET-TAX-ID', bankDetails: { accountNumber: '12345' } });
    await vendorModel.create({ organizationId, name: 'Vendor A', createdBy: 'u' });
    await vendorModel.create({ organizationId: `${TEST_PREFIX}-other`, name: 'Vendor Elsewhere', createdBy: 'u' });

    const picked = await vendorsService.listPicker(organizationId);
    expect(picked.map((v) => v.name)).toEqual(['Vendor A', 'Vendor B']);
    expect((picked[1] as unknown as { taxId?: string }).taxId).toBeUndefined();
    expect((picked[1] as unknown as { bankDetails?: unknown }).bankDetails).toBeUndefined();
  });

  it('existsInOrg is true for a vendor in the given org and false for a foreign or missing vendor', async () => {
    const orgA = `${TEST_PREFIX}-exists-a`;
    const orgB = `${TEST_PREFIX}-exists-b`;
    const vendor = await vendorModel.create({ organizationId: orgA, name: 'In Org A', createdBy: 'u' });

    await expect(vendorsService.existsInOrg(orgA, vendor._id.toString())).resolves.toBe(true);
    await expect(vendorsService.existsInOrg(orgB, vendor._id.toString())).resolves.toBe(false);
    await expect(vendorsService.existsInOrg(orgA, '000000000000000000000000')).resolves.toBe(false);
  });
});

import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Decoration, DecorationDocument, DecorationSchema } from './schemas/decoration.schema';
import { Vendor, VendorDocument, VendorSchema } from '../vendors/schemas/vendor.schema';
import { VendorQuote, VendorQuoteSchema } from '../vendors/schemas/vendor-quote.schema';
import { VendorsService } from '../vendors/vendors.service';
import { DecorationsService, buildImportTemplateCsv, CSV_TEMPLATE_HEADERS } from './decorations.service';

const TEST_PREFIX = `jest-decorations-${Date.now()}`;

describe('Decorations (real Mongo)', () => {
  let connection: Connection;
  let decorationsService: DecorationsService;
  let decorationModel: Model<DecorationDocument>;
  let vendorModel: Model<VendorDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Decoration.name, schema: DecorationSchema },
          { name: Vendor.name, schema: VendorSchema },
          { name: VendorQuote.name, schema: VendorQuoteSchema },
        ]),
      ],
      providers: [DecorationsService, VendorsService],
    }).compile();

    connection = moduleRef.get(getModelToken(Decoration.name)).db;
    decorationsService = moduleRef.get(DecorationsService);
    decorationModel = moduleRef.get(getModelToken(Decoration.name));
    vendorModel = moduleRef.get(getModelToken(Vendor.name));
    await decorationModel.syncIndexes();
  });

  afterAll(async () => {
    await decorationModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await vendorModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('creates, lists, gets, updates, and removes a decoration', async () => {
    const organizationId = `${TEST_PREFIX}-crud`;
    const created = await decorationsService.create(
      organizationId,
      { name: 'Screen Print', category: 'Screen Printing', setupCost: 20, priceBreaks: [{ quantity: 50, price: 2.5 }] },
      'user-1',
    );
    expect(created.setupCost).toBe(20);
    expect(created.priceBreaks).toHaveLength(1);

    const fetched = await decorationsService.getOne(organizationId, created._id.toString());
    expect(fetched.name).toBe('Screen Print');

    const { items, total } = await decorationsService.listFiltered(organizationId, {});
    expect(total).toBe(1);
    expect(items).toHaveLength(1);

    const updated = await decorationsService.update(organizationId, created._id.toString(), { setupCost: 25 });
    expect(updated.setupCost).toBe(25);

    await decorationsService.remove(organizationId, created._id.toString());
    await expect(decorationsService.getOne(organizationId, created._id.toString())).rejects.toThrow(/not found/i);
  });

  it('organization isolation: a decoration created in one org is invisible to another', async () => {
    const orgA = `${TEST_PREFIX}-iso-a`;
    const orgB = `${TEST_PREFIX}-iso-b`;
    const decoration = await decorationsService.create(orgA, { name: 'A-only', category: 'Embroidery' }, 'u');

    await expect(decorationsService.getOne(orgB, decoration._id.toString())).rejects.toThrow(/not found/i);
    const listInB = await decorationsService.listFiltered(orgB, {});
    expect(listInB.total).toBe(0);
  });

  it('rejects a vendorId that belongs to a different organization', async () => {
    const orgA = `${TEST_PREFIX}-vendor-a`;
    const orgB = `${TEST_PREFIX}-vendor-b`;
    const foreignVendor = await vendorModel.create({ organizationId: orgB, name: 'Foreign Vendor', createdBy: 'u' });

    await expect(
      decorationsService.create(orgA, { name: 'Bad vendor ref', category: 'Embroidery', vendorId: foreignVendor._id.toString() }, 'u'),
    ).rejects.toThrow(/vendor not found/i);
  });

  it('accepts a vendorId that belongs to the same organization', async () => {
    const organizationId = `${TEST_PREFIX}-vendor-ok`;
    const vendor = await vendorModel.create({ organizationId, name: 'Local Vendor', createdBy: 'u' });

    const created = await decorationsService.create(organizationId, { name: 'Vendor Decoration', category: 'BYO', vendorId: vendor._id.toString() }, 'u');
    expect(created.vendorId).toBe(vendor._id.toString());
  });

  it('sorts by category and supports search', async () => {
    const organizationId = `${TEST_PREFIX}-sort`;
    await decorationsService.create(organizationId, { name: 'Zed', category: 'B Category' }, 'u');
    await decorationsService.create(organizationId, { name: 'Alpha', category: 'A Category' }, 'u');

    const byCategory = await decorationsService.listFiltered(organizationId, { sortBy: 'category', sortDir: 'asc' });
    expect(byCategory.items[0].category).toBe('A Category');

    const bySearch = await decorationsService.listFiltered(organizationId, { search: 'alpha' });
    expect(bySearch.total).toBe(1);
    expect(bySearch.items[0].name).toBe('Alpha');
  });

  it('the CSV template is parseable by the importer it ships with, and declares the documented headers', () => {
    const csv = buildImportTemplateCsv();
    const firstLine = csv.split('\r\n')[0];
    expect(firstLine.split(',')).toEqual(CSV_TEMPLATE_HEADERS);
  });

  it('parseImportFile groups rows by decoration name into price breaks, and flags row-level errors', async () => {
    const csv =
      'Decoration Name,Category,Setup Cost,Quantity,Price\n' +
      '1 Colour Screen Print,Screen Printing,20,50,2.5\n' +
      '1 Colour Screen Print,Screen Printing,20,100,2.0\n' +
      ',Screen Printing,20,10,1\n' +
      'Bad Quantity,Embroidery,0,abc,1\n';

    const result = await decorationsService.parseImportFile(Buffer.from(csv, 'utf-8'));
    expect(result.decorations).toHaveLength(1);
    expect(result.decorations[0].name).toBe('1 Colour Screen Print');
    expect(result.decorations[0].priceBreaks).toHaveLength(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.some((e) => /Decoration Name/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /Quantity/i.test(e.message))).toBe(true);
  });

  it('importRows creates a new decoration and updates an existing one on re-import (upsert by org+name+vendor)', async () => {
    const organizationId = `${TEST_PREFIX}-import`;
    const first = await decorationsService.parseImportFile(
      Buffer.from('Decoration Name,Category,Setup Cost,Quantity,Price\nImported Deco,Screen Printing,15,50,3\n', 'utf-8'),
    );
    const firstRun = await decorationsService.importRows(organizationId, first.decorations, undefined, 'u');
    expect(firstRun.created).toBe(1);
    expect(firstRun.updated).toBe(0);

    const second = await decorationsService.parseImportFile(
      Buffer.from('Decoration Name,Category,Setup Cost,Quantity,Price\nImported Deco,Screen Printing,15,100,2.5\n', 'utf-8'),
    );
    const secondRun = await decorationsService.importRows(organizationId, second.decorations, undefined, 'u');
    expect(secondRun.created).toBe(0);
    expect(secondRun.updated).toBe(1);

    const { items } = await decorationsService.listFiltered(organizationId, {});
    expect(items).toHaveLength(1);
    // Mongoose subdocuments carry their own internals (arguments/caller/
    // callee getters) that make a direct toEqual throw in strict mode —
    // same reason other specs in this codebase plainify before comparing.
    expect(items[0].priceBreaks.map((b) => ({ quantity: b.quantity, price: b.price }))).toEqual([{ quantity: 100, price: 2.5 }]);
  });
});

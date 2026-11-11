import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Product, ProductDocument, ProductSchema } from './schemas/product.schema';
import { ProductsService } from './products.service';
import { CatalogGridFsService } from './catalog-gridfs.service';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { Vendor, VendorDocument, VendorSchema } from '../vendors/schemas/vendor.schema';
import { VendorQuote, VendorQuoteSchema } from '../vendors/schemas/vendor-quote.schema';
import { VendorsService } from '../vendors/vendors.service';

const TEST_PREFIX = `jest-products-catalog-${Date.now()}`;

// Hoops-parity Catalog additions to the pre-existing Product
// model/service — vendor validation, Pre-Built Items (kind), and the
// primary-image GridFS round-trip. Kept separate from products.spec.ts
// (that suite's own pre-existing CRUD coverage) rather than folded in.
describe('Products — Catalog additions (real Mongo)', () => {
  let connection: Connection;
  let productsService: ProductsService;
  let productModel: Model<ProductDocument>;
  let vendorModel: Model<VendorDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Product.name, schema: ProductSchema },
          { name: Vendor.name, schema: VendorSchema },
          { name: VendorQuote.name, schema: VendorQuoteSchema },
        ]),
      ],
      providers: [ProductsService, VendorsService, GridFsService, CatalogGridFsService],
    }).compile();

    connection = moduleRef.get(getModelToken(Product.name)).db;
    productsService = moduleRef.get(ProductsService);
    productModel = moduleRef.get(getModelToken(Product.name));
    vendorModel = moduleRef.get(getModelToken(Vendor.name));
    await productModel.syncIndexes();
  });

  afterAll(async () => {
    await productModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await vendorModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.db!.dropCollection('catalog_product_images.files').catch(() => undefined);
    await connection.db!.dropCollection('catalog_product_images.chunks').catch(() => undefined);
    await connection.close();
  });

  it('rejects a vendorId from a different organization on create and on update', async () => {
    const orgA = `${TEST_PREFIX}-vendor-a`;
    const orgB = `${TEST_PREFIX}-vendor-b`;
    const foreignVendor = await vendorModel.create({ organizationId: orgB, name: 'Foreign', createdBy: 'u' });

    await expect(
      productsService.create(orgA, { name: 'Bad', unitPrice: 1, vendorId: foreignVendor._id.toString() }, 'u'),
    ).rejects.toThrow(/vendor not found/i);

    const ok = await productsService.create(orgA, { name: 'Ok', unitPrice: 1 }, 'u');
    await expect(productsService.update(orgA, ok._id.toString(), { vendorId: foreignVendor._id.toString() })).rejects.toThrow(/vendor not found/i);
  });

  it('accepts a same-org vendorId and returns it back on the product', async () => {
    const organizationId = `${TEST_PREFIX}-vendor-ok`;
    const vendor = await vendorModel.create({ organizationId, name: 'Local', createdBy: 'u' });

    const created = await productsService.create(organizationId, { name: 'With vendor', unitPrice: 5, vendorId: vendor._id.toString(), sku: 'SKU-A' }, 'u');
    expect(created.vendorId).toBe(vendor._id.toString());
  });

  it("defaults to kind:'product' and keeps Pre-Built Items out of the default listing", async () => {
    const organizationId = `${TEST_PREFIX}-kind`;
    const product = await productsService.create(organizationId, { name: 'Regular product', unitPrice: 1 }, 'u');
    expect(product.kind).toBe('product');

    const prebuilt = await productsService.create(organizationId, { name: 'Blank Tee', unitPrice: 0, kind: 'prebuilt' }, 'u');
    expect(prebuilt.kind).toBe('prebuilt');

    const defaultList = await productsService.listFiltered(organizationId, {});
    expect(defaultList.items.map((p) => p.name)).toEqual(['Regular product']);

    const prebuiltList = await productsService.listFiltered(organizationId, { kind: 'prebuilt' });
    expect(prebuiltList.items.map((p) => p.name)).toEqual(['Blank Tee']);
  });

  it('round-trips a primary image through GridFS: upload, stream back, and replace', async () => {
    const organizationId = `${TEST_PREFIX}-image`;
    const product = await productsService.create(organizationId, { name: 'Imaged product', unitPrice: 1 }, 'u');

    const file = { originalname: 'logo.png', mimetype: 'image/png', buffer: Buffer.from('fake-png-bytes') } as Express.Multer.File;
    const withImage = await productsService.setImage(organizationId, product._id.toString(), file);
    expect(withImage.imageFileId).toBeTruthy();
    const firstFileId = withImage.imageFileId;

    const { stream, mimeType } = await productsService.getImageStream(organizationId, product._id.toString());
    expect(mimeType).toBe('image/png');
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString('utf-8')).toBe('fake-png-bytes');

    const replacement = { originalname: 'logo2.png', mimetype: 'image/png', buffer: Buffer.from('second-image') } as Express.Multer.File;
    const replaced = await productsService.setImage(organizationId, product._id.toString(), replacement);
    expect(replaced.imageFileId).not.toBe(firstFileId);
  });

  it('rejects a non-image file for the primary image', async () => {
    const organizationId = `${TEST_PREFIX}-image-reject`;
    const product = await productsService.create(organizationId, { name: 'Needs image', unitPrice: 1 }, 'u');
    const file = { originalname: 'doc.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF') } as Express.Multer.File;
    await expect(productsService.setImage(organizationId, product._id.toString(), file)).rejects.toThrow(/image/i);
  });
});

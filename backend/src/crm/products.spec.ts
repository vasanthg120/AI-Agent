import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Product, ProductDocument, ProductSchema } from './schemas/product.schema';
import { ProductsService } from './products.service';

const TEST_PREFIX = `jest-products-${Date.now()}`;

describe('Products (real Mongo)', () => {
  let connection: Connection;
  let productsService: ProductsService;
  let productModel: Model<ProductDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: Product.name, schema: ProductSchema }])],
      providers: [ProductsService],
    }).compile();

    connection = moduleRef.get(getModelToken(Product.name)).db;
    productsService = moduleRef.get(ProductsService);
    productModel = moduleRef.get(getModelToken(Product.name));
    await productModel.syncIndexes();
  });

  afterAll(async () => {
    await productModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('creates, lists, gets, updates, activates, and deactivates a product', async () => {
    const organizationId = `${TEST_PREFIX}-crud`;
    const created = await productsService.create(organizationId, { name: 'Widget', unitPrice: 25 }, 'user-1');
    expect(created.isActive).toBe(true);
    expect(created.createdBy).toBe('user-1');

    const fetched = await productsService.getOne(organizationId, created._id.toString());
    expect(fetched.name).toBe('Widget');

    const { items, total } = await productsService.listFiltered(organizationId, {});
    expect(total).toBe(1);
    expect(items).toHaveLength(1);

    const updated = await productsService.update(organizationId, created._id.toString(), { unitPrice: 30 });
    expect(updated.unitPrice).toBe(30);

    const deactivated = await productsService.setActive(organizationId, created._id.toString(), false);
    expect(deactivated.isActive).toBe(false);
    const reactivated = await productsService.setActive(organizationId, created._id.toString(), true);
    expect(reactivated.isActive).toBe(true);
  });

  it('search filters by name and isActive filters correctly', async () => {
    const organizationId = `${TEST_PREFIX}-search`;
    await productsService.create(organizationId, { name: 'Blue Widget', unitPrice: 10 }, 'u');
    await productsService.create(organizationId, { name: 'Red Gadget', unitPrice: 20, isActive: false }, 'u');

    const byName = await productsService.listFiltered(organizationId, { search: 'widget' });
    expect(byName.total).toBe(1);
    expect(byName.items[0].name).toBe('Blue Widget');

    const activeOnly = await productsService.listFiltered(organizationId, { isActive: true });
    expect(activeOnly.total).toBe(1);
  });

  it('organization isolation: a product created in one org is invisible to another', async () => {
    const orgA = `${TEST_PREFIX}-iso-a`;
    const orgB = `${TEST_PREFIX}-iso-b`;
    const product = await productsService.create(orgA, { name: 'A-only', unitPrice: 5 }, 'u');

    await expect(productsService.getOne(orgB, product._id.toString())).rejects.toThrow(/not found/i);
    const listInB = await productsService.listFiltered(orgB, {});
    expect(listInB.total).toBe(0);
  });

  it('the partial unique sku index allows multiple sku-less products but rejects a duplicate sku within the same org', async () => {
    const organizationId = `${TEST_PREFIX}-sku`;
    await productsService.create(organizationId, { name: 'No SKU 1', unitPrice: 1 }, 'u');
    await productsService.create(organizationId, { name: 'No SKU 2', unitPrice: 1 }, 'u');
    await productsService.create(organizationId, { name: 'Has SKU', unitPrice: 1, sku: 'SKU-1' }, 'u');

    await expect(productsService.create(organizationId, { name: 'Duplicate SKU', unitPrice: 1, sku: 'SKU-1' }, 'u')).rejects.toThrow();
  });
});

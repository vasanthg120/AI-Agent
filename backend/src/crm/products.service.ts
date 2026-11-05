import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { VendorsService } from '../vendors/vendors.service';
import { CatalogGridFsService } from './catalog-gridfs.service';

// The product/service master Quote line items reference. Started minimal
// (no inventory/warehouse/vendor logic); Hoops-parity Catalog added the
// vendor/image/sizes/colors/kind fields below (all optional — see
// product.schema.ts's own comment on why that's safe for every existing
// consumer). Mirrors DealsService's exact CRUD shape/org-scoping.
@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    private vendorsService: VendorsService,
    private catalogGridFs: CatalogGridFsService,
  ) {}

  private async assertVendorInOrg(organizationId: string, vendorId: string | undefined): Promise<void> {
    if (!vendorId) return;
    const exists = await this.vendorsService.existsInOrg(organizationId, vendorId);
    if (!exists) throw new BadRequestException('Vendor not found in this organization.');
  }

  async listFiltered(
    organizationId: string,
    query: ListProductsQueryDto,
  ): Promise<{ items: ProductDocument[]; total: number; page: number; pageSize: number }> {
    const match: FilterQuery<Product> = { organizationId, kind: query.kind ?? 'product' };
    if (query.search) match.name = { $regex: query.search, $options: 'i' };
    if (query.isActive !== undefined) match.isActive = query.isActive;
    if (query.vendorId) match.vendorId = query.vendorId;

    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 100);
    const [items, total] = await Promise.all([
      this.productModel
        .find(match)
        .sort({ name: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.productModel.countDocuments(match).exec(),
    ]);
    return { items, total, page, pageSize };
  }

  async getOne(organizationId: string, id: string): Promise<ProductDocument> {
    const product = await this.productModel.findOne({ _id: id, organizationId }).exec();
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async create(organizationId: string, dto: CreateProductDto, createdBy: string): Promise<ProductDocument> {
    await this.assertVendorInOrg(organizationId, dto.vendorId);
    return this.productModel.create({ organizationId, ...dto, createdBy });
  }

  async update(organizationId: string, id: string, dto: UpdateProductDto): Promise<ProductDocument> {
    await this.assertVendorInOrg(organizationId, dto.vendorId);
    const updated = await this.productModel.findOneAndUpdate({ _id: id, organizationId }, { $set: dto }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Product not found');
    return updated;
  }

  async setActive(organizationId: string, id: string, isActive: boolean): Promise<ProductDocument> {
    const updated = await this.productModel.findOneAndUpdate({ _id: id, organizationId }, { $set: { isActive } }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Product not found');
    return updated;
  }

  async setImage(organizationId: string, id: string, file: Express.Multer.File): Promise<ProductDocument> {
    const product = await this.getOne(organizationId, id);
    if (!file.mimetype.startsWith('image/')) throw new BadRequestException('Primary Image must be an image file.');
    const previousFileId = product.imageFileId;
    const fileId = await this.catalogGridFs.upload(file.originalname, file.buffer, { organizationId, productId: id });
    product.imageFileId = fileId;
    product.imageMimeType = file.mimetype;
    await product.save();
    if (previousFileId) await this.catalogGridFs.delete(previousFileId).catch(() => undefined);
    return product;
  }

  async getImageStream(
    organizationId: string,
    id: string,
  ): Promise<{ stream: NodeJS.ReadableStream; filename: string; mimeType: string }> {
    const product = await this.getOne(organizationId, id);
    if (!product.imageFileId) throw new NotFoundException('This product has no image.');
    return {
      stream: this.catalogGridFs.openDownloadStream(product.imageFileId),
      filename: product.name,
      mimeType: product.imageMimeType ?? 'application/octet-stream',
    };
  }
}

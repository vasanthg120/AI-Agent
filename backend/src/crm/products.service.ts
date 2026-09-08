import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';

// The minimal product/service master Quote line items reference — no
// inventory/warehouse/vendor logic, matching the request's explicit "do not
// build" list. Mirrors DealsService's exact CRUD shape/org-scoping.
@Injectable()
export class ProductsService {
  constructor(@InjectModel(Product.name) private productModel: Model<ProductDocument>) {}

  async listFiltered(
    organizationId: string,
    query: ListProductsQueryDto,
  ): Promise<{ items: ProductDocument[]; total: number; page: number; pageSize: number }> {
    const match: FilterQuery<Product> = { organizationId };
    if (query.search) match.name = { $regex: query.search, $options: 'i' };
    if (query.isActive !== undefined) match.isActive = query.isActive;

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

  create(organizationId: string, dto: CreateProductDto, createdBy: string): Promise<ProductDocument> {
    return this.productModel.create({ organizationId, ...dto, createdBy });
  }

  async update(organizationId: string, id: string, dto: UpdateProductDto): Promise<ProductDocument> {
    const updated = await this.productModel.findOneAndUpdate({ _id: id, organizationId }, { $set: dto }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Product not found');
    return updated;
  }

  async setActive(organizationId: string, id: string, isActive: boolean): Promise<ProductDocument> {
    const updated = await this.productModel.findOneAndUpdate({ _id: id, organizationId }, { $set: { isActive } }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Product not found');
    return updated;
  }
}

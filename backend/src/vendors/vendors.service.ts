import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import { CreateVendorQuoteDto } from './dto/create-vendor-quote.dto';
import { UpdateVendorQuoteDto } from './dto/update-vendor-quote.dto';
import { ListVendorQuotesQueryDto } from './dto/list-vendor-quotes-query.dto';
import { Vendor, VendorDocument } from './schemas/vendor.schema';
import { VendorQuote, VendorQuoteDocument } from './schemas/vendor-quote.schema';

@Injectable()
export class VendorsService {
  constructor(
    @InjectModel(Vendor.name) private vendorModel: Model<VendorDocument>,
    @InjectModel(VendorQuote.name) private vendorQuoteModel: Model<VendorQuoteDocument>,
  ) {}

  listVendors(organizationId: string) {
    return this.vendorModel.find({ organizationId }).sort({ name: 1 }).exec();
  }

  // Name-only projection for pickers outside Vendors' own owner/admin-only
  // screens (Hoops-parity Catalog's Vendor fields) — deliberately excludes
  // bankDetails/taxId/contactName/etc, the data this module exists to keep
  // more sensitive than Products' own manager/consultant-reachable tier.
  listPicker(organizationId: string) {
    return this.vendorModel.find({ organizationId }, 'name').sort({ name: 1 }).exec();
  }

  // Cross-module existence check (CrmModule's Product/Decoration vendorId
  // validation) — exposed through VendorsService rather than exporting the
  // Vendor Mongoose model itself, so VendorsModule's own
  // MongooseModule.forFeature registration stays its sole owner.
  async existsInOrg(organizationId: string, vendorId: string): Promise<boolean> {
    return (await this.vendorModel.exists({ _id: vendorId, organizationId })) !== null;
  }

  async getVendor(organizationId: string, id: string) {
    const vendor = await this.vendorModel.findOne({ _id: id, organizationId }).exec();
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  createVendor(organizationId: string, dto: CreateVendorDto, createdBy: string) {
    return this.vendorModel.create({ ...dto, organizationId, createdBy });
  }

  async updateVendor(organizationId: string, id: string, dto: UpdateVendorDto) {
    const updated = await this.vendorModel.findOneAndUpdate({ _id: id, organizationId }, dto, { new: true }).exec();
    if (!updated) throw new NotFoundException('Vendor not found');
    return updated;
  }

  listVendorQuotes(organizationId: string, query: ListVendorQuotesQueryDto) {
    const match: Record<string, unknown> = { organizationId };
    if (query.vendorId) match.vendorId = query.vendorId;
    if (query.dealId) match.dealId = query.dealId;
    if (query.quoteId) match.quoteId = query.quoteId;
    return this.vendorQuoteModel.find(match).sort({ quoteDate: -1 }).exec();
  }

  createVendorQuote(organizationId: string, dto: CreateVendorQuoteDto, createdBy: string) {
    return this.vendorQuoteModel.create({ ...dto, organizationId, createdBy });
  }

  async updateVendorQuote(organizationId: string, id: string, dto: UpdateVendorQuoteDto) {
    const update: Record<string, unknown> = { ...dto };
    if (dto.status === 'accepted') update.acceptedAt = new Date();
    const updated = await this.vendorQuoteModel.findOneAndUpdate({ _id: id, organizationId }, update, { new: true }).exec();
    if (!updated) throw new NotFoundException('Vendor quote not found');
    return updated;
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Workbook } from 'exceljs';
import { FilterQuery, Model } from 'mongoose';
import { Readable } from 'stream';
import { Decoration, DecorationDocument } from './schemas/decoration.schema';
import { CreateDecorationDto } from './dto/create-decoration.dto';
import { UpdateDecorationDto } from './dto/update-decoration.dto';
import { ListDecorationsQueryDto } from './dto/list-decorations-query.dto';
import { VendorsService } from '../vendors/vendors.service';

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportDecorationDraft {
  name: string;
  category: string;
  setupCost: number;
  priceBreaks: { quantity: number; price: number }[];
  rows: number[];
}

export interface ImportPreviewResult {
  decorations: ImportDecorationDraft[];
  errors: ImportRowError[];
}

// CSV_TEMPLATE_HEADERS and the import parser below are the one schema — the
// template download and the importer are generated from, and read against,
// this exact column order, so they can never drift apart (the spec's own
// "template and importer must share the same schema" requirement). One row
// per price break; rows sharing the same Decoration Name are grouped into
// one Decoration with multiple price breaks — matches the Quantity/Price
// repeating-row editor the Add Decoration form itself uses.
export const CSV_TEMPLATE_HEADERS = ['Decoration Name', 'Category', 'Setup Cost', 'Quantity', 'Price'];
const CSV_TEMPLATE_EXAMPLE_ROWS = [
  ['1 Colour Screen Print', 'Screen Printing', '20', '50', '2.50'],
  ['1 Colour Screen Print', 'Screen Printing', '20', '100', '2.00'],
  ['Embroidery - Left Chest', 'Embroidery', '15', '20', '4.00'],
];

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildImportTemplateCsv(): string {
  const lines = [CSV_TEMPLATE_HEADERS, ...CSV_TEMPLATE_EXAMPLE_ROWS];
  return lines.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// Hoops-parity Catalog — the decoration CRUD + CSV import behind the
// "Add to Catalog" dropdown. Same org-scoping/vendor-validation shape as
// ProductsService/quotes.service.ts's productId check.
@Injectable()
export class DecorationsService {
  constructor(
    @InjectModel(Decoration.name) private decorationModel: Model<DecorationDocument>,
    private vendorsService: VendorsService,
  ) {}

  private async assertVendorInOrg(organizationId: string, vendorId: string | undefined): Promise<void> {
    if (!vendorId) return;
    const exists = await this.vendorsService.existsInOrg(organizationId, vendorId);
    if (!exists) throw new BadRequestException('Vendor not found in this organization.');
  }

  async listFiltered(
    organizationId: string,
    query: ListDecorationsQueryDto,
  ): Promise<{ items: DecorationDocument[]; total: number; page: number; pageSize: number }> {
    const match: FilterQuery<Decoration> = { organizationId };
    if (query.search) match.name = { $regex: query.search, $options: 'i' };
    if (query.vendorId) match.vendorId = query.vendorId;
    if (query.category) match.category = query.category;

    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 100);
    const sortKey = query.sortBy ?? 'name';
    const sortDir = query.sortDir === 'desc' ? -1 : 1;

    const [items, total] = await Promise.all([
      this.decorationModel
        .find(match)
        .sort({ [sortKey]: sortDir })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.decorationModel.countDocuments(match).exec(),
    ]);
    return { items, total, page, pageSize };
  }

  async getOne(organizationId: string, id: string): Promise<DecorationDocument> {
    const decoration = await this.decorationModel.findOne({ _id: id, organizationId }).exec();
    if (!decoration) throw new NotFoundException('Decoration not found');
    return decoration;
  }

  async create(organizationId: string, dto: CreateDecorationDto, createdBy: string): Promise<DecorationDocument> {
    await this.assertVendorInOrg(organizationId, dto.vendorId);
    return this.decorationModel.create({ organizationId, ...dto, createdBy });
  }

  async update(organizationId: string, id: string, dto: UpdateDecorationDto): Promise<DecorationDocument> {
    await this.assertVendorInOrg(organizationId, dto.vendorId);
    const updated = await this.decorationModel.findOneAndUpdate({ _id: id, organizationId }, { $set: dto }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Decoration not found');
    return updated;
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const deleted = await this.decorationModel.findOneAndDelete({ _id: id, organizationId }).exec();
    if (!deleted) throw new NotFoundException('Decoration not found');
  }

  // Shared by the preview and commit routes — parses the CSV against
  // CSV_TEMPLATE_HEADERS, groups rows by Decoration Name, and returns both
  // the drafts that are clean enough to save and every row-level error
  // found along the way. Never writes to the database itself.
  async parseImportFile(buffer: Buffer): Promise<ImportPreviewResult> {
    const workbook = new Workbook();
    let worksheet;
    try {
      worksheet = await workbook.csv.read(Readable.from(buffer));
    } catch {
      throw new BadRequestException('Could not read this file as CSV.');
    }

    const errors: ImportRowError[] = [];
    const byName = new Map<string, ImportDecorationDraft>();
    let headerSeen = false;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = row.values as unknown[];
      const name = String(values[1] ?? '').trim();
      const category = String(values[2] ?? '').trim();
      const setupCostRaw = values[3];
      const quantityRaw = values[4];
      const priceRaw = values[5];

      if (!headerSeen) {
        headerSeen = true;
        // Tolerate a header row whether or not it matches exactly — only
        // skip it if the first cell looks like the template's own label,
        // not a real decoration name a customer happened to type.
        if (name.toLowerCase() === CSV_TEMPLATE_HEADERS[0].toLowerCase()) return;
      }

      if (!name) {
        errors.push({ row: rowNumber, message: 'Decoration Name is required.' });
        return;
      }

      const quantity = typeof quantityRaw === 'number' ? quantityRaw : Number(quantityRaw);
      const price = typeof priceRaw === 'number' ? priceRaw : Number(priceRaw);
      const setupCost = setupCostRaw === undefined || setupCostRaw === null || setupCostRaw === '' ? undefined : Number(setupCostRaw);

      if (!category) {
        errors.push({ row: rowNumber, message: `Category is required for "${name}".` });
        return;
      }
      if (!Number.isFinite(quantity) || quantity < 1) {
        errors.push({ row: rowNumber, message: `Quantity must be a positive number for "${name}".` });
        return;
      }
      if (!Number.isFinite(price) || price < 0) {
        errors.push({ row: rowNumber, message: `Price must be a non-negative number for "${name}".` });
        return;
      }
      if (setupCost !== undefined && (!Number.isFinite(setupCost) || setupCost < 0)) {
        errors.push({ row: rowNumber, message: `Setup Cost must be a non-negative number for "${name}".` });
        return;
      }

      const existing = byName.get(name);
      if (existing) {
        existing.priceBreaks.push({ quantity, price });
        existing.rows.push(rowNumber);
        if (existing.category === '' && category) existing.category = category;
      } else {
        byName.set(name, { name, category, setupCost: setupCost ?? 0, priceBreaks: [{ quantity, price }], rows: [rowNumber] });
      }
    });

    return { decorations: Array.from(byName.values()), errors };
  }

  // Commits a parsed import: upserts each draft by (organizationId, name,
  // vendorId) — "If we find any decoration names within your CSV that
  // already exist, we'll update the information to match your CSV",
  // matching Hoops' own Step 3 note exactly.
  async importRows(
    organizationId: string,
    drafts: ImportDecorationDraft[],
    vendorId: string | undefined,
    createdBy: string,
  ): Promise<{ created: number; updated: number }> {
    await this.assertVendorInOrg(organizationId, vendorId);
    let created = 0;
    let updated = 0;
    for (const draft of drafts) {
      const match: FilterQuery<Decoration> = { organizationId, name: draft.name, vendorId: vendorId ?? { $exists: false } };
      // includeResultMetadata (not the older rawResult name) is Mongoose 8's
      // spelling for this — see wallet.service.ts's getOrCreateWallet for
      // the same upsert-detection idiom this codebase already established.
      const result = (await this.decorationModel
        .findOneAndUpdate(
          match,
          {
            $set: { category: draft.category, setupCost: draft.setupCost, priceBreaks: draft.priceBreaks, vendorId },
            $setOnInsert: { organizationId, name: draft.name, createdBy },
          },
          { upsert: true, new: false, includeResultMetadata: true },
        )
        .exec()) as unknown as { lastErrorObject?: { updatedExisting?: boolean } };
      if (result.lastErrorObject?.updatedExisting) updated++;
      else created++;
    }
    return { created, updated };
  }
}

import { FileInterceptor } from '@nestjs/platform-express';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import PDFDocument from 'pdfkit';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { FinanceExportQueryDto } from './dto/finance-export-query.dto';
import { FinanceListQueryDto } from './dto/finance-list-query.dto';
import { LinkCustomerQuoteDto } from './dto/link-customer-quote.dto';
import { UpdateFinanceDocumentDto } from './dto/update-finance-document.dto';
import { FinanceDocumentsService } from './finance-documents.service';
import { FinanceExportService } from './finance-export.service';

const EXPORT_ROW_CAP = 5000;

// Owner/admin only — vendor bank details and payment amounts are more
// sensitive than deal pipeline data, and Finance is org-wide with no store
// scoping, so managers have no narrower fallback view (see Phase 10a plan
// notes — mirrors Command Center's "hide from everyone except owner/admin"
// precedent for the same "sensitive, org-wide" reasoning).
//
// Route order matters: 'query'/'export' are static segments and must be
// registered before ':id', same rule documented in crm/deals.controller.ts.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Controller('finance/documents')
export class FinanceDocumentsController {
  constructor(
    private financeDocumentsService: FinanceDocumentsService,
    private financeExportService: FinanceExportService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  upload(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File) {
    return this.financeDocumentsService.upload(user.organizationId, user.sub, file);
  }

  @Get('query')
  listFiltered(@CurrentUser() user: JwtPayload, @Query() query: FinanceListQueryDto) {
    return this.financeDocumentsService.listFiltered(user.organizationId, query);
  }

  @Get('export')
  async export(@CurrentUser() user: JwtPayload, @Query() query: FinanceExportQueryDto, @Res() res: Response) {
    const { items, truncated } = await this.financeDocumentsService.listForExport(user.organizationId, query, EXPORT_ROW_CAP);
    const rows = this.financeExportService.buildRows(items);
    if (truncated) res.set('X-Export-Truncated', 'true');
    const filenameDate = query.dateFrom ?? 'all-time';

    if (query.format === 'csv') {
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="finance-${filenameDate}.csv"`,
      });
      res.send(this.financeExportService.toCsv(rows));
      return;
    }

    if (query.format === 'xlsx') {
      const buffer = await this.financeExportService.toExcel(rows);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="finance-${filenameDate}.xlsx"`,
      });
      res.send(buffer);
      return;
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="finance-${filenameDate}.pdf"`,
    });
    const doc = new PDFDocument();
    doc.pipe(res);
    this.financeExportService.writePdf(doc, rows, query);
    doc.end();
  }

  // Static segment, must be registered before ':id' — same rule as
  // 'query'/'export' above.
  @Get('quote-lookup')
  searchCustomerQuote(@CurrentUser() user: JwtPayload, @Query('quoteNumber') quoteNumber?: string) {
    if (!quoteNumber?.trim()) throw new BadRequestException('quoteNumber is required');
    return this.financeDocumentsService.searchCustomerQuotes(user.organizationId, quoteNumber);
  }

  @Get(':id')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.financeDocumentsService.findOne(id, user.organizationId);
  }

  @Get(':id/file')
  async getFile(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Res() res: Response) {
    const { stream, doc } = await this.financeDocumentsService.getFileStream(id, user.organizationId);
    res.set({
      'Content-Type': doc.mimeType,
      'Content-Disposition': `inline; filename="${doc.originalFilename}"`,
    });
    stream.pipe(res);
  }

  @Patch(':id')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateFinanceDocumentDto) {
    return this.financeDocumentsService.update(id, user.organizationId, user.sub, dto);
  }

  @Post(':id/retry-extraction')
  retryExtraction(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.financeDocumentsService.retryExtraction(id, user.organizationId, user.sub);
  }

  @Post(':id/link-quote')
  linkCustomerQuote(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: LinkCustomerQuoteDto) {
    return this.financeDocumentsService.linkCustomerQuote(id, user.organizationId, dto.quoteId);
  }

  @Delete(':id')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.financeDocumentsService.remove(id, user.organizationId);
  }
}

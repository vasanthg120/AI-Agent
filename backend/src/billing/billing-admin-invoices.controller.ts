import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import PDFDocument from 'pdfkit';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingAdminInvoicesService } from './billing-admin-invoices.service';
import { BillingInvoicePdfService } from './billing-invoice-pdf.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { VoidInvoiceDto } from './dto/void-invoice.dto';

// Phase 4 admin surface — platform_admin only, matching every other
// billing-admin-*.controller.ts's gate. Unlike the customer-facing
// GET /billing/invoices (org-scoped), this sees every organization's
// invoices — never reachable from a customer-scoped route.
@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/invoices')
export class BillingAdminInvoicesController {
  constructor(
    private adminInvoicesService: BillingAdminInvoicesService,
    private invoiceService: BillingInvoiceService,
    private invoicePdfService: BillingInvoicePdfService,
  ) {}

  @Get()
  list(@Query('organizationId') organizationId?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.adminInvoicesService.list({ organizationId, status, limit: limit ? Number.parseInt(limit, 10) : undefined });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.adminInvoicesService.get(id);
  }

  @Post(':id/void')
  voidInvoice(@Param('id') id: string, @Body() dto: VoidInvoiceDto) {
    return this.adminInvoicesService.voidInvoice(id, dto.reason);
  }

  @Get(':id/pdf')
  async pdf(@Param('id') id: string, @Res() res: Response) {
    const invoice = await this.adminInvoicesService.get(id);
    const template = await this.invoiceService.getDefaultTemplate();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}.pdf"`,
    });
    const doc = new PDFDocument();
    doc.pipe(res);
    this.invoicePdfService.writePdf(doc, invoice, template);
    doc.end();
  }

  @Get(':id/csv')
  async csv(@Param('id') id: string, @Res() res: Response) {
    const invoice = await this.adminInvoicesService.get(id);
    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}.csv"`,
    });
    res.send(this.invoiceService.toCsv(invoice));
  }
}

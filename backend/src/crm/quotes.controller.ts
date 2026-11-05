import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { ListQuotesQueryDto } from './dto/list-quotes-query.dto';
import { UpdateQuoteDto } from './dto/update-quote.dto';
import { RecordQuotePaymentDto } from './dto/record-quote-payment.dto';
import { VoidQuotePaymentDto } from './dto/void-quote-payment.dto';
import { SetQuoteArchivedDto } from './dto/set-quote-archived.dto';
import { QuotesService } from './quotes.service';
import { QuotePaymentsService } from './quote-payments.service';
import { QuoteDocumentsService } from './quote-documents.service';
import { CustomerJobsService } from '../customer-intelligence/customer-jobs.service';

// Phase 19 — the Unified Analytics Dashboard's quote drill-down. Same
// role/scope shape as DealsController's own /query route: owner/admin see
// the whole org, manager is store-constrained (via the linked deal),
// consultant is self-constrained (via the linked deal's ownerId) —
// server-forced, never client-supplied.
//
// Route order matters: 'query' is a static segment and must be registered
// before ':id', same rule deals.controller.ts's own comment documents.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('crm/quotes')
export class QuotesController {
  constructor(
    private quotesService: QuotesService,
    private quotePaymentsService: QuotePaymentsService,
    private quoteDocumentsService: QuoteDocumentsService,
    private customerJobsService: CustomerJobsService,
  ) {}

  @Get('query')
  @Roles('owner', 'admin', 'manager', 'consultant')
  listFiltered(@CurrentUser() user: JwtPayload, @Query() query: ListQuotesQueryDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    // Owner/admin may optionally narrow to one store (matches the dashboard's
    // own store-select override); a manager's store is always server-forced.
    const storeConstraint = canOverride ? query.storeId : user.roles.includes('manager') ? user.storeId : undefined;
    const ownerConstraint = !canOverride && user.roles.includes('consultant') ? user.sub : undefined;
    return this.quotesService.listFiltered(user.organizationId, query, storeConstraint, ownerConstraint);
  }

  // SalesBoard's "Job #" column — one batch lookup per table page. Static
  // segment, must be registered before ':id' — same rule as 'query' above.
  @Get('job-numbers')
  @Roles('owner', 'admin', 'manager', 'consultant')
  jobNumbers(@CurrentUser() user: JwtPayload, @Query('ids') ids?: string) {
    const quotationIds = (ids ?? '').split(',').filter(Boolean);
    return this.customerJobsService.findJobNumbersByQuotationIds(user.organizationId, quotationIds);
  }

  // The first native "build a priced quote" entry point this app has had —
  // same write tier (owner/admin/manager, consultant excluded) as every
  // other mutation route below.
  @Post()
  @Roles('owner', 'admin', 'manager')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateQuoteDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotesService.createQuote(user.organizationId, dto, user.sub, storeConstraint);
  }

  // Section 7 (Business Intelligence: Customer Quote & Payment Tracking) —
  // the first genuinely writable path this app has for Quote (see plan
  // finding #3). Consultant is deliberately excluded from every write route
  // below — read-only for that role, matching the plan's own RBAC table.
  @Patch(':id')
  @Roles('owner', 'admin', 'manager')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateQuoteDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotesService.updateQuote(user.organizationId, id, dto, storeConstraint);
  }

  @Get(':id')
  @Roles('owner', 'admin', 'manager', 'consultant')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = !canOverride && user.roles.includes('manager') ? user.storeId : undefined;
    const ownerConstraint = !canOverride && user.roles.includes('consultant') ? user.sub : undefined;
    return this.quotesService.getOne(user.organizationId, id, storeConstraint, ownerConstraint);
  }

  @Post(':id/payments')
  @Roles('owner', 'admin', 'manager')
  recordPayment(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: RecordQuotePaymentDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotePaymentsService.recordPayment(user.organizationId, id, dto, user.sub, storeConstraint);
  }

  @Get(':id/payments')
  @Roles('owner', 'admin', 'manager', 'consultant')
  listPayments(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = !canOverride && user.roles.includes('manager') ? user.storeId : undefined;
    const ownerConstraint = !canOverride && user.roles.includes('consultant') ? user.sub : undefined;
    return this.quotePaymentsService.listPayments(user.organizationId, id, storeConstraint, ownerConstraint);
  }

  // Corrections never hard-delete a financial record — void only, same
  // ethos as quote-payment.schema.ts's own comment.
  @Post(':id/payments/:paymentId/void')
  @Roles('owner', 'admin', 'manager')
  voidPayment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: VoidQuotePaymentDto,
  ) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotePaymentsService.voidPayment(user.organizationId, id, paymentId, user.sub, dto.reason, storeConstraint);
  }

  // --- Hoops-parity SalesBoard record actions (Phase 5, additive) ---

  @Post(':id/duplicate')
  @Roles('owner', 'admin', 'manager')
  duplicate(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotesService.duplicateQuote(user.organizationId, id, user.sub, storeConstraint);
  }

  @Post(':id/archive')
  @Roles('owner', 'admin', 'manager')
  archive(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetQuoteArchivedDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotesService.setArchived(user.organizationId, id, dto.archived, storeConstraint);
  }

  // Real delete — owner/admin only (narrower than every other write route
  // above, which also allow manager): a destructive, irreversible action
  // gets the tightest tier this app has, matching the plan's own RBAC
  // convention for anything that isn't archive-reversible.
  @Delete(':id')
  @Roles('owner', 'admin')
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.quotesService.deleteQuote(user.organizationId, id);
    return { deleted: true };
  }

  @Post(':id/send')
  @Roles('owner', 'admin', 'manager')
  sendQuote(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quoteDocumentsService.sendQuote(user.organizationId, id, storeConstraint);
  }

  @Post(':id/guest-link')
  @Roles('owner', 'admin', 'manager')
  async guestLink(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    const token = await this.quotesService.ensureGuestViewToken(user.organizationId, id, storeConstraint);
    return { token };
  }

  @Get(':id/pdf')
  @Roles('owner', 'admin', 'manager', 'consultant')
  async getPdf(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Res() res: Response) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = !canOverride && user.roles.includes('manager') ? user.storeId : undefined;
    const ownerConstraint = !canOverride && user.roles.includes('consultant') ? user.sub : undefined;
    const { buffer, filename } = await this.quoteDocumentsService.getQuotePdf(user.organizationId, id, storeConstraint, ownerConstraint);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(buffer);
  }

  @Post(':id/reference')
  @Roles('owner', 'admin', 'manager')
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  setReferenceFile(@CurrentUser() user: JwtPayload, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotesService.setReferenceFile(user.organizationId, id, file, storeConstraint);
  }

  @Get(':id/reference')
  @Roles('owner', 'admin', 'manager', 'consultant')
  async getReferenceFile(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Res() res: Response) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = !canOverride && user.roles.includes('manager') ? user.storeId : undefined;
    const ownerConstraint = !canOverride && user.roles.includes('consultant') ? user.sub : undefined;
    const { stream, filename, mimeType } = await this.quotesService.getReferenceFileStream(user.organizationId, id, storeConstraint, ownerConstraint);
    res.set({ 'Content-Type': mimeType, 'Content-Disposition': `inline; filename="${filename}"` });
    stream.pipe(res);
  }

  @Get(':id/invoice-pdf')
  @Roles('owner', 'admin', 'manager', 'consultant')
  async getInvoicePdf(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Res() res: Response) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = !canOverride && user.roles.includes('manager') ? user.storeId : undefined;
    const ownerConstraint = !canOverride && user.roles.includes('consultant') ? user.sub : undefined;
    const { buffer, filename } = await this.quoteDocumentsService.getInvoicePdf(user.organizationId, id, storeConstraint, ownerConstraint);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(buffer);
  }
}

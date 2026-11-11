import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Feature } from '../common/app-features';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { CustomerJobDocumentsService, JobDocumentKind } from './customer-job-documents.service';
import { CustomerJobsService } from './customer-jobs.service';
import {
  ConvertQuotationDto,
  CreateCreditDto,
  CreatePurchaseOrderDto,
  CreateShipmentDto,
  SetJobItemStatusDto,
  SetJobStatusDto,
  SetJobVoidedDto,
  SetProofDto,
  UpdateCreditDto,
  UpdateJobDto,
  UpdatePurchaseOrderDto,
  UpdateShipmentDto,
} from './dto/customer-jobs.dto';
import { CreateCustomerNoteDto, CreateCustomerTaskDto, UpdateCustomerTaskDto } from './dto/customer-workspace.dto';
import { Permission } from '../common/permissions/permission.decorator';

// The Job board of the Customers page: quotations the team decided to produce.
// Same audience as the page itself; every call is scoped to the caller's
// organization, and every mutating call is recorded by the global
// AuditInterceptor. Paths are written in full so "customer-jobs" never meets
// the Customers controller's ":id".
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin', 'manager')
@Feature('inquiries')
@Permission('job_board')
@Controller()
export class CustomerJobsController {
  constructor(
    private jobs: CustomerJobsService,
    private documents: CustomerJobDocumentsService,
  ) {}

  // Hoops-parity Job actions — real PDF generation over the job's own data
  // (see customer-job-documents.service.ts). A literal, closed set of
  // static segments under :jobId, same "never collides with a dynamic
  // :something" reasoning as 'workspace' above.
  private static readonly DOCUMENT_KINDS: JobDocumentKind[] = ['job-sheet', 'proof-sheet', 'packing-slip', 'decorator-spec-sheet', 'shipping-label'];

  @Get('customer-jobs/:jobId/documents/:kind')
  async document(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('kind') kind: string, @Res() res: Response) {
    if (!CustomerJobsController.DOCUMENT_KINDS.includes(kind as JobDocumentKind)) {
      res.status(404).send({ statusCode: 404, message: 'Unknown document kind' });
      return;
    }
    const { buffer, filename } = await this.documents.generate(user, jobId, kind as JobDocumentKind);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  }

  // "Convert to job" on one of a customer's quotations. Asking twice returns the same job.
  @Post('customers/:id/jobs')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  convert(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: ConvertQuotationDto) {
    return this.jobs.convert(user, id, dto.quotationId);
  }

  @Get('customer-jobs')
  list(
    @CurrentUser() user: JwtPayload,
    @Query('view') view?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('direction') direction?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('owner') owner?: string,
    @Query('customerId') customerId?: string,
    @Query('quotationId') quotationId?: string,
    @Query('productionHouseVendorId') productionHouseVendorId?: string,
    @Query('voided') voided?: 'only' | 'include',
    @Query('decorationId') decorationId?: string,
    @Query('vendorId') vendorId?: string,
    @Query('xeroLinked') xeroLinked?: 'only' | 'unlinked',
    @Query('hasReference') hasReference?: 'only' | 'missing',
    @Query('production') production?: string,
    @Query('payment') payment?: string,
    @Query('purchasing') purchasing?: string,
    @Query('orderType') orderType?: string,
    @Query('artwork') artwork?: string,
    @Query('orderStatus') orderStatus?: string,
    @Query('progress') progress?: string,
    @Query('prodReady') prodReady?: string,
  ) {
    return this.jobs.list(user.organizationId, {
      ...{
        view,
        search,
        sort,
        direction,
        page: Number(page),
        pageSize: Number(pageSize),
        owner,
        customerId,
        quotationId,
        productionHouseVendorId,
        voided,
        decorationId,
        vendorId,
        xeroLinked,
        hasReference,
      },
      statuses: { production, payment, purchasing, orderType, artwork, orderStatus, progress, prodReady },
    });
  }

  @Get('customer-jobs/:jobId')
  detail(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string) {
    return this.jobs.detail(user, jobId);
  }

  @Get('customer-jobs/:jobId/xero-invoice')
  xeroInvoice(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string) {
    return this.jobs.getXeroInvoiceStatus(user, jobId);
  }

  @Patch('customer-jobs/:jobId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  update(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Body() dto: UpdateJobDto) {
    return this.jobs.update(user, jobId, dto);
  }

  // One of the eight statuses — or back to not set (status null).
  @Patch('customer-jobs/:jobId/status')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  setStatus(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Body() dto: SetJobStatusDto) {
    return this.jobs.setStatus(user, jobId, dto.key, dto.status ?? null, dto.proofFileId);
  }

  @Patch('customer-jobs/:jobId/items/:index')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  setItemStatus(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('index', ParseIntPipe) index: number, @Body() dto: SetJobItemStatusDto) {
    return this.jobs.setItemStatus(user, jobId, index, dto.status);
  }

  // Owners and administrators only (checked in the service).
  @Delete('customer-jobs/:jobId')
  async remove(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string) {
    await this.jobs.remove(user, jobId);
    return { status: 'ok' };
  }

  // "Void" — owners and administrators only (checked in the service). A
  // soft cancel, distinct from the hard delete above.
  @Patch('customer-jobs/:jobId/void')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  setVoided(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Body() dto: SetJobVoidedDto) {
    return this.jobs.setVoided(user, jobId, dto.voided, dto.reason);
  }

  // ---- reference attachment -----------------------------------------------------------

  @Post('customer-jobs/:jobId/reference')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  setReferenceFile(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @UploadedFile() file: Express.Multer.File) {
    return this.jobs.setReferenceFile(user, jobId, file);
  }

  @Get('customer-jobs/:jobId/reference')
  async getReferenceFile(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Res() res: Response) {
    const { stream, filename, mimeType } = await this.jobs.getReferenceFileStream(user.organizationId, jobId);
    res.set({ 'Content-Type': mimeType, 'Content-Disposition': `inline; filename="${filename}"` });
    stream.pipe(res);
  }

  // ---- purchase orders ----------------------------------------------------------------

  @Post('customer-jobs/:jobId/purchase-orders')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  addPurchaseOrder(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Body() dto: CreatePurchaseOrderDto) {
    return this.jobs.addPurchaseOrder(user, jobId, dto);
  }

  @Patch('customer-jobs/:jobId/purchase-orders/:orderId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  updatePurchaseOrder(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('orderId') orderId: string, @Body() dto: UpdatePurchaseOrderDto) {
    return this.jobs.updatePurchaseOrder(user, jobId, orderId, dto);
  }

  @Delete('customer-jobs/:jobId/purchase-orders/:orderId')
  removePurchaseOrder(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('orderId') orderId: string) {
    return this.jobs.removePurchaseOrder(user, jobId, orderId);
  }

  // ---- shipping -----------------------------------------------------------------------

  @Post('customer-jobs/:jobId/shipments')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  addShipment(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Body() dto: CreateShipmentDto) {
    return this.jobs.addShipment(user, jobId, dto);
  }

  @Patch('customer-jobs/:jobId/shipments/:shipmentId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  updateShipment(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('shipmentId') shipmentId: string, @Body() dto: UpdateShipmentDto) {
    return this.jobs.updateShipment(user, jobId, shipmentId, dto);
  }

  @Delete('customer-jobs/:jobId/shipments/:shipmentId')
  removeShipment(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('shipmentId') shipmentId: string) {
    return this.jobs.removeShipment(user, jobId, shipmentId);
  }

  // ---- credits ------------------------------------------------------------------------

  @Post('customer-jobs/:jobId/credits')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  addCredit(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Body() dto: CreateCreditDto) {
    return this.jobs.addCredit(user, jobId, dto);
  }

  @Patch('customer-jobs/:jobId/credits/:creditId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  updateCredit(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('creditId') creditId: string, @Body() dto: UpdateCreditDto) {
    return this.jobs.updateCredit(user, jobId, creditId, dto);
  }

  @Delete('customer-jobs/:jobId/credits/:creditId')
  removeCredit(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('creditId') creditId: string) {
    return this.jobs.removeCredit(user, jobId, creditId);
  }

  // ---- comments, tasks, files, proofs: the customer's own, tagged with the job ----------

  @Get('customer-jobs/:jobId/workspace')
  workspace(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string) {
    return this.jobs.workspaceOf(user, jobId);
  }

  @Post('customer-jobs/:jobId/notes')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  addNote(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Body() dto: CreateCustomerNoteDto) {
    return this.jobs.addNote(user, jobId, dto.body);
  }

  @Delete('customer-jobs/:jobId/notes/:noteId')
  async removeNote(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('noteId') noteId: string) {
    await this.jobs.removeNote(user, jobId, noteId);
    return { status: 'ok' };
  }

  @Post('customer-jobs/:jobId/tasks')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  addTask(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Body() dto: CreateCustomerTaskDto) {
    return this.jobs.addTask(user, jobId, dto);
  }

  @Patch('customer-jobs/:jobId/tasks/:taskId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  updateTask(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('taskId') taskId: string, @Body() dto: UpdateCustomerTaskDto) {
    return this.jobs.updateTask(user, jobId, taskId, dto);
  }

  @Delete('customer-jobs/:jobId/tasks/:taskId')
  async removeTask(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('taskId') taskId: string) {
    await this.jobs.removeTask(user, jobId, taskId);
    return { status: 'ok' };
  }

  @Post('customer-jobs/:jobId/files')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  addFile(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @UploadedFile() file: Express.Multer.File) {
    return this.jobs.addFile(user, jobId, file);
  }

  // An artwork proof: a file of the job that waits for approval.
  @Post('customer-jobs/:jobId/proofs')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  addProof(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @UploadedFile() file: Express.Multer.File) {
    return this.jobs.addFile(user, jobId, file, 'proof');
  }

  @Patch('customer-jobs/:jobId/proofs/:fileId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  setProof(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('fileId') fileId: string, @Body() dto: SetProofDto) {
    return this.jobs.setProof(user, jobId, fileId, dto.status, dto.note);
  }

  @Post('customer-jobs/:jobId/proofs/:fileId/send')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  sendProof(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('fileId') fileId: string) {
    return this.jobs.sendProof(user, jobId, fileId);
  }

  // Files and proofs alike. Always a download, never shown in the page: the browser saves it rather than running it.
  @Get('customer-jobs/:jobId/files/:fileId')
  async openFile(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const { stream, file } = await this.jobs.openFile(user, jobId, fileId);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff',
    });
    stream.pipe(res);
  }

  @Delete('customer-jobs/:jobId/files/:fileId')
  async removeFile(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string, @Param('fileId') fileId: string) {
    await this.jobs.removeFile(user, jobId, fileId);
    return { status: 'ok' };
  }
}

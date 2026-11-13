import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { PermissionExempt } from '../common/permissions/permission.decorator';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { SetAdminApiKeyDto } from './dto/set-admin-api-key.dto';
import { UpsertProviderAccountDto } from './dto/upsert-provider-account.dto';
import { ProviderAlertService } from './provider-alert.service';
import { ProviderPaymentGridFsService } from './provider-payment-gridfs.service';
import { ListPaymentsFilters, ProviderFinanceService } from './provider-finance.service';

function parseDays(raw?: string): number {
  const n = parseInt(raw ?? '30', 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, 3650);
}

function parsePage(raw: string | undefined, fallback: number, max: number): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

// Platform-admin-only — same AdminJwtAuthGuard + @PermissionExempt('platform')
// tier as every other admin route built this session (ai-usage-hierarchy,
// langfuse-admin). No admin-identity decorator is used for "recordedByAdmin"
// fields (see langfuse-admin.controller.ts's own comment on why:
// AdminJwtAuthGuard's req.user is an AdminAccount, not a JwtPayload — none of
// the existing admin-integrations routes read it either) — recorded as
// 'platform-admin' generically; a real per-admin id can be threaded through
// later if the admin auth guard ever exposes one.
@UseGuards(AdminJwtAuthGuard)
@PermissionExempt('platform')
@Controller('provider-finance/admin')
export class ProviderFinanceController {
  constructor(
    private service: ProviderFinanceService,
    private gridFs: ProviderPaymentGridFsService,
    private alerts: ProviderAlertService,
  ) {}

  @Get('dashboard')
  dashboard(@Query('days') days?: string) {
    return this.service.getFinanceDashboard(parseDays(days));
  }

  @Get('profitability')
  profitability(@Query('days') days?: string) {
    return this.service.getProfitability(parseDays(days));
  }

  @Get('alerts')
  recentAlerts(@Query('limit') limit?: string) {
    return this.alerts.listRecentAlerts(parsePage(limit, 20, 200));
  }

  @Get('accounts')
  accounts() {
    return this.service.getAccounts();
  }

  @Get('accounts/:provider')
  account(@Param('provider') provider: string) {
    return this.service.getAccount(provider);
  }

  @Patch('accounts/:provider')
  upsertAccount(@Param('provider') provider: string, @Body() dto: UpsertProviderAccountDto) {
    return this.service.upsertAccount(provider, dto);
  }

  @Post('accounts/:provider/admin-api-key')
  setAdminApiKey(@Param('provider') provider: string, @Body() dto: SetAdminApiKeyDto) {
    return this.service.setAdminApiKey(provider, dto.adminApiKey);
  }

  @Delete('accounts/:provider/admin-api-key')
  clearAdminApiKey(@Param('provider') provider: string) {
    return this.service.clearAdminApiKey(provider);
  }

  @Get('payments')
  payments(
    @Query('provider') provider?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('status') status?: 'recorded' | 'confirmed' | 'disputed',
    @Query('currency') currency?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const filters: ListPaymentsFilters = {
      provider,
      dateFrom,
      dateTo,
      status,
      currency,
      page: parsePage(page, 1, 100_000),
      pageSize: parsePage(pageSize, 25, 100),
    };
    return this.service.listPayments(filters);
  }

  @Post('payments')
  async recordPayment(@Body() dto: RecordPaymentDto) {
    const payment = await this.service.recordPayment(dto, 'platform-admin');
    // Best-effort — a notification failure must never fail the payment
    // record itself (same "observability never breaks the real operation"
    // rule this session's Python side already follows).
    this.alerts.notifyPaymentRecorded(dto.provider, dto.amount, dto.currency ?? 'USD').catch(() => undefined);
    return payment;
  }

  @Get('payments/totals')
  paymentTotals(@Query('by') by?: 'provider' | 'month' | 'year') {
    return this.service.getPaymentTotals(by ?? 'provider');
  }

  @Post('payments/:id/receipt')
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  async uploadReceipt(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    const fileId = await this.gridFs.upload(file.originalname, file.buffer, { paymentId: id });
    return this.service.attachReceipt(id, fileId, file.originalname, file.mimetype);
  }

  @Get('payments/:id/receipt')
  async downloadReceipt(@Param('id') id: string, @Res() res: Response) {
    const { fileId, filename, mimeType } = await this.service.getPaymentReceipt(id);
    res.set({ 'Content-Type': mimeType, 'Content-Disposition': `inline; filename="${filename}"` });
    this.gridFs.openDownloadStream(fileId).pipe(res);
  }
}
